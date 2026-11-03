import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';
import * as path from 'path';
import { Client } from 'ssh2';
import { StorageDisk, StorageModule, StorageService } from 'nestjs-multi-storage';
import {
  collect,
  createCtx,
  describeSftp,
  expectFsError,
  SFTP_BACKEND,
  SFTP_SERVER,
  sftpOptions,
  useCtx,
} from './support/harness';
import { generateEd25519 } from './support/keys';

const MiB = 1024 * 1024;

/** The SFTP driver behind a service, for tests that look at (or break) its connection. */
const internals = (service: unknown): any => (service as any).source.get();

/** Records the sockets the driver opens, so that a test can check that none is left open. */
function trackSockets() {
  const sockets: net.Socket[] = [];
  const connect = net.connect;
  jest.spyOn(net, 'connect').mockImplementation(((...args: any[]) => {
    const socket = (connect as any)(...args);
    sockets.push(socket);
    return socket;
  }) as any);
  return sockets;
}

/** A disk below a fresh remote directory that is not created up front, so that it can fail to connect. */
async function openDisk(overrides: Record<string, unknown> = {}, prefix?: string) {
  prefix ??= path.posix.join(SFTP_SERVER.dir, 'e2e', `sftp-${randomUUID().slice(0, 8)}`);
  const moduleRef = await Test.createTestingModule({
    imports: [StorageModule.forRoot(sftpOptions(prefix, overrides))],
  }).compile();
  await moduleRef.init();
  return { service: moduleRef.get(StorageService), moduleRef, prefix };
}

describeSftp('sftp host key', () => {
  afterEach(() => jest.restoreAllMocks());

  it('connects with the right host key', async () => {
    const ctx = await createCtx(SFTP_BACKEND, 'hostkey-ok');
    try {
      await ctx.service.writeFile('a.txt', 'ok');
      expect(await ctx.service.readFile('a.txt', 'utf8')).toBe('ok');
    } finally {
      await ctx.close();
    }
  });

  it('refuses a wrong host key with a mismatch error, and writes nothing', async () => {
    const wrong = `SHA256:${Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '')}`;
    const { service, moduleRef, prefix } = await openDisk({ hostKey: wrong });
    // A disk that looks at the folder the refused one would have created
    const good = await openDisk({}, path.posix.dirname(prefix));
    try {
      const mismatch = `sftp host key mismatch: expected ${wrong}, got ${SFTP_SERVER.hostKey}`;
      await expect(service.mkdir('')).rejects.toThrow(mismatch);
      await expect(service.writeFile('a.txt', 'x')).rejects.toThrow(mismatch);
      await expect(service.readFile('a.txt')).rejects.toThrow(mismatch);
      await expect(collect(service.createReadStream('a.txt'))).rejects.toThrow(mismatch);
      // Nothing was created on the server, not even the folder
      expect(await good.service.exists(path.posix.basename(prefix))).toBe(false);
    } finally {
      await moduleRef.close();
      await good.moduleRef.close();
    }
  });

  it('connects with hostKey: false (verification skipped)', async () => {
    const ctx = await createCtx(SFTP_BACKEND, 'hostkey-false', { overrides: { hostKey: false } });
    try {
      await ctx.service.writeFile('a.txt', 'ok');
      expect(await ctx.service.readFile('a.txt', 'utf8')).toBe('ok');
    } finally {
      await ctx.close();
    }
  });

  it('a missing hostKey fails at construction', async () => {
    for (const hostKey of [undefined, '']) {
      await expect(
        Test.createTestingModule({
          imports: [StorageModule.forRoot(sftpOptions('/upload/x', { hostKey }))],
        }).compile(),
      ).rejects.toThrow(
        `type 'sftp' requires "hostKey" (the server's host key fingerprint) or hostKey: false to skip verification`,
      );
    }
  });

  it('rejects a hostKey that is not a SHA256 fingerprint', async () => {
    await expect(
      Test.createTestingModule({
        imports: [StorageModule.forRoot(sftpOptions('/upload/x', { hostKey: 'MD5:aa:bb' }))],
      }).compile(),
    ).rejects.toThrow('"hostKey" must be a fingerprint in the form SHA256:<base64>');
  });
});

describeSftp('sftp connection', () => {
  afterEach(() => jest.restoreAllMocks());

  it('concurrent first operations open exactly one connection', async () => {
    const connect = jest.spyOn(Client.prototype, 'connect');
    const { service, moduleRef } = await openDisk();
    try {
      await Promise.all(Array.from({ length: 8 }, (_, i) => service.mkdir(`d${i}`)));
      await Promise.all(Array.from({ length: 8 }, (_, i) => service.writeFile(`d${i}/f.txt`, String(i))));
      expect(connect).toHaveBeenCalledTimes(1);
      await service.rmdir('');
    } finally {
      await moduleRef.close();
    }
  });

  it('sends requests without Nagle delays (TCP_NODELAY): sequential requests take milliseconds, not multiples of 40 ms', async () => {
    const { service, moduleRef } = await openDisk();
    try {
      await service.mkdir('');
      await service.stat(''); // connection and channel are open now
      const start = Date.now();
      for (let i = 0; i < 20; i++) await service.stat('');
      // With Nagle's algorithm and the server's delayed ACK each stat takes ~42 ms: 20 of them ~840 ms
      expect(Date.now() - start).toBeLessThan(400);
      await service.rmdir('');
    } finally {
      await moduleRef.close();
    }
  });

  it('does not connect before the first operation', async () => {
    const connect = jest.spyOn(Client.prototype, 'connect');
    const { moduleRef } = await openDisk();
    await moduleRef.close();
    expect(connect).not.toHaveBeenCalled();
  });

  it('a failed connection does not stick: the next operation tries again', async () => {
    const sockets = trackSockets();
    const connect = jest.spyOn(Client.prototype, 'connect').mockImplementationOnce(function (this: Client) {
      setImmediate(() => this.emit('error', new Error('boom')));
      return this;
    });
    const { service, moduleRef } = await openDisk();
    try {
      await expect(service.mkdir('')).rejects.toThrow('boom');
      // The mocked connect never used its socket: the driver closed it
      expect(sockets.map((socket) => socket.destroyed)).toEqual([true]);
      await service.mkdir('');
      expect(connect).toHaveBeenCalledTimes(2);
      await service.rmdir('');
    } finally {
      await moduleRef.close();
    }
  });

  it('an unparseable private key is rejected and leaves no socket open', async () => {
    const sockets = trackSockets();
    const { service, moduleRef } = await openDisk({ privateKey: 'not a key' });
    try {
      await expect(service.mkdir('')).rejects.toThrow(/parse privateKey/i);
      expect(sockets).toHaveLength(1);
      expect(sockets[0].destroyed).toBe(true);
    } finally {
      await moduleRef.close();
    }
  });

  it('failed operations in a row do not accumulate sockets', async () => {
    const sockets = trackSockets();
    const { service, moduleRef } = await openDisk({ privateKey: 'not a key' });
    try {
      await expect(service.mkdir('')).rejects.toThrow(/parse privateKey/i);
      await expect(service.readdir('')).rejects.toThrow(/parse privateKey/i);
      expect(sockets).toHaveLength(2);
      expect(sockets.map((socket) => socket.destroyed)).toEqual([true, true]);
    } finally {
      await moduleRef.close();
    }
  });

  it('a refused host key leaves no socket open', async () => {
    const sockets = trackSockets();
    const wrong = `SHA256:${Buffer.alloc(32, 7).toString('base64').replace(/=+$/, '')}`;
    const { service, moduleRef } = await openDisk({ hostKey: wrong });
    try {
      await expect(service.mkdir('')).rejects.toThrow('sftp host key mismatch');
      await expect(service.mkdir('')).rejects.toThrow('sftp host key mismatch');
      expect(sockets).toHaveLength(2);
      // The socket is destroyed by the driver, not left for ssh2 to close in its own time
      expect(sockets.map((socket) => socket.destroyed)).toEqual([true, true]);
    } finally {
      await moduleRef.close();
    }
  });

  it('reconnects after the connection was ended', async () => {
    const connect = jest.spyOn(Client.prototype, 'connect');
    const h = await createCtx(SFTP_BACKEND, 'reconnect-end');
    try {
      const { service } = h;
      await service.writeFile('a.txt', 'before');
      // ssh2's end() returns at once: wait for the connection to be closed
      const client: Client = internals(service).client;
      await new Promise((resolve) => {
        client.on('close', () => resolve(undefined));
        client.end();
      });
      // Writes are not retried, but the next operation starts on a new connection
      await service.writeFile('b.txt', 'after');
      expect(await service.readFile('a.txt', 'utf8')).toBe('before');
      expect(await service.readFile('b.txt', 'utf8')).toBe('after');
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      await h.close();
    }
  });

  it('retries a read once when the connection broke without notice', async () => {
    const connect = jest.spyOn(Client.prototype, 'connect');
    const h = await createCtx(SFTP_BACKEND, 'reconnect-socket');
    try {
      const { service } = h;
      await service.writeFile('a.txt', 'data');
      // Kill the socket and read before the 'close' event could have been handled
      internals(service).client._sock.destroy();
      expect(await service.readFile('a.txt', 'utf8')).toBe('data');
      internals(service).client._sock.destroy();
      expect(await service.exists('a.txt')).toBe(true);
      internals(service).client._sock.destroy();
      expect((await service.stat('a.txt')).size).toBe(4);
      internals(service).client._sock.destroy();
      expect(await service.readdir('')).toEqual(['a.txt']);
      expect(connect.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      await h.close();
    }
  });

  it('destroy() ends the connection, and a later operation reconnects', async () => {
    const h = await createCtx(SFTP_BACKEND, 'destroy');
    try {
      const driver = internals(h.service);
      await h.service.writeFile('a.txt', 'x');
      expect(driver.client).toBeDefined();
      await driver.destroy();
      expect(driver.client).toBeUndefined();
      expect(await h.service.readFile('a.txt', 'utf8')).toBe('x');
    } finally {
      await h.close();
    }
  });
});

describeSftp('sftp rename', () => {
  const h = useCtx(SFTP_BACKEND, 'sftp-rename');

  it('the test server supports posix-rename', async () => {
    await h.ctx.service.mkdir('');
    const sftp = await internals(h.ctx.service).connection();
    expect(sftp._extensions['posix-rename@openssh.com']).toBe('1');
  });

  it('a file replaces an existing file (posix-rename)', async () => {
    const { service } = h.ctx;
    await service.writeFile('a.txt', 'new');
    await service.writeFile('b.txt', 'old');
    await service.rename('a.txt', 'b.txt');
    expect(await service.readFile('b.txt', 'utf8')).toBe('new');
    expect(await service.exists('a.txt')).toBe(false);
  });

  describe('without the posix-rename extension (delete, then rename)', () => {
    beforeEach(async () => {
      await h.ctx.service.mkdir('');
      const sftp = await internals(h.ctx.service).connection();
      // What ssh2 does for a server without the extension: it throws before sending anything
      sftp.ext_openssh_rename = () => {
        throw new Error('Server does not support this extended request');
      };
    });

    it('only that error selects the fallback: any other failure of the rename is reported, nothing deleted', async () => {
      const { service } = h.ctx;
      const sftp = await internals(service).connection();
      sftp.ext_openssh_rename = (_from: string, _to: string, cb: (error: Error) => void) =>
        cb(Object.assign(new Error('Permission denied'), { code: 3 }));
      await service.writeFile('a.txt', 'new');
      await service.writeFile('b.txt', 'old');
      await expect(service.rename('a.txt', 'b.txt')).rejects.toMatchObject({ code: 'EACCES' });
      expect(await service.readFile('b.txt', 'utf8')).toBe('old');
      expect(await service.readFile('a.txt', 'utf8')).toBe('new');
    });

    it('a file replaces an existing file', async () => {
      const { service } = h.ctx;
      await service.writeFile('a.txt', 'new');
      await service.writeFile('b.txt', 'old');
      await service.rename('a.txt', 'b.txt');
      expect(await service.readFile('b.txt', 'utf8')).toBe('new');
      expect(await service.exists('a.txt')).toBe(false);
    });

    it('a folder replaces an empty folder, and keeps the rules of fs', async () => {
      const { service, errPath } = h.ctx;
      await service.mkdir('src/sub');
      await service.writeFile('src/sub/x.txt', 'x');
      await service.mkdir('empty');
      await service.rename('src', 'empty');
      expect((await service.readdir('empty', { recursive: true })).sort()).toEqual(['sub', 'sub/x.txt']);

      await service.writeFile('f.txt', 'f');
      await service.mkdir('full');
      await service.writeFile('full/k.txt', 'k');
      await expectFsError(service.rename('empty', 'full'), {
        code: 'ENOTEMPTY',
        syscall: 'rename',
        dest: errPath('full'),
      });
      await expectFsError(service.rename('f.txt', 'full'), { code: 'EISDIR', syscall: 'rename' });
      await expectFsError(service.rename('full', 'f.txt'), { code: 'ENOTDIR', syscall: 'rename' });
      expect(await service.readFile('f.txt', 'utf8')).toBe('f');
    });
  });
});

describeSftp('sftp files and streams', () => {
  const h = useCtx(SFTP_BACKEND, 'sftp-files');

  it('writes and reads back a multi-MiB file through streams', async () => {
    const { service } = h.ctx;
    const big = randomBytes(9 * MiB + 123);
    await new Promise<void>((resolve, reject) => {
      const ws = service.createWriteStream('big.bin');
      ws.on('error', reject).on('finish', () => resolve());
      for (let offset = 0; offset < big.length; offset += MiB) ws.write(big.subarray(offset, offset + MiB));
      ws.end();
    });
    expect((await service.stat('big.bin')).size).toBe(big.length);
    expect((await collect(service.createReadStream('big.bin'))).equals(big)).toBe(true);
    expect((await service.readFile('big.bin')).equals(big)).toBe(true);

    await service.copyFile('big.bin', 'big2.bin');
    expect((await service.readFile('big2.bin')).equals(big)).toBe(true);
  });

  it('reads ranges of a large file', async () => {
    const { service } = h.ctx;
    const big = randomBytes(5 * MiB);
    await service.writeFile('big.bin', big);
    const range = (start?: number, end?: number) => collect(service.createReadStream('big.bin', { start, end }));
    expect((await range(MiB + 5, 3 * MiB + 17)).equals(big.subarray(MiB + 5, 3 * MiB + 18))).toBe(true);
    expect((await range(5 * MiB - 10)).equals(big.subarray(5 * MiB - 10))).toBe(true);
    expect((await range(undefined, 99)).equals(big.subarray(0, 100))).toBe(true);
  });

  it('finish is emitted only after the data is on the server', async () => {
    const { service } = h.ctx;
    const ws = service.createWriteStream('f.bin');
    let sizeAtFinish: number | undefined;
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('finish', () => {
        service
          .stat('f.bin')
          .then((st) => (sizeAtFinish = st.size), reject)
          .then(() => resolve());
      });
      ws.end(Buffer.alloc(3 * MiB, 1));
    });
    expect(sizeAtFinish).toBe(3 * MiB);
  });

  it('a write stream into a missing folder emits ENOENT, and does not finish', async () => {
    const { service, errPath } = h.ctx;
    const ws = service.createWriteStream('no/such/f.txt');
    let finished = false;
    ws.on('finish', () => (finished = true));
    const error: any = await new Promise((resolve) => {
      ws.on('error', resolve);
      ws.end('x');
    });
    expect(error.code).toBe('ENOENT');
    expect(error.syscall).toBe('open');
    expect(error.path).toBe(errPath('no/such/f.txt'));
    expect(finished).toBe(false);
  });

  it('destroy() mid-upload leaves no partial file behind', async () => {
    const { service } = h.ctx;
    const ws = service.createWriteStream('partial.bin');
    ws.on('error', () => undefined);
    const closed = new Promise((resolve) => ws.on('close', resolve));
    const chunk = Buffer.alloc(MiB, 2);
    for (let i = 0; i < 3; i++) if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
    ws.destroy();
    await closed;
    expect(await service.exists('partial.bin')).toBe(false);
  });

  it('writeFile honours the flags: append, and exclusive create (EEXIST)', async () => {
    const { service, errPath } = h.ctx;
    await service.writeFile('a.txt', 'a');
    await service.writeFile('a.txt', 'b', { flag: 'a' });
    expect(await service.readFile('a.txt', 'utf8')).toBe('ab');
    await expectFsError(service.writeFile('a.txt', 'c', { flag: 'wx' }), {
      code: 'EEXIST',
      syscall: 'open',
      path: errPath('a.txt'),
    });
    expect(await service.readFile('a.txt', 'utf8')).toBe('ab');
  });

  it('writeFile onto a folder is EISDIR; readFile of a folder is EISDIR (read)', async () => {
    const { service, errPath } = h.ctx;
    await service.mkdir('d');
    await expectFsError(service.writeFile('d', 'x'), { code: 'EISDIR', syscall: 'open', path: errPath('d') });
    await expectFsError(service.readFile('d'), { code: 'EISDIR', syscall: 'read', path: errPath('d') });
  });

  it('stat reports the real mode, size and ownership', async () => {
    const { service } = h.ctx;
    await service.writeFile('m.txt', 'hello', { mode: 0o640 });
    await service.mkdir('dir');
    const file = await service.stat('m.txt');
    expect(file.isFile()).toBe(true);
    expect(file.size).toBe(5);
    expect(file.mode & 0o777).toBe(0o640);
    expect(file.uid).toBeGreaterThan(0);
    expect((await service.stat('dir')).isDirectory()).toBe(true);
  });

  it('mkdir returns the first folder it created, undefined when nothing was created', async () => {
    const { service, errPath } = h.ctx;
    expect(await service.mkdir('a/b/c')).toBe(errPath('a/b/c').replace(/\/b\/c$/, ''));
    expect(await service.mkdir('a/b/c')).toBeUndefined();
    expect(await service.mkdir('a/b/c/d/e')).toBe(errPath('a/b/c/d'));
  });

  it('mkdir below a file is ENOTDIR', async () => {
    const { service } = h.ctx;
    await service.writeFile('f', 'x');
    await expectFsError(service.mkdir('f/child'), { code: 'ENOTDIR', syscall: 'mkdir' });
    await expectFsError(service.mkdir('f/child', { recursive: false }), { code: 'ENOTDIR', syscall: 'mkdir' });
  });

  it('removes a deep tree with many files', async () => {
    const { service } = h.ctx;
    await service.mkdir('t/a/b/c');
    await Promise.all(Array.from({ length: 40 }, (_, i) => service.writeFile(`t/a/b/c/f${i}.txt`, 'x')));
    await service.writeFile('t/a/top.txt', 'x');
    await service.rm('t', { recursive: true });
    expect(await service.exists('t')).toBe(false);
  });

  it('getSignedUrl and getSignedPutUrl are not supported', async () => {
    const { service } = h.ctx;
    await expect(service.getSignedUrl('a.txt')).rejects.toMatchObject({ code: 'ERR_STORAGE_NOT_SUPPORTED' });
    await expect(service.getSignedPutUrl('a.txt')).rejects.toMatchObject({ code: 'ERR_STORAGE_NOT_SUPPORTED' });
  });
});

describeSftp('sftp prefix', () => {
  const escapes = async (service: StorageDisk) => {
    for (const p of ['../x', 'a/../../x', '..']) {
      await expect(service.readFile(p)).rejects.toThrow(/escapes the storage prefix/);
      await expect(service.writeFile(p, 'x')).rejects.toThrow(/escapes the storage prefix/);
      await expect(service.exists(p)).rejects.toThrow(/escapes the storage prefix/);
    }
  };
  // The test user is chrooted: its login directory is the parent of /upload
  const upload = SFTP_SERVER.dir.replace(/^\//, '');

  it('accepts a prefix relative to the login directory', async () => {
    const relative = path.posix.join(upload, 'e2e', `rel-${randomUUID().slice(0, 8)}`);
    const ctx = await createCtx(SFTP_BACKEND, 'relative', { overrides: { prefix: relative } });
    try {
      await ctx.service.writeFile('a.txt', 'rel');
      expect(await ctx.service.readFile('a.txt', 'utf8')).toBe('rel');
      expect(await ctx.service.readdir('')).toEqual(['a.txt']);
      await expect(ctx.service.readFile('../x')).rejects.toThrow(/escapes the storage prefix/);
    } finally {
      await ctx.service.rmdir('').catch(() => undefined);
      await ctx.moduleRef.close();
    }
  });

  it("'.' is the login directory itself, and cannot be left", async () => {
    const { service, moduleRef } = await openDisk({}, '.');
    try {
      await escapes(service);
      expect((await service.stat(upload)).isDirectory()).toBe(true);
      expect((await service.readdir('')).includes(upload)).toBe(true);
    } finally {
      await moduleRef.close();
    }
  });

  it.each([(dir: string) => `./${dir}`, (dir: string) => dir, (dir: string) => `./${dir}/`])(
    'a relative prefix is resolved against the login directory (%#)',
    async (toPrefix) => {
      const dir = path.posix.join(upload, 'e2e', `rel-${randomUUID().slice(0, 8)}`);
      const { service, moduleRef } = await openDisk({}, toPrefix(dir));
      const root = await openDisk({}, '.');
      try {
        await escapes(service);
        await service.mkdir('');
        await service.writeFile('a.txt', 'rel');
        expect(await service.readFile('a.txt', 'utf8')).toBe('rel');
        expect(await service.readdir('')).toEqual(['a.txt']);
        expect(await root.service.readFile(`${dir}/a.txt`, 'utf8')).toBe('rel');
      } finally {
        await service.rmdir('').catch(() => undefined);
        await root.moduleRef.close();
        await moduleRef.close();
      }
    },
  );
});

describeSftp('sftp private key authentication', () => {
  const readKey = (file: string) => fs.readFileSync(file, 'utf8');
  const login = async (overrides: Record<string, unknown>) => {
    const { service, moduleRef, prefix } = await openDisk({ password: undefined, ...overrides });
    try {
      await service.mkdir('');
      await service.writeFile('k.txt', 'key');
      expect(await service.readFile('k.txt', 'utf8')).toBe('key');
      await service.rmdir('');
    } finally {
      await moduleRef.close();
    }
    return prefix;
  };
  const withKey = SFTP_SERVER.keyPath ? it : it.skip;
  const withEncryptedKey = SFTP_SERVER.encryptedKeyPath && SFTP_SERVER.keyPassphrase ? it : it.skip;

  withKey('logs in with a private key (string, no password)', async () => {
    await login({ privateKey: readKey(SFTP_SERVER.keyPath) });
  });

  withKey('logs in with a private key given as a Buffer', async () => {
    await login({ privateKey: fs.readFileSync(SFTP_SERVER.keyPath) });
  });

  withEncryptedKey('logs in with an encrypted private key and its passphrase', async () => {
    await login({ privateKey: readKey(SFTP_SERVER.encryptedKeyPath), passphrase: SFTP_SERVER.keyPassphrase });
  });

  withEncryptedKey('rejects an encrypted private key with a wrong or missing passphrase', async () => {
    for (const passphrase of ['wrong-passphrase', undefined]) {
      const { service, moduleRef } = await openDisk({
        password: undefined,
        privateKey: readKey(SFTP_SERVER.encryptedKeyPath),
        passphrase,
      });
      try {
        await expect(service.mkdir('')).rejects.toThrow();
      } finally {
        await moduleRef.close();
      }
    }
  });

  it('rejects a key the server does not know, and does not fall back to nothing', async () => {
    const { private: privateKey } = generateEd25519();
    const { service, moduleRef } = await openDisk({ password: undefined, privateKey });
    try {
      await expect(service.mkdir('')).rejects.toThrow(/authentication methods failed/i);
      await expect(service.exists('a.txt')).rejects.toThrow(/authentication methods failed/i);
    } finally {
      await moduleRef.close();
    }
  });
});

describeSftp('sftp dead connection', () => {
  /** A TCP relay to the test server whose traffic can be frozen: from then on the connection is silently dead. */
  async function relay() {
    const pipes: net.Socket[] = [];
    const server = net.createServer((client) => {
      const upstream = net.connect({ host: SFTP_SERVER.host, port: SFTP_SERVER.port });
      pipes.push(client, upstream);
      client.pipe(upstream);
      upstream.pipe(client);
      client.on('error', () => undefined);
      upstream.on('error', () => undefined);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      port: (server.address() as net.AddressInfo).port,
      freeze: () => pipes.forEach((socket) => socket.pause()),
      close: () => {
        pipes.forEach((socket) => socket.destroy());
        server.close();
      },
    };
  }

  it('a request in flight when the server goes silent is rejected, and the next operation reconnects', async () => {
    const proxy = await relay();
    // `timeout` also sets the keepalive: a ping every 500 ms, the connection is given up after 4 unanswered intervals
    const { service, moduleRef } = await openDisk({ host: '127.0.0.1', port: proxy.port, timeout: 1500 });
    try {
      await service.mkdir('');
      await service.writeFile('a.txt', 'hello');
      proxy.freeze();
      const started = Date.now();
      // A write is not retried (a read is: it would be answered by a new connection)
      await expect(service.writeFile('b.txt', 'x')).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(8000);
      // Only the connections open at the time are frozen: the next operation gets a new one
      expect(await service.readFile('a.txt', 'utf8')).toBe('hello');
    } finally {
      proxy.close();
      await moduleRef.close();
    }
  }, 20_000);
});
