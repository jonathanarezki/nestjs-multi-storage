import { Client as FtpClient } from 'basic-ftp';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import { createConnection, createServer } from 'net';
import * as os from 'os';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import { generateEd25519 } from './keys';
import { isSelected } from './selection';

/**
 * Resolves the services used by the e2e suites: S3 (adobe/s3mock), FTP (delfer/alpine-ftp-server) and SFTP (atmoz/sftp).
 * Each is published to the tests through env vars; an empty host / endpoint means: skip the suites of that service.
 *
 * 1. External services, when configured, are used as is (nothing is started or stopped):
 *    - S3_TEST_ENDPOINT                      -> S3_TEST_RESOLVED_ENDPOINT
 *    - FTP_TEST_HOST (+ _PORT, _USERNAME, _PASSWORD, _DIR)
 *                                            -> FTP_TEST_RESOLVED_HOST / _PORT / _USERNAME / _PASSWORD / _DIR
 *    - SFTP_TEST_HOST (+ _PORT, _USERNAME, _PASSWORD, _HOST_KEY, _DIR)
 *                                            -> SFTP_TEST_RESOLVED_HOST / _PORT / _USERNAME / _PASSWORD / _HOST_KEY / _DIR
 *      `_DIR` is a writable base directory on the server (FTP: relative to the login directory, default: the login
 *      directory itself; SFTP: default `/upload`). `SFTP_TEST_HOST_KEY` is mandatory: the `SHA256:<base64>` fingerprint
 *      of the server's host key, as printed by `ssh-keygen -lf`.
 *    - SFTP_TEST_KEY_PATH, SFTP_TEST_ENCRYPTED_KEY_PATH + SFTP_TEST_KEY_PASSPHRASE (optional)
 *                                            -> SFTP_TEST_RESOLVED_KEY_PATH / _ENCRYPTED_KEY_PATH / _KEY_PASSPHRASE
 *      Private key files the test user can log in with (the second one protected by the passphrase). The key
 *      suites are skipped for the ones that are not given.
 * 2. Otherwise a container per service is started on free ports and removed again in global-teardown.
 *    FTP passive mode: the data connections use a published port range that is the same inside and outside the
 *    container (MIN_PORT/MAX_PORT), and the server announces 127.0.0.1 (ADDRESS). The FTP server counts as ready once
 *    a login and passive-mode transfers succeed (not merely a TCP greeting).
 *    SFTP keys: a fresh ed25519 key pair (plain) and one protected by a passphrase are generated into a temp dir
 *    (SFTP_TEST_KEYS_DIR, removed in global-teardown); their public keys are authorized for the test user.
 * 3. Without Docker the suites of a service are skipped with a console message, unless REQUIRE_S3_TESTS is '1' or
 *    'true': then global setup throws instead (used by the release workflow so it never publishes untested).
 *    The flag covers S3, FTP and SFTP.
 */

const STARTUP_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 150;
const FTP_PASSIVE_PORTS = 20;
const TEST_USER = 'test';
const TEST_PASSWORD = 'test';

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, () => server.close(() => resolve(true)));
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

/** A free port that is not in `[from, from + count)` (the kernel may hand out a port of a range we reserved). */
async function freePortOutside(from: number, count: number): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await freePort();
    if (port < from || port >= from + count) return port;
  }
  throw new Error('no free port outside the passive range found');
}

/** The lowest port the kernel hands out to outgoing connections (Linux default: 32768). */
function ephemeralPortsStart(): number {
  try {
    return Number(fs.readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').split(/\s+/)[0]) || 32_768;
  } catch {
    return 32_768;
  }
}

/**
 * The first port of `count` consecutive free ports (the FTP passive range). The range lies below the ephemeral
 * ports: those are taken by any outgoing connection of the machine, which would otherwise grab a port of the range
 * between this check and the container's port binding.
 */
async function freePortRange(count: number): Promise<number> {
  const lowest = 10_000;
  const highest = ephemeralPortsStart() - count;
  for (let attempt = 0; attempt < 50; attempt++) {
    const start = lowest + Math.floor(Math.random() * (highest - lowest));
    const free = await Promise.all(Array.from({ length: count }, (_, i) => portIsFree(start + i)));
    if (free.every(Boolean)) return start;
  }
  throw new Error(`no range of ${count} free ports found`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(what: string, check: () => Promise<unknown>): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await check();
      return;
    } catch (e) {
      if (e instanceof ContainerExited) throw e;
      lastError = e;
      await sleep(POLL_INTERVAL_MS);
    }
  }
  throw new Error(`${what} did not become ready within ${STARTUP_TIMEOUT_MS}ms: ${lastError}`);
}

/** Resolves when the server sends a first line starting with `greeting` (FTP: `220`, SSH: `SSH-`). */
function waitForGreeting(port: number, greeting: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.setTimeout(2000, () => socket.destroy(new Error('timeout')));
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('connection closed without greeting')));
    socket.once('data', (data) => {
      socket.destroy();
      if (data.toString().startsWith(greeting)) resolve();
      else reject(new Error(`unexpected greeting: ${data.toString().slice(0, 40)}`));
    });
  });
}

/**
 * Resolves once the entrypoint of delfer/alpine-ftp-server has recorded the vsftpd master process, without touching
 * the FTP port. The entrypoint starts vsftpd as a daemon, then writes the pid of the LAST `pgrep vsftpd` match into
 * a pid file that its supervisor (pidproxy) watches; when that process ends, the container exits. That is racy: on a
 * loaded machine (about a third of the starts at 48 busy loops) the pid written belongs to a vsftpd process that is
 * about to end (not the master, or one of a client's session processes), pidproxy logs "process has died, quitting"
 * and the container exits (seen as "FTP container never became ready"). startContainer notices the exit and starts a
 * new container.
 */
async function waitForVsftpdMaster(id: string): Promise<void> {
  const pidFile = '/var/run/vsftpd/vsftpd.pid';
  // The master was reparented to the container's init (pid 1), a session process has the master as its parent
  const script = `p=$(cat ${pidFile}) && [ -n "$p" ] && [ "$(cut -d' ' -f4 /proc/$p/stat)" = 1 ]`;
  execFileSync('docker', ['exec', id, 'sh', '-c', script], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 10_000 });
}

/**
 * Resolves once the FTP server accepts a login and passive-mode data transfers (upload, listing, download, delete):
 * the TCP greeting alone comes earlier than the server can serve data connections.
 */
async function waitForFtpTransfer(host: string, port: number, user: string, password: string): Promise<void> {
  const client = new FtpClient(5000);
  try {
    await client.access({ host, port, user, password });
    for (let i = 0; i < 5; i++) {
      const name = `.ready-${process.pid}-${i}`;
      await client.uploadFrom(Readable.from([Buffer.from('ready')]), name);
      await client.list();
      const chunks: Buffer[] = [];
      await client.downloadTo(
        new Writable({
          write(chunk, _encoding, callback) {
            chunks.push(chunk);
            callback();
          },
        }),
        name,
      );
      await client.remove(name);
      if (Buffer.concat(chunks).toString() !== 'ready') throw new Error('unexpected data in the readiness transfer');
    }
  } finally {
    client.close();
  }
}

function testsRequired(): boolean {
  return ['1', 'true'].includes(process.env.REQUIRE_S3_TESTS ?? '');
}

function skipOrThrow(service: string, reason: string) {
  if (testsRequired()) {
    throw new Error(`${service} tests are required (REQUIRE_S3_TESTS) but ${service} could not be started: ${reason}`);
  }
  console.warn(`[e2e] SKIPPING the ${service} suites: ${reason}`);
}

/** State, processes and the last log lines of a container that did not become ready (for the failure message). */
function diagnose(id: string): string {
  const run = (args: string[]) => {
    try {
      return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 });
    } catch (e) {
      return `(${(e as Error).message.split('\n')[0]})`;
    }
  };
  return [
    `container: ${run(['inspect', '-f', '{{.State.Status}} exit={{.State.ExitCode}}', id]).trim()}`,
    `processes:\n${run(['top', id, '-o', 'pid,ppid,args'])}`,
    `logs:\n${run(['logs', '--tail', '20', id])}`,
  ].join('\n');
}

function removeContainer(id: string) {
  try {
    execFileSync('docker', ['rm', '-f', id], { stdio: 'ignore' });
  } catch {
    // already gone
  }
}

function dockerRun(args: string[]): string {
  return execFileSync('docker', ['run', '-d', '--rm', ...args], { encoding: 'utf8', timeout: 300_000 }).trim();
}

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

/** Thrown by a readiness check when the container is gone: waiting longer is pointless, a new container is needed. */
class ContainerExited extends Error {}

function containerIsRunning(id: string): boolean {
  try {
    return (
      execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', id], {
        encoding: 'utf8',
        stdio: 'pipe',
      }).trim() === 'true'
    );
  } catch {
    return false; // removed (the containers run with --rm, so an exited one is gone)
  }
}

const START_ATTEMPTS = 3;

/**
 * Starts a container with `start`, waits until `ready` succeeds, then lets `publish` set the env vars.
 * A container that exits by itself while starting (the FTP image does that sporadically, see waitForVsftpdMaster) is
 * replaced by a new one, up to START_ATTEMPTS times. On any other failure the container is removed and the suites of
 * `service` are skipped (or setup throws, see above).
 */
async function startContainer(
  service: string,
  containerEnv: string,
  start: () => string | Promise<string>,
  ready: (id: string) => Promise<unknown>,
  publish: (id: string) => void,
) {
  for (let attempt = 1; ; attempt++) {
    let id: string;
    try {
      id = await start();
    } catch (e) {
      skipOrThrow(service, `the container failed to start.\n${(e as Error).message.split('\n')[0]}`);
      return;
    }
    process.env[containerEnv] = id;
    // Safety net in case Jest is killed before global-teardown runs
    process.on('exit', () => removeContainer(id));
    try {
      await waitUntil(service, async () => {
        if (!containerIsRunning(id)) throw new ContainerExited(`the ${service} container exited while starting`);
        await ready(id);
      });
      publish(id);
      return;
    } catch (e) {
      const diagnostics = diagnose(id);
      removeContainer(id);
      delete process.env[containerEnv];
      if (e instanceof ContainerExited && attempt < START_ATTEMPTS) {
        console.warn(`[e2e] ${(e as Error).message} (attempt ${attempt} of ${START_ATTEMPTS}), starting a new one`);
        continue;
      }
      skipOrThrow(service, `${(e as Error).message}\n${diagnostics}`);
      return;
    }
  }
}

function clearS3() {
  process.env.S3_TEST_RESOLVED_ENDPOINT = '';
  delete process.env.S3_TEST_CONTAINER_ID;
}

async function setupS3(docker: boolean) {
  clearS3();

  const external = process.env.S3_TEST_ENDPOINT;
  if (external) {
    process.env.S3_TEST_RESOLVED_ENDPOINT = external;
    console.log(`[e2e] Using S3 endpoint from S3_TEST_ENDPOINT: ${external}`);
    return;
  }
  if (!docker) {
    return skipOrThrow('S3', 'Docker is unavailable and S3_TEST_ENDPOINT is not set.');
  }
  const port = await freePort();
  await startContainer(
    'S3',
    'S3_TEST_CONTAINER_ID',
    () =>
      dockerRun([
        '-p',
        `${port}:9090`,
        '-e',
        'COM_ADOBE_TESTING_S3MOCK_STORE_INITIAL_BUCKETS=test',
        'adobe/s3mock:latest',
      ]),
    () => fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }),
    (id) => {
      process.env.S3_TEST_RESOLVED_ENDPOINT = `http://127.0.0.1:${port}`;
      console.log(`[e2e] Started adobe/s3mock (${id.slice(0, 12)}) at ${process.env.S3_TEST_RESOLVED_ENDPOINT}`);
    },
  );
}

function clearFtp() {
  for (const key of ['HOST', 'PORT', 'USERNAME', 'PASSWORD', 'DIR']) process.env[`FTP_TEST_RESOLVED_${key}`] = '';
  delete process.env.FTP_TEST_CONTAINER_ID;
}

async function setupFtp(docker: boolean) {
  clearFtp();

  const external = process.env.FTP_TEST_HOST;
  if (external) {
    Object.assign(process.env, {
      FTP_TEST_RESOLVED_HOST: external,
      FTP_TEST_RESOLVED_PORT: process.env.FTP_TEST_PORT || '21',
      FTP_TEST_RESOLVED_USERNAME: process.env.FTP_TEST_USERNAME || 'anonymous',
      FTP_TEST_RESOLVED_PASSWORD: process.env.FTP_TEST_PASSWORD ?? '',
      FTP_TEST_RESOLVED_DIR: process.env.FTP_TEST_DIR ?? '',
    });
    console.log(`[e2e] Using FTP server from FTP_TEST_HOST: ${external}:${process.env.FTP_TEST_RESOLVED_PORT}`);
    return;
  }
  if (!docker) {
    return skipOrThrow('FTP', 'Docker is unavailable and FTP_TEST_HOST is not set.');
  }
  let port = 0;
  let passiveFrom = 0;
  let passiveTo = 0;
  await startContainer(
    'FTP',
    'FTP_TEST_CONTAINER_ID',
    async () => {
      // Another process may take one of the ports between the check and the container's binding: pick again then
      for (let attempt = 1; ; attempt++) {
        passiveFrom = await freePortRange(FTP_PASSIVE_PORTS);
        passiveTo = passiveFrom + FTP_PASSIVE_PORTS - 1;
        port = await freePortOutside(passiveFrom, FTP_PASSIVE_PORTS);
        try {
          return dockerRun([
            '-p',
            `${port}:21`,
            // Passive data connections: the port range must be identical on both sides of the port mapping
            '-p',
            `${passiveFrom}-${passiveTo}:${passiveFrom}-${passiveTo}`,
            '-e',
            'ADDRESS=127.0.0.1',
            '-e',
            `MIN_PORT=${passiveFrom}`,
            '-e',
            `MAX_PORT=${passiveTo}`,
            '-e',
            `USERS=${TEST_USER}|${TEST_PASSWORD}`,
            'delfer/alpine-ftp-server:latest',
          ]);
        } catch (e) {
          if (attempt >= 3 || !/address already in use|port is already allocated/.test(String(e))) throw e;
        }
      }
    },
    async (id) => {
      await waitForVsftpdMaster(id);
      await waitForFtpTransfer('127.0.0.1', port, TEST_USER, TEST_PASSWORD);
    },
    (id) => {
      Object.assign(process.env, {
        FTP_TEST_RESOLVED_HOST: '127.0.0.1',
        FTP_TEST_RESOLVED_PORT: String(port),
        FTP_TEST_RESOLVED_USERNAME: TEST_USER,
        FTP_TEST_RESOLVED_PASSWORD: TEST_PASSWORD,
        FTP_TEST_RESOLVED_DIR: '',
      });
      console.log(
        `[e2e] Started delfer/alpine-ftp-server (${id.slice(
          0,
          12,
        )}) at 127.0.0.1:${port} (passive ${passiveFrom}-${passiveTo})`,
      );
    },
  );
}

/**
 * Two fresh ed25519 key pairs, one of them protected by a passphrase, in a temp dir (removed in global-teardown):
 * the private keys next to an `authorized` dir with the public keys, to be mounted into the SFTP container.
 */
function generateSftpKeys() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nestjs-multi-storage-sftp-keys-'));
  process.env.SFTP_TEST_KEYS_DIR = dir;
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  const authorizedDir = path.join(dir, 'authorized');
  fs.mkdirSync(authorizedDir);
  const passphrase = 'e2e-passphrase';
  const write = (name: string, keyPassphrase?: string) => {
    const pair = generateEd25519(keyPassphrase);
    const keyPath = path.join(dir, name);
    fs.writeFileSync(keyPath, pair.private, { mode: 0o600 });
    // The image concatenates these files into authorized_keys: each needs its own final newline
    fs.writeFileSync(path.join(authorizedDir, `${name}.pub`), `${pair.public.trim()}\n`);
    return keyPath;
  };
  return {
    authorizedDir,
    passphrase,
    keyPath: write('id_ed25519'),
    encryptedKeyPath: write('id_ed25519_encrypted', passphrase),
  };
}

function clearSftp() {
  for (const key of ['HOST', 'PORT', 'USERNAME', 'PASSWORD', 'HOST_KEY', 'DIR', 'KEY_PATH', 'ENCRYPTED_KEY_PATH']) {
    process.env[`SFTP_TEST_RESOLVED_${key}`] = '';
  }
  process.env.SFTP_TEST_RESOLVED_KEY_PASSPHRASE = '';
  delete process.env.SFTP_TEST_CONTAINER_ID;
  delete process.env.SFTP_TEST_KEYS_DIR;
}

async function setupSftp(docker: boolean) {
  clearSftp();

  const external = process.env.SFTP_TEST_HOST;
  if (external) {
    const hostKey = process.env.SFTP_TEST_HOST_KEY;
    if (!hostKey) {
      throw new Error('SFTP_TEST_HOST is set but SFTP_TEST_HOST_KEY (the SHA256:<base64> host key fingerprint) is not');
    }
    Object.assign(process.env, {
      SFTP_TEST_RESOLVED_HOST: external,
      SFTP_TEST_RESOLVED_PORT: process.env.SFTP_TEST_PORT || '22',
      SFTP_TEST_RESOLVED_USERNAME: process.env.SFTP_TEST_USERNAME ?? TEST_USER,
      SFTP_TEST_RESOLVED_PASSWORD: process.env.SFTP_TEST_PASSWORD ?? TEST_PASSWORD,
      SFTP_TEST_RESOLVED_HOST_KEY: hostKey,
      SFTP_TEST_RESOLVED_DIR: process.env.SFTP_TEST_DIR || '/upload',
      SFTP_TEST_RESOLVED_KEY_PATH: process.env.SFTP_TEST_KEY_PATH ?? '',
      SFTP_TEST_RESOLVED_ENCRYPTED_KEY_PATH: process.env.SFTP_TEST_ENCRYPTED_KEY_PATH ?? '',
      SFTP_TEST_RESOLVED_KEY_PASSPHRASE: process.env.SFTP_TEST_KEY_PASSPHRASE ?? '',
    });
    console.log(`[e2e] Using SFTP server from SFTP_TEST_HOST: ${external}:${process.env.SFTP_TEST_RESOLVED_PORT}`);
    return;
  }
  if (!docker) {
    return skipOrThrow('SFTP', 'Docker is unavailable and SFTP_TEST_HOST is not set.');
  }
  const port = await freePort();
  const keys = generateSftpKeys();
  await startContainer(
    'SFTP',
    'SFTP_TEST_CONTAINER_ID',
    // The user is chrooted into /home/test, where only /upload is writable. The public keys in .ssh/keys are
    // added to the user's authorized_keys by the image.
    () =>
      dockerRun([
        '-p',
        `${port}:22`,
        '-v',
        `${keys.authorizedDir}:/home/${TEST_USER}/.ssh/keys:ro`,
        'atmoz/sftp:latest',
        `${TEST_USER}:${TEST_PASSWORD}:::upload`,
      ]),
    () => waitForGreeting(port, 'SSH-'),
    (id) => {
      // `ssh-keygen -lf` prints e.g. "256 SHA256:abc... root@host (ED25519)"; the fingerprint is the second word
      const fingerprint = execFileSync(
        'docker',
        ['exec', id, 'ssh-keygen', '-lf', '/etc/ssh/ssh_host_ed25519_key.pub'],
        {
          encoding: 'utf8',
        },
      )
        .trim()
        .split(/\s+/)[1];
      Object.assign(process.env, {
        SFTP_TEST_RESOLVED_HOST: '127.0.0.1',
        SFTP_TEST_RESOLVED_PORT: String(port),
        SFTP_TEST_RESOLVED_USERNAME: TEST_USER,
        SFTP_TEST_RESOLVED_PASSWORD: TEST_PASSWORD,
        SFTP_TEST_RESOLVED_HOST_KEY: fingerprint,
        SFTP_TEST_RESOLVED_DIR: '/upload',
        SFTP_TEST_RESOLVED_KEY_PATH: keys.keyPath,
        SFTP_TEST_RESOLVED_ENCRYPTED_KEY_PATH: keys.encryptedKeyPath,
        SFTP_TEST_RESOLVED_KEY_PASSPHRASE: keys.passphrase,
      });
      console.log(`[e2e] Started atmoz/sftp (${id.slice(0, 12)}) at 127.0.0.1:${port} (host key ${fingerprint})`);
    },
  );
}

export default async function globalSetup() {
  // E2E_BACKENDS: only the services of the selected backends are started (none: no Docker is needed at all)
  const services = [
    { backend: 's3', external: process.env.S3_TEST_ENDPOINT, setup: setupS3, clear: clearS3 },
    { backend: 'ftp', external: process.env.FTP_TEST_HOST, setup: setupFtp, clear: clearFtp },
    { backend: 'sftp', external: process.env.SFTP_TEST_HOST, setup: setupSftp, clear: clearSftp },
  ] as const;
  const wanted = services.filter((service) => isSelected(service.backend));
  for (const service of services) if (!wanted.includes(service)) service.clear();
  const docker = wanted.every((service) => service.external) ? false : dockerAvailable();
  await Promise.all(wanted.map((service) => service.setup(docker)));
}
