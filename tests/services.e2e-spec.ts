import { Client as FtpClient } from 'basic-ftp';
import { createHash, randomUUID } from 'crypto';
import { Client, SFTPWrapper } from 'ssh2';
import { Readable, Writable } from 'stream';
import { describeFtp, describeSftp, FTP_SERVER, SFTP_SERVER } from './support/harness';

/** Smoke tests of the FTP and SFTP test servers with the raw client libraries (not our drivers). */

const content = Buffer.from('hello from the raw client\n');

/** The `SHA256:<base64>` fingerprint (no padding) of an SSH host key, the form `ssh-keygen -lf` prints. */
function fingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

describeFtp('FTP test server (raw basic-ftp)', () => {
  let client: FtpClient;
  let home: string;
  const dir = `${FTP_SERVER.dir}/e2e-smoke-${randomUUID().slice(0, 8)}`.replace(/^\//, '');

  beforeAll(async () => {
    client = new FtpClient(10_000);
    await client.access({
      host: FTP_SERVER.host,
      port: FTP_SERVER.port,
      user: FTP_SERVER.username,
      password: FTP_SERVER.password,
    });
    home = await client.pwd();
  });

  afterAll(async () => {
    await client.cd(home).catch(() => undefined);
    await client.removeDir(dir).catch(() => undefined);
    client.close();
  });

  it('uploads, lists, downloads and deletes a file through passive mode', async () => {
    await client.ensureDir(dir); // creates the folder (relative to the login directory) and enters it
    await client.uploadFrom(Readable.from([content]), 'a.txt');

    const listed = await client.list();
    expect(listed.map((f) => [f.name, f.size])).toEqual([['a.txt', content.length]]);

    const chunks: Buffer[] = [];
    await client.downloadTo(
      new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      }),
      'a.txt',
    );
    expect(Buffer.concat(chunks)).toEqual(content);

    await client.remove('a.txt');
    expect(await client.list()).toEqual([]);
  });
});

/** Opens an SSH connection and its SFTP channel; resolves after a failed connect with the error. */
function connectSftp(hostVerifier: (key: Buffer) => boolean): Promise<{ client: Client; sftp: SFTPWrapper }> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once('error', reject);
    client.once('ready', () => client.sftp((error, sftp) => (error ? reject(error) : resolve({ client, sftp }))));
    client.connect({
      host: SFTP_SERVER.host,
      port: SFTP_SERVER.port,
      username: SFTP_SERVER.username,
      password: SFTP_SERVER.password,
      readyTimeout: 10_000,
      hostVerifier,
    });
  });
}

/** Promisifies the ssh2 SFTP method `method`, whose callback is its last argument. */
const call = <T = void>(sftp: SFTPWrapper, method: string, ...args: unknown[]): Promise<T> =>
  new Promise((resolve, reject) =>
    (sftp as any)[method](...args, (error: Error | null | undefined, result: T) =>
      error ? reject(error) : resolve(result),
    ),
  );

describeSftp('SFTP test server (raw ssh2)', () => {
  const dir = `${SFTP_SERVER.dir}/e2e-smoke-${randomUUID().slice(0, 8)}`;

  it('uploads, lists, downloads and deletes a file, with the host key verified', async () => {
    const { client, sftp } = await connectSftp((key) => fingerprint(key) === SFTP_SERVER.hostKey);
    try {
      await call(sftp, 'mkdir', dir);
      await call(sftp, 'writeFile', `${dir}/a.txt`, content);

      const listed = await call<{ filename: string; attrs: { size: number } }[]>(sftp, 'readdir', dir);
      expect(listed.map((f) => [f.filename, f.attrs.size])).toEqual([['a.txt', content.length]]);

      expect(await call(sftp, 'readFile', `${dir}/a.txt`)).toEqual(content);

      await call(sftp, 'unlink', `${dir}/a.txt`);
      expect(await call(sftp, 'readdir', dir)).toEqual([]);
      await call(sftp, 'rmdir', dir);
    } finally {
      client.end();
    }
  });

  it('exposes the host key fingerprint in the SHA256:<base64> form that the verifier computes', async () => {
    expect(SFTP_SERVER.hostKey).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });

  it('rejects a connection when the host key fingerprint does not match', async () => {
    const wrong = `SHA256:${Buffer.alloc(32, 1).toString('base64').replace(/=+$/, '')}`;
    const seen: string[] = [];
    await expect(
      connectSftp((key) => {
        seen.push(fingerprint(key));
        return fingerprint(key) === wrong;
      }),
    ).rejects.toThrow();
    expect(seen).toEqual([SFTP_SERVER.hostKey]);
  });
});
