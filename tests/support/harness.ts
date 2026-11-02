import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as util from 'util';
import { StorageConfig, StorageDisk, StorageModule, StorageModuleOptions, StorageService } from '../../lib';
import { isSelected } from './selection';

export type BackendName = 'fileSystem' | 's3' | 'memory' | 'ftp' | 'sftp';

export const S3_ENDPOINT = process.env.S3_TEST_RESOLVED_ENDPOINT || '';
export const S3_BUCKET = 'test';

/** The FTP server of the e2e run (see global setup); `host` is '' when there is none. `dir` is relative to the login directory. */
export const FTP_SERVER = {
  host: process.env.FTP_TEST_RESOLVED_HOST || '',
  port: Number(process.env.FTP_TEST_RESOLVED_PORT || 21),
  username: process.env.FTP_TEST_RESOLVED_USERNAME || '',
  password: process.env.FTP_TEST_RESOLVED_PASSWORD || '',
  dir: process.env.FTP_TEST_RESOLVED_DIR || '',
};

/** The SFTP server of the e2e run; `host` is '' when there is none. `hostKey` is its `SHA256:<base64>` fingerprint, `dir` a writable directory. */
export const SFTP_SERVER = {
  host: process.env.SFTP_TEST_RESOLVED_HOST || '',
  port: Number(process.env.SFTP_TEST_RESOLVED_PORT || 22),
  username: process.env.SFTP_TEST_RESOLVED_USERNAME || '',
  password: process.env.SFTP_TEST_RESOLVED_PASSWORD || '',
  hostKey: process.env.SFTP_TEST_RESOLVED_HOST_KEY || '',
  dir: process.env.SFTP_TEST_RESOLVED_DIR || '/upload',
  /** Private key files the test user can log in with (`''` when there are none); the encrypted one needs `keyPassphrase` */
  keyPath: process.env.SFTP_TEST_RESOLVED_KEY_PATH || '',
  encryptedKeyPath: process.env.SFTP_TEST_RESOLVED_ENCRYPTED_KEY_PATH || '',
  keyPassphrase: process.env.SFTP_TEST_RESOLVED_KEY_PASSPHRASE || '',
};

export interface Backend {
  name: BackendName;
  isS3: boolean;
  enabled: boolean;
}

export const FS_BACKEND: Backend = { name: 'fileSystem', isS3: false, enabled: isSelected('fileSystem') };
/** In-memory (memfs) backend: needs no Docker or credentials */
export const MEMORY_BACKEND: Backend = { name: 'memory', isS3: false, enabled: isSelected('memory') };

export const S3_BACKEND: Backend = { name: 's3', isS3: true, enabled: isSelected('s3') && !!S3_ENDPOINT };
export const FTP_BACKEND: Backend = { name: 'ftp', isS3: false, enabled: isSelected('ftp') && !!FTP_SERVER.host };
export const SFTP_BACKEND: Backend = { name: 'sftp', isS3: false, enabled: isSelected('sftp') && !!SFTP_SERVER.host };

/** The backends the shared behaviour suites run against (all, or those of E2E_BACKENDS). */
export const SHARED_BACKENDS: Backend[] = [FS_BACKEND, MEMORY_BACKEND, S3_BACKEND, FTP_BACKEND, SFTP_BACKEND];

/** Runs `define` once per shared backend (describe.each). A backend without a service is registered as skipped. */
export function describeBackends(title: string, define: (backend: Backend) => void) {
  const enabled = SHARED_BACKENDS.filter((backend) => backend.enabled);
  if (enabled.length > 0) describe.each(enabled)(`${title} [$name]`, (backend) => define(backend));
  for (const backend of SHARED_BACKENDS.filter((b) => !b.enabled && isSelected(b.name))) {
    describe.skip(`${title} [${backend.name}] (no ${backend.name} service, see global setup)`, () =>
      it('skipped', () => undefined));
  }
}

/**
 * `describe` for the suites of one backend: skipped (and reported as such) when its service is missing or the backend
 * is not among the E2E_BACKENDS. A file that is only a re-run of other suites (disks-parity) sets E2E_OMIT_UNSELECTED
 * to leave the suites of unselected backends out instead (a file without any test would fail, so others do not).
 */
const OMIT_UNSELECTED = process.env.E2E_OMIT_UNSELECTED === '1';

function serviceSuite(backend: Backend): typeof describe {
  if (!isSelected(backend.name)) {
    return OMIT_UNSELECTED ? ((() => undefined) as unknown as typeof describe) : describe.skip;
  }
  return backend.enabled ? describe : describe.skip;
}

/** Defines memory-only suites; skipped when `memory` is not among the E2E_BACKENDS. */
export const describeMemory = serviceSuite(MEMORY_BACKEND);
/** Defines S3-only suites; skipped when no S3 endpoint is available. */
export const describeS3 = serviceSuite(S3_BACKEND);
/** Defines FTP-only suites; skipped when no FTP server is available. */
export const describeFtp = serviceSuite(FTP_BACKEND);
/** Defines SFTP-only suites; skipped when no SFTP server is available. */
export const describeSftp = serviceSuite(SFTP_BACKEND);

export function s3Options(prefix: string, overrides: Partial<StorageModuleOptions> = {}): StorageModuleOptions {
  return {
    type: 's3',
    endpoint: S3_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    bucket: S3_BUCKET,
    accessKeyId: 'test',
    secretAccessKey: 'test',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    prefix,
    ...overrides,
  };
}

/** Options of an ftp disk on the test server; `prefix` is the remote base directory (relative to the login directory). */
export function ftpOptions(prefix: string, overrides: Partial<StorageModuleOptions> = {}): StorageModuleOptions {
  return {
    type: 'ftp',
    host: FTP_SERVER.host,
    port: FTP_SERVER.port,
    username: FTP_SERVER.username,
    password: FTP_SERVER.password,
    prefix,
    ...overrides,
  };
}

/** Options of an sftp disk on the test server (host key verified); `prefix` is the absolute remote base directory. */
export function sftpOptions(prefix: string, overrides: Partial<StorageModuleOptions> = {}): StorageModuleOptions {
  return {
    type: 'sftp',
    host: SFTP_SERVER.host,
    port: SFTP_SERVER.port,
    username: SFTP_SERVER.username,
    password: SFTP_SERVER.password,
    hostKey: SFTP_SERVER.hostKey,
    prefix,
    ...overrides,
  };
}

let viaNamedDisk = false;
/**
 * Makes `createCtx` run every context through a named disk of a multi-disk module (`ctx.service` is then
 * `storage.disk('named')`, the default disk being an unrelated memory disk): lets the behaviour suites be reused
 * to prove that `StorageDisk` delegates the whole file API. Applies to this test file only (jest isolates modules).
 */
export function useNamedDisk(enabled = true) {
  viaNamedDisk = enabled;
}

export interface Ctx {
  backend: Backend;
  /** The service, or (see `useNamedDisk`) a named disk: both have the whole file API */
  service: StorageDisk;
  moduleRef: TestingModule;
  /** Prefix of this test: the tmp dir (fileSystem), the in-memory root (memory), the S3 key prefix or the remote directory (ftp, sftp) */
  prefix: string;
  /** The `path` Node-style errors carry for the given relative path */
  errPath(p: string): string;
  close(): Promise<void>;
}

/**
 * Creates an isolated StorageService through a real Nest testing module: a fresh tmp dir for the filesystem,
 * a unique key prefix for S3.
 */
export async function createCtx(
  backend: Backend,
  label: string,
  opts: { overrides?: Partial<StorageModuleOptions>; async?: boolean } = {},
): Promise<Ctx> {
  const slug = label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
  const memory = backend.name === 'memory';
  const remote = backend.name === 'ftp' || backend.name === 'sftp';
  const unique = `${slug}-${randomUUID().slice(0, 8)}`;
  const prefix = backend.isS3
    ? `e2e/${unique}`
    : memory
    ? `/e2e/${unique}`
    : backend.name === 'ftp'
    ? path.posix.join(FTP_SERVER.dir, 'e2e', unique)
    : backend.name === 'sftp'
    ? path.posix.join(SFTP_SERVER.dir, 'e2e', unique)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'nestjs-multi-storage-e2e-'));
  const options: StorageModuleOptions = backend.isS3
    ? s3Options(prefix, opts.overrides)
    : backend.name === 'ftp'
    ? ftpOptions(prefix, opts.overrides)
    : backend.name === 'sftp'
    ? sftpOptions(prefix, opts.overrides)
    : { type: memory ? 'memory' : 'fileSystem', prefix, ...opts.overrides };

  const config: StorageConfig = viaNamedDisk
    ? { default: 'main', disks: { main: { type: 'memory' }, named: options } }
    : options;
  const moduleRef = await Test.createTestingModule({
    imports: [
      opts.async ? StorageModule.forRootAsync({ useFactory: async () => config }) : StorageModule.forRoot(config),
    ],
  }).compile();
  await moduleRef.init();
  const storage = moduleRef.get(StorageService);
  const service = viaNamedDisk ? storage.disk('named') : storage;
  // Like the filesystem, a remote prefix must exist: create it (and its parents) for the test
  if (remote) await service.mkdir('');

  return {
    backend,
    service,
    moduleRef,
    prefix,
    errPath: (p) => (backend.isS3 ? p : remote ? path.posix.join(prefix, p) : path.join(prefix, p)),
    async close() {
      if (backend.isS3 || remote) {
        await service.rmdir('').catch(() => undefined);
      }
      await moduleRef.close();
      if (backend.name === 'fileSystem') {
        fs.rmSync(prefix, { recursive: true, force: true });
      }
    },
  };
}

/** Registers beforeEach/afterEach that hand every test its own Ctx. */
export function useCtx(backend: Backend, label: string, opts: Parameters<typeof createCtx>[2] = {}) {
  const holder = {} as { ctx: Ctx };
  beforeEach(async () => {
    holder.ctx = await createCtx(backend, `${label}-${expect.getState().currentTestName ?? ''}`, opts);
  });
  afterEach(async () => {
    await holder.ctx.close();
  });
  return holder;
}

export async function expectFsError(
  promise: Promise<unknown>,
  expected: { code: string; errno?: number; syscall: string; path?: string; dest?: string },
) {
  const error: any = await promise.then(
    () => undefined,
    (e) => e,
  );
  expect(util.types.isNativeError(error)).toBe(true);
  expect(error.code).toBe(expected.code);
  expect(error.syscall).toBe(expected.syscall);
  if (expected.errno !== undefined) expect(error.errno).toBe(expected.errno);
  if (expected.path !== undefined) expect(error.path).toBe(expected.path);
  if (expected.dest !== undefined) expect(error.dest).toBe(expected.dest);
  if (!expected.code.startsWith('ERR_')) expect(error.message).toContain(expected.code);
  return error;
}

export async function collect(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** Raw S3 keys below `Prefix` (all pages), bypassing the service. */
export async function rawKeys(service: StorageDisk, Prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let ContinuationToken: string | undefined;
  do {
    const out = await service.s3client!.send(
      new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix, ContinuationToken }),
    );
    keys.push(...(out.Contents ?? []).map((c) => c.Key!));
    ContinuationToken = out.NextContinuationToken;
  } while (ContinuationToken);
  return keys.sort();
}

/** The S3 driver behind a service (S3 backend only), for tests that tweak its private settings. */
export function s3Internals(service: StorageDisk): any {
  return (service as any).driver;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
