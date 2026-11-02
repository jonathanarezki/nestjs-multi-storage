import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'crypto';
import { StorageDisk, StorageModule, StorageService } from 'nestjs-multi-storage';
import {
  collect,
  createCtx,
  describeFtp,
  expectFsError,
  FTP_BACKEND,
  ftpOptions,
  FTP_SERVER,
  sleep,
  useCtx,
} from './support/harness';

const MiB = 1024 * 1024;

/** The ftp driver behind a service, for the tests that look at (or break) its connection pool. */
const internals = (service: StorageDisk): any => (service as any).driver;

/** Writes `data` through a write stream and resolves when 'finish' is emitted. */
const upload = (service: StorageDisk, name: string, data: Buffer) =>
  new Promise<void>((resolve, reject) => {
    const ws = service.createWriteStream(name);
    ws.on('error', reject).on('finish', () => resolve());
    ws.end(data);
  });

describeFtp('ftp pool (maxConnections 2)', () => {
  const h = useCtx(FTP_BACKEND, 'ftp-pool');

  it('serves more parallel operations than maxConnections, and never opens more connections', async () => {
    const { service } = h.ctx;
    const names = Array.from({ length: 12 }, (_, i) => `f${i}.txt`);
    await Promise.all(names.map((name, i) => service.writeFile(name, `content ${i}`)));
    const contents = await Promise.all(names.map((name) => service.readFile(name, 'utf8')));
    expect(contents).toEqual(names.map((_, i) => `content ${i}`));
    expect((await service.readdir('')).sort()).toEqual([...names].sort());
    expect(internals(service).clients.size).toBeLessThanOrEqual(2);
    expect(internals(service).waiters).toHaveLength(0);
  });

  it('reuses idle connections', async () => {
    const { service } = h.ctx;
    await service.stat('');
    const connected = [...internals(service).clients];
    await service.stat('');
    await service.readdir('');
    expect([...internals(service).clients]).toEqual(connected);
  });

  it('releases connections after errors', async () => {
    const { service } = h.ctx;
    for (let i = 0; i < 6; i++) {
      await expectFsError(service.readFile('missing.txt'), { code: 'ENOENT', syscall: 'open' });
      await expectFsError(service.rename('missing.txt', 'x.txt'), { code: 'ENOENT', syscall: 'rename' });
      await expectFsError(service.writeFile('no/parent.txt', 'x'), { code: 'ENOENT', syscall: 'open' });
      await expectFsError(collect(service.createReadStream('missing.txt')), { code: 'ENOENT', syscall: 'open' });
    }
    await service.writeFile('ok.txt', 'ok');
    expect(await service.readFile('ok.txt', 'utf8')).toBe('ok');
    expect(internals(service).clients.size).toBeLessThanOrEqual(2);
  });

  it('recovers when the server dropped the connections', async () => {
    const { service } = h.ctx;
    await service.writeFile('a.txt', 'a');
    await Promise.all([service.stat('a.txt'), service.stat('')]);
    expect(internals(service).clients.size).toBeGreaterThan(0);
    // Like an idle timeout of the server
    for (const client of internals(service).clients) client.close();
    expect(await service.readFile('a.txt', 'utf8')).toBe('a');
    await service.writeFile('b.txt', 'b');
    expect((await service.readdir('')).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('retries an idempotent operation once when its connection turns out to be dead', async () => {
    const { service } = h.ctx;
    await service.writeFile('a.txt', 'a');
    const [client] = internals(service).clients;
    let calls = 0;
    client.size = async () => {
      calls++;
      client.close();
      throw new Error('Client is closed');
    };
    expect((await service.stat('a.txt')).size).toBe(1);
    expect(calls).toBe(1);
  });

  it('does not retry rename, which is not idempotent, and gives up after one retry', async () => {
    const { service } = h.ctx;
    await service.writeFile('a.txt', 'a');
    const [client] = internals(service).clients;
    client.rename = async () => {
      client.close();
      throw new Error('Client is closed');
    };
    await expect(service.rename('a.txt', 'b.txt')).rejects.toThrow('Client is closed');
    // The next operation gets a new connection
    expect(await service.exists('a.txt')).toBe(true);

    const failing = (service as any).driver;
    const original = failing.lookup.bind(failing);
    let attempts = 0;
    failing.lookup = async (c: any) => {
      attempts++;
      c.close();
      throw new Error('Client is closed');
    };
    await expect(service.stat('a.txt')).rejects.toThrow('Client is closed');
    expect(attempts).toBe(2);
    failing.lookup = original;
    expect(await service.exists('a.txt')).toBe(true);
  });

  it('closes every connection on destroy, and reconnects on the next operation', async () => {
    const { service } = h.ctx;
    await service.writeFile('a.txt', 'a');
    const clients = [...internals(service).clients];
    expect(clients.length).toBeGreaterThan(0);
    await internals(service).destroy();
    expect(clients.every((client: any) => client.closed)).toBe(true);
    expect(internals(service).clients.size).toBe(0);
    expect(await service.readFile('a.txt', 'utf8')).toBe('a');
    expect(clients.some((client: any) => internals(service).clients.has(client))).toBe(false);
    expect(internals(service).clients.size).toBeGreaterThan(0);
  });

  it('closes the connection of an operation that is in flight during destroy, and does not pool it', async () => {
    const { service } = h.ctx;
    await service.writeFile('big.bin', Buffer.alloc(4 * MiB));
    const stream = service.createReadStream('big.bin');
    stream.on('error', () => undefined).pause();
    await sleep(500);
    const held = [...internals(service).clients];
    await internals(service).destroy();
    stream.destroy();
    await sleep(100);
    expect(held.every((client: any) => client.closed)).toBe(true);
    // The destroyed connection did not come back: the pool is empty, and fully usable again
    expect(internals(service).idle).toHaveLength(0);
    expect(internals(service).clients.size).toBe(0);
    expect(await service.stat('big.bin')).toMatchObject({ size: 4 * MiB });
    expect(internals(service).clients.size).toBe(1);
  });

  it('rejects the callers that are still waiting for a connection on destroy', async () => {
    const { service } = h.ctx;
    await service.writeFile('big.bin', Buffer.alloc(4 * MiB));
    // Both connections are held by paused streams, the third caller waits
    const streams = [service.createReadStream('big.bin'), service.createReadStream('big.bin')];
    for (const stream of streams) stream.on('error', () => undefined).pause();
    await sleep(500);
    const waiting = service.stat('big.bin');
    await sleep(100);
    expect(internals(service).waiters).toHaveLength(1);
    await internals(service).destroy();
    await expect(waiting).rejects.toThrow('destroyed');
    streams.forEach((stream) => stream.destroy());
    // Later operations reconnect, and the in-flight connections did not take a slot in the new pool
    await sleep(100);
    expect(await service.exists('big.bin')).toBe(true);
    expect(internals(service).clients.size).toBeLessThanOrEqual(2);
    expect(internals(service).waiters).toHaveLength(0);
  });

  it('getSignedUrl and getSignedPutUrl are not supported', async () => {
    const { service } = h.ctx;
    await expect(service.getSignedUrl('a.txt')).rejects.toThrow('Signed URLs are not supported for ftp storage.');
    await expect(service.getSignedPutUrl('a.txt')).rejects.toThrow('Signed URLs are not supported for ftp storage.');
  });
});

describeFtp('ftp pool (maxConnections 1)', () => {
  const h = useCtx(FTP_BACKEND, 'ftp-pool1', { overrides: { maxConnections: 1 } });

  it('does not deadlock with streams and other operations at the same time', async () => {
    const { service } = h.ctx;
    const big = randomBytes(3 * MiB);
    await service.writeFile('big.bin', big);

    const [read, copy, written] = await Promise.all([
      collect(service.createReadStream('big.bin')),
      service.copyFile('big.bin', 'copy.bin'),
      upload(service, 'w.bin', big),
      service.stat('big.bin'),
      service.readdir('', { recursive: true }),
      service.exists('nope'),
      service.rename('big.bin', 'moved.bin').catch(() => undefined),
      service.mkdir('a/b/c'),
      service.rmdir('a'),
    ]);
    expect(read.equals(big)).toBe(true);
    expect(copy).toBeUndefined();
    expect(written).toBeUndefined();
    expect((await service.readFile('w.bin')).equals(big)).toBe(true);
    expect(internals(service).clients.size).toBe(1);
    expect(internals(service).waiters).toHaveLength(0);
  });

  it('serves queued callers in order', async () => {
    const { service } = h.ctx;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        service.writeFile(`q${i}.txt`, 'x').then(() => {
          order.push(i);
        }),
      ),
    );
    expect(order).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('recursive operations work with a single connection', async () => {
    const { service } = h.ctx;
    for (const name of ['t/a/b/1.txt', 't/a/2.txt', 't/3.txt']) {
      await service.mkdir(name.replace(/[^/]*$/, ''));
      await service.writeFile(name, 'x');
    }
    expect((await service.readdir('t', { recursive: true })).sort()).toEqual([
      '3.txt',
      'a',
      'a/2.txt',
      'a/b',
      'a/b/1.txt',
    ]);
    await service.rename('t', 'u');
    await service.rm('u', { recursive: true });
    expect(await service.exists('u')).toBe(false);
  });

  it('releases the connection when a read stream is destroyed mid-transfer', async () => {
    const { service } = h.ctx;
    await service.writeFile('big.bin', randomBytes(8 * MiB));
    for (let i = 0; i < 3; i++) {
      const stream = service.createReadStream('big.bin');
      await new Promise((resolve) => stream.once('data', resolve));
      const closed = new Promise((resolve) => stream.once('close', resolve));
      stream.destroy();
      await closed;
      // The next operation needs the (only) connection
      expect((await service.stat('big.bin')).size).toBe(8 * MiB);
    }
    expect(internals(service).clients.size).toBe(1);
  });

  it('releases the connection when a write stream is destroyed mid-transfer', async () => {
    const { service } = h.ctx;
    for (let i = 0; i < 3; i++) {
      const ws = service.createWriteStream(`partial${i}.bin`);
      ws.on('error', () => undefined);
      let finished = false;
      ws.on('finish', () => (finished = true));
      const closed = new Promise((resolve) => ws.once('close', resolve));
      for (let chunk = 0; chunk < 4; chunk++) ws.write(Buffer.alloc(MiB, 1));
      await sleep(200);
      ws.destroy();
      await closed;
      expect(finished).toBe(false);
      expect(await service.exists('')).toBe(true);
    }
    expect(internals(service).clients.size).toBe(1);
  });

  it('releases the connection when a read stream is destroyed before it got one', async () => {
    const { service } = h.ctx;
    await service.writeFile('a.txt', 'a');
    const holder = service.createReadStream('a.txt');
    const early = service.createReadStream('a.txt');
    early.on('error', () => undefined);
    early.destroy();
    expect((await collect(holder)).toString()).toBe('a');
    expect(await service.readFile('a.txt', 'utf8')).toBe('a');
  });

  it('a failed write stream (missing parent) emits ENOENT and releases the connection', async () => {
    const { service, errPath } = h.ctx;
    const ws = service.createWriteStream('no/such/dir.txt');
    await expectFsError(
      new Promise((resolve, reject) => {
        ws.on('error', reject).on('finish', resolve);
        ws.end('data');
      }),
      { code: 'ENOENT', errno: -2, syscall: 'open', path: errPath('no/such/dir.txt') },
    );
    expect(await service.exists('no')).toBe(false);
  });
});

describeFtp('ftp large files', () => {
  const h = useCtx(FTP_BACKEND, 'ftp-large');

  it('streams a 12 MiB file up and down', async () => {
    const { service } = h.ctx;
    const big = randomBytes(12 * MiB);
    await upload(service, 'big.bin', big);
    expect((await service.stat('big.bin')).size).toBe(big.length);
    expect((await collect(service.createReadStream('big.bin'))).equals(big)).toBe(true);
    expect((await service.readFile('big.bin')).equals(big)).toBe(true);
  });

  it('copies and renames a large file', async () => {
    const { service } = h.ctx;
    const big = randomBytes(6 * MiB);
    await service.writeFile('big.bin', big);
    await service.copyFile('big.bin', 'big2.bin');
    await service.rename('big2.bin', 'big3.bin');
    expect((await service.readFile('big3.bin')).equals(big)).toBe(true);
    expect(await service.exists('big2.bin')).toBe(false);
  });

  it('range reads: start (REST), end (client-side truncation) and both', async () => {
    const { service } = h.ctx;
    const big = randomBytes(8 * MiB);
    await service.writeFile('big.bin', big);

    const start = 3 * MiB + 17;
    expect((await collect(service.createReadStream('big.bin', { start }))).equals(big.subarray(start))).toBe(true);
    expect(
      (await collect(service.createReadStream('big.bin', { start, end: start + 99 }))).equals(
        big.subarray(start, start + 100),
      ),
    ).toBe(true);
    expect((await collect(service.createReadStream('big.bin', { end: 99 }))).equals(big.subarray(0, 100))).toBe(true);
    // Truncated near the end of the file, and beyond it
    const tail = big.length - 5;
    expect(
      (await collect(service.createReadStream('big.bin', { start: tail, end: big.length + 100 }))).equals(
        big.subarray(tail),
      ),
    ).toBe(true);
    // A truncated read leaves the pool usable
    expect((await service.stat('big.bin')).size).toBe(big.length);
    expect((await service.readFile('big.bin')).equals(big)).toBe(true);
  });

  it('a read stream honours highWaterMark and applies back pressure', async () => {
    const { service } = h.ctx;
    await service.writeFile('big.bin', randomBytes(4 * MiB));
    const stream = service.createReadStream('big.bin', { highWaterMark: 1024 });
    let length = 0;
    for await (const chunk of stream) {
      length += (chunk as Buffer).length;
      if (length === (chunk as Buffer).length) await sleep(50);
    }
    expect(length).toBe(4 * MiB);
  });
});

/** A disk (not created up front) below `prefix`; the caller closes `moduleRef`. */
async function openDisk(prefix: string, overrides: Record<string, unknown> = {}) {
  const moduleRef = await Test.createTestingModule({
    imports: [StorageModule.forRoot(ftpOptions(prefix, overrides))],
  }).compile();
  await moduleRef.init();
  return { service: moduleRef.get(StorageService), moduleRef };
}

describeFtp('ftp relative prefixes', () => {
  const escapes = async (service: StorageDisk) => {
    for (const p of ['../x', 'a/../../x', '..']) {
      await expect(service.readFile(p)).rejects.toThrow(/escapes the storage prefix/);
      await expect(service.writeFile(p, 'x')).rejects.toThrow(/escapes the storage prefix/);
      await expect(service.exists(p)).rejects.toThrow(/escapes the storage prefix/);
    }
  };

  it("'.' is the login directory itself, and cannot be left", async () => {
    const name = `rel-${randomUUID().slice(0, 8)}`;
    const { service, moduleRef } = await openDisk('.');
    try {
      await escapes(service);
      await service.mkdir(`${name}/sub`);
      await service.writeFile(`${name}/sub/a.txt`, 'dot');
      expect(await service.readFile(`${name}/sub/a.txt`, 'utf8')).toBe('dot');
      expect(await service.readdir(name)).toEqual(['sub']);
      // ...which is also where a disk with the prefix `name` finds it
      const inner = await openDisk(name);
      try {
        expect(await inner.service.readFile('sub/a.txt', 'utf8')).toBe('dot');
      } finally {
        await inner.moduleRef.close();
      }
    } finally {
      await service.rmdir(name).catch(() => undefined);
      await moduleRef.close();
    }
  });

  it.each([(name: string) => `./${name}`, (name: string) => name, (name: string) => `./${name}/`])(
    'a relative prefix is resolved against the login directory (%#)',
    async (toPrefix) => {
      const name = `rel-${randomUUID().slice(0, 8)}`;
      const { service, moduleRef } = await openDisk(toPrefix(name));
      const root = await openDisk('.');
      try {
        await escapes(service);
        await service.mkdir('');
        await service.writeFile('a.txt', 'rel');
        expect(await service.readFile('a.txt', 'utf8')).toBe('rel');
        expect(await service.readdir('')).toEqual(['a.txt']);
        expect(await root.service.readFile(`${name}/a.txt`, 'utf8')).toBe('rel');
      } finally {
        await root.service.rmdir(name).catch(() => undefined);
        await root.moduleRef.close();
        await moduleRef.close();
      }
    },
  );
});

describeFtp('ftp configuration', () => {
  it('connects lazily', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot(ftpOptions('x'))],
    }).compile();
    await moduleRef.init();
    try {
      expect(internals(moduleRef.get(StorageService)).clients.size).toBe(0);
    } finally {
      await moduleRef.close();
    }
  });

  it('requires a host', async () => {
    const compile = Test.createTestingModule({
      imports: [StorageModule.forRoot(ftpOptions('x', { host: '' }))],
    })
      .compile()
      .then((moduleRef) => moduleRef.init());
    await expect(compile).rejects.toThrow(`type 'ftp' requires "host"`);
  });

  it('starts without a connection, and fails the first operation, when the server is unreachable', async () => {
    // No harness here: it creates the prefix, which would already need a connection
    const { service, moduleRef } = await openDisk('x', { port: 1, timeout: 2000 });
    try {
      await expect(service.stat('a.txt')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      // The failed connection does not stick
      await expect(service.exists('a.txt')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(internals(service).clients.size).toBe(0);
    } finally {
      await moduleRef.close();
    }
  });

  it('a prefix cannot be left, and a relative prefix is relative to the login directory', async () => {
    const ctx = await createCtx(FTP_BACKEND, 'ftp-prefix');
    try {
      await expect(ctx.service.readFile('../x')).rejects.toThrow(/escapes the storage prefix/);
      await ctx.service.writeFile('a.txt', 'a');
      expect(await ctx.service.readFile('a.txt', 'utf8')).toBe('a');
      expect(FTP_SERVER.host).not.toBe('');
    } finally {
      await ctx.close();
    }
  });
});
