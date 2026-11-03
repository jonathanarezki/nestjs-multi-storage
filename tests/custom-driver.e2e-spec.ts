import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { once } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as util from 'util';
import {
  createFsError,
  createRmDirectoryError,
  createStats,
  createStorage,
  isStorageError,
  StorageDriver,
} from '@webbar/node-multi-storage';
import { StorageModule, StorageService } from 'nestjs-multi-storage';
import { collect, createCtx, describeBackends, describeS3, expectFsError, s3Options, useCtx } from './support/harness';

type MapDriver = StorageDriver & {
  files: Map<string, Buffer>;
  dirs: Set<string>;
  writes: Array<{ path: string; data: Buffer; options: unknown }>;
};

/** A minimal custom driver on a Map: no streams, no signed URLs, no init, no destroy. Paths are used as keys. */
function mapDriver(initial: Record<string, string> = {}): MapDriver {
  const files = new Map<string, Buffer>(Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]));
  const dirs = new Set<string>();
  const writes: MapDriver['writes'] = [];
  return {
    files,
    dirs,
    writes,
    async mkdir(p) {
      dirs.add(p);
      return undefined;
    },
    async readdir(p) {
      return [...files.keys()].filter((k) => k.startsWith(`${p}/`)).map((k) => k.slice(p.length + 1));
    },
    async rmdir(p) {
      dirs.delete(p);
    },
    async stat(p) {
      const file = files.get(p);
      if (!file && !dirs.has(p)) throw createFsError('ENOENT', 'stat', p);
      return createStats({
        mode: (file ? fs.constants.S_IFREG : fs.constants.S_IFDIR) | 0o644,
        size: file?.length ?? 0,
        mtime: new Date(0),
      });
    },
    async exists(p) {
      return files.has(p) || dirs.has(p);
    },
    async readFile(p) {
      if (dirs.has(p)) throw createFsError('EISDIR', 'read', p);
      const file = files.get(p);
      if (!file) throw createFsError('ENOENT', 'open', p);
      return file;
    },
    async writeFile(p, data, options) {
      writes.push({ path: p, data, options });
      if (p === 'fail.txt') throw createFsError('EACCES', 'open', p);
      files.set(p, data);
    },
    async rm(p) {
      files.delete(p);
    },
    async copyFile(src, dest) {
      files.set(dest, await this.readFile(src, {}));
    },
    async rename(from, to) {
      files.set(to, await this.readFile(from, {}));
      files.delete(from);
    },
  };
}

const METHODS = [
  'init',
  'destroy',
  'mkdir',
  'readdir',
  'rmdir',
  'stat',
  'exists',
  'readFile',
  'writeFile',
  'getSignedUrl',
  'getSignedPutUrl',
  'rm',
  'copyFile',
  'rename',
  'createReadStream',
  'createWriteStream',
] as const;

/** A wrapper that forwards everything to `inner` except `overrides` (an `undefined` override removes the method). */
function delegate(inner: StorageDriver, overrides: Partial<StorageDriver>): StorageDriver {
  const out: Partial<Record<(typeof METHODS)[number], unknown>> = {};
  for (const method of METHODS) {
    if (typeof inner[method] === 'function') out[method] = (inner[method] as Function).bind(inner);
  }
  return Object.assign(out, overrides) as StorageDriver;
}

const xor = (data: Buffer) => Buffer.from(data.map((byte) => byte ^ 0x5a));

/** "Encryption": the content is XORed on its way to and from the inner driver. The streams use the fallbacks. */
const encrypt = (inner: StorageDriver) =>
  delegate(inner, {
    readFile: async (p, o) => xor(await inner.readFile(p, o)),
    writeFile: (p, data, o) => inner.writeFile(p, xor(data), o),
    createReadStream: undefined,
    createWriteStream: undefined,
  });

const denied = (p: string) => createFsError('EACCES', 'open', p);

const readOnly = (inner: StorageDriver) =>
  delegate(inner, {
    writeFile: async (p) => Promise.reject(denied(p)),
    mkdir: async (p) => Promise.reject(denied(p)),
    rm: async (p) => Promise.reject(denied(p)),
    rmdir: async (p) => Promise.reject(denied(p)),
    copyFile: async (_src, dest) => Promise.reject(denied(dest)),
    rename: async (_from, to) => Promise.reject(denied(to)),
    createWriteStream: undefined,
  });

const nextError = async (stream: NodeJS.EventEmitter): Promise<any> => (await once(stream, 'error'))[0];

describe('custom disk: configuration', () => {
  it('accepts a driver instance (single disk)', async () => {
    const driver = mapDriver();
    const storage = createStorage({ type: 'custom', driver });
    await storage.writeFile('a.txt', 'hello');
    expect(await storage.readFile('a.txt', 'utf8')).toBe('hello');
    expect(driver.files.get('a.txt')).toEqual(Buffer.from('hello'));
    expect(storage.s3client).toBeUndefined();
    expect(storage.diskNames).toEqual(['default']);
  });

  it('accepts a driver instance and a factory in a multi-disk config', async () => {
    const a = mapDriver();
    const b = mapDriver();
    const storage = createStorage({
      default: 'a',
      disks: { a: { type: 'custom', driver: a }, b: { type: 'custom', driver: () => b }, m: { type: 'memory' } },
    });
    await storage.writeFile('x.txt', 'in a');
    await storage.disk('b').writeFile('x.txt', 'in b');
    await storage.disk('m').writeFile('x.txt', 'in m');
    expect(a.files.get('x.txt')?.toString()).toBe('in a');
    expect(b.files.get('x.txt')?.toString()).toBe('in b');
    expect(await storage.disk('m').readFile('x.txt', 'utf8')).toBe('in m');
    expect(await storage.disk('b').readFile('x.txt', 'utf8')).toBe('in b');
    await storage.destroy();
  });

  it('calls a factory lazily, once, and never from destroy() of an unused disk', async () => {
    const driver = mapDriver();
    const factory = jest.fn(() => driver);
    const unused = jest.fn(() => mapDriver());
    const storage = createStorage({
      default: 'used',
      disks: { used: { type: 'custom', driver: factory }, unused: { type: 'custom', driver: unused } },
    });
    expect(factory).not.toHaveBeenCalled();
    await storage.destroy();
    expect(factory).not.toHaveBeenCalled();
    await storage.writeFile('a.txt', 'x');
    await storage.readFile('a.txt');
    storage.createReadStream('a.txt').destroy();
    await storage.init();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(unused).toHaveBeenCalledTimes(1); // init() creates every driver
    await storage.destroy();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('a factory can be called by init() first', async () => {
    const factory = jest.fn(() => mapDriver());
    const storage = createStorage({ type: 'custom', driver: factory });
    expect(factory).not.toHaveBeenCalled();
    await storage.init();
    expect(factory).toHaveBeenCalledTimes(1);
    await storage.exists('a');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('calls init and destroy of the driver when present, and works without them', async () => {
    const calls: string[] = [];
    const full: StorageDriver = {
      ...mapDriver(),
      init: async () => void calls.push('init'),
      destroy: async () => void calls.push('destroy'),
    };
    const storage = createStorage({
      default: 'full',
      disks: { full: { type: 'custom', driver: full }, bare: { type: 'custom', driver: mapDriver() } },
    });
    await storage.init();
    expect(calls).toEqual(['init']);
    await storage.destroy();
    expect(calls).toEqual(['init', 'destroy']);
  });

  it('an init failure of the driver surfaces from init()', async () => {
    const storage = createStorage({
      type: 'custom',
      driver: { ...mapDriver(), init: () => Promise.reject(new Error('cannot connect')) },
    });
    await expect(storage.init()).rejects.toThrow('cannot connect');
  });

  it('a throwing factory surfaces its error and is retried on the next use', async () => {
    let attempts = 0;
    const storage = createStorage({
      type: 'custom',
      driver: () => {
        if (++attempts === 1) throw new Error('not ready');
        return mapDriver();
      },
    });
    await expect(storage.exists('a')).rejects.toThrow('not ready');
    expect(await storage.exists('a')).toBe(false);
    expect(attempts).toBe(2);
  });

  describe('validation', () => {
    const custom = (extra: object) => ({ type: 'custom', ...extra } as any);

    it('rejects a missing or invalid driver at createStorage time', () => {
      expect(() => createStorage(custom({}))).toThrow(/type 'custom' needs "driver"/);
      expect(() => createStorage(custom({ driver: 'nope' }))).toThrow(/type 'custom' needs "driver"/);
      expect(() => createStorage(custom({ driver: null }))).toThrow(/type 'custom' needs "driver"/);
      expect(() => createStorage(custom({ driver: 42 }))).toThrow(/type 'custom' needs "driver"/);
    });

    it('prefixes the errors of a multi-disk config with the disk name', () => {
      expect(() => createStorage({ default: 'a', disks: { a: custom({}) } })).toThrow(
        /^Storage disk "a": type 'custom' needs "driver"/,
      );
      expect(() =>
        createStorage({ default: 'a', disks: { a: { type: 'memory' }, b: custom({ driver: mapDriver(), wrap: 1 }) } }),
      ).toThrow(/^Storage disk "b": "wrap" must be a function/);
    });

    it('rejects a wrap that is not a function, on any type', () => {
      expect(() => createStorage({ type: 'memory', wrap: 'x' } as any)).toThrow(/"wrap" must be a function/);
      expect(() => createStorage(custom({ driver: mapDriver(), wrap: {} }))).toThrow(/"wrap" must be a function/);
    });

    it('checks a driver instance at createStorage time, naming the missing methods', () => {
      expect(() => createStorage(custom({ driver: { readFile: async () => Buffer.alloc(0) } }))).toThrow(
        'the driver is missing the required methods mkdir, readdir, rmdir, stat, exists, writeFile, rm, copyFile, rename',
      );
      const { exists: _exists, ...almost } = mapDriver();
      expect(() => createStorage(custom({ driver: almost }))).toThrow(
        'the driver is missing the required method exists',
      );
      expect(() => createStorage(custom({ driver: almost, wrap: (inner: StorageDriver) => inner }))).toThrow(
        'missing the required method exists',
      );
      expect(() =>
        createStorage({ default: 'a', disks: { a: { type: 'memory' }, b: custom({ driver: {} }) } }),
      ).toThrow(/^Storage disk "b": the driver is missing the required/);
    });

    it('checks a factory only when it is first used, naming the missing methods', async () => {
      const factory = jest.fn(() => ({ readFile: async () => Buffer.alloc(0) }));
      const storage = createStorage(custom({ driver: factory }));
      expect(factory).not.toHaveBeenCalled();
      await expect(storage.readFile('a')).rejects.toThrow(
        'the driver is missing the required methods mkdir, readdir, rmdir, stat, exists, writeFile, rm, copyFile, rename',
      );
      const { exists: _exists, ...almost } = mapDriver();
      const one = createStorage(custom({ driver: () => almost }));
      await expect(one.exists('a')).rejects.toThrow('the driver is missing the required method exists');
      expect(() => one.createReadStream('a')).toThrow('missing the required method exists');
    });

    it('names the disk in the missing-methods error of a factory in a multi-disk config', async () => {
      const storage = createStorage({
        default: 'a',
        disks: { a: { type: 'memory' }, b: custom({ driver: () => ({}) }) },
      });
      await expect(storage.disk('b').stat('x')).rejects.toThrow(
        /^Storage disk "b": the driver is missing the required/,
      );
      await expect(storage.init()).rejects.toThrow(/^Storage disk "b": /);
    });

    it('rejects a factory that returns something else than a driver', async () => {
      const storage = createStorage(custom({ driver: () => undefined }));
      await expect(storage.exists('a')).rejects.toThrow(
        'the driver must be an object implementing the required methods',
      );
    });

    it('checks the result of wrap as well', async () => {
      const storage = createStorage({ type: 'memory', wrap: () => ({ readFile: async () => Buffer.alloc(0) } as any) });
      await expect(storage.exists('a')).rejects.toThrow('the driver is missing the required methods');
    });
  });

  it('works through the Nest module (single disk and multi-disk, sync and async)', async () => {
    const calls: string[] = [];
    const driver: StorageDriver = {
      ...mapDriver(),
      init: async () => void calls.push('init'),
      destroy: async () => void calls.push('destroy'),
    };
    const single = await Test.createTestingModule({
      imports: [StorageModule.forRoot({ type: 'custom', driver })],
    }).compile();
    await single.init();
    expect(calls).toEqual(['init']);
    await single.get(StorageService).writeFile('a.txt', 'nest');
    expect(await single.get(StorageService).readFile('a.txt', 'utf8')).toBe('nest');
    await single.close();
    expect(calls).toEqual(['init', 'destroy']);

    const factory = jest.fn(() => mapDriver());
    const multi = await Test.createTestingModule({
      imports: [
        StorageModule.forRootAsync({
          disks: ['c'],
          useFactory: async () => ({
            default: 'm',
            disks: { m: { type: 'memory' as const }, c: { type: 'custom' as const, driver: factory } },
          }),
        }),
      ],
    }).compile();
    await multi.init();
    expect(factory).toHaveBeenCalledTimes(1);
    const storage = multi.get(StorageService);
    await storage.disk('c').writeFile('b.txt', 'custom');
    expect(await storage.disk('c').readFile('b.txt', 'utf8')).toBe('custom');
    expect(await storage.exists('b.txt')).toBe(false);
    await multi.close();
  });
});

describe('custom disk: a minimal driver (no streams, no signed URLs)', () => {
  const setup = (initial: Record<string, string> = {}) => {
    const driver = mapDriver(initial);
    return { driver, storage: createStorage({ type: 'custom', driver }) };
  };

  it('readFile and writeFile (strings, encodings, bytes)', async () => {
    const { storage, driver } = setup();
    await storage.writeFile('a.txt', 'héllo', 'latin1');
    expect(driver.files.get('a.txt')).toEqual(Buffer.from('héllo', 'latin1'));
    await storage.writeFile('b.bin', new Uint8Array([1, 2, 3]));
    expect(await storage.readFile('b.bin')).toEqual(Buffer.from([1, 2, 3]));
    expect(await storage.readFile('a.txt', 'latin1')).toBe('héllo');
  });

  it('createReadStream reads the whole file', async () => {
    const { storage } = setup({ 'a.txt': 'hello world' });
    expect((await collect(storage.createReadStream('a.txt'))).toString()).toBe('hello world');
  });

  it('createReadStream of an empty file ends', async () => {
    const { storage } = setup({ 'empty.txt': '' });
    expect(await collect(storage.createReadStream('empty.txt'))).toEqual(Buffer.alloc(0));
  });

  it('createReadStream applies start and end (inclusive), like fs', async () => {
    const { storage } = setup({ 'a.txt': 'hello world' });
    const read = async (options: object) => (await collect(storage.createReadStream('a.txt', options))).toString();
    expect(await read({ start: 2, end: 5 })).toBe('llo ');
    expect(await read({ start: 6 })).toBe('world');
    expect(await read({ end: 4 })).toBe('hello');
    expect(await read({ start: 3, end: 3 })).toBe('l');
    expect(await read({ start: 50 })).toBe('');
    expect(await read({ end: 500 })).toBe('hello world');
    expect(() => storage.createReadStream('a.txt', { start: 5, end: 2 })).toThrow(/out of range/);
  });

  it('createReadStream applies encoding and highWaterMark', async () => {
    const { storage } = setup({ 'a.txt': 'hello world' });
    const hex: unknown[] = [];
    for await (const chunk of storage.createReadStream('a.txt', { encoding: 'hex' })) hex.push(chunk);
    expect(hex).toEqual([Buffer.from('hello world').toString('hex')]);
    const sizes: number[] = [];
    const stream = storage.createReadStream('a.txt', { highWaterMark: 4 });
    for await (const chunk of stream) sizes.push((chunk as Buffer).length);
    expect(sizes).toEqual([4, 4, 3]);
  });

  it('createReadStream emits ENOENT and EISDIR as error events', async () => {
    const { storage } = setup();
    await storage.mkdir('dir');
    const missing = storage.createReadStream('nope.txt');
    const error = await nextError(missing);
    expect(util.types.isNativeError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'ENOENT', syscall: 'open', path: 'nope.txt' });
    expect(isStorageError(error, 'ENOENT')).toBe(true);
    expect(await nextError(storage.createReadStream('dir'))).toMatchObject({ code: 'EISDIR', path: 'dir' });
  });

  it('createWriteStream buffers and writes on finish, with the contentType', async () => {
    const { storage, driver } = setup();
    const out = storage.createWriteStream('w.txt', { contentType: 'text/x-test', mode: 0o600, flags: 'wx' });
    out.write('hello ');
    expect(driver.writes).toHaveLength(0);
    out.end(Buffer.from('world'));
    await once(out, 'finish');
    expect(driver.writes).toHaveLength(1);
    expect(driver.writes[0]).toMatchObject({
      path: 'w.txt',
      options: { contentType: 'text/x-test', mode: 0o600, flag: 'wx' },
    });
    expect(driver.files.get('w.txt')?.toString()).toBe('hello world');
  });

  it('createWriteStream decodes string chunks with the encoding', async () => {
    const { storage, driver } = setup();
    const out = storage.createWriteStream('l.txt', { encoding: 'latin1' });
    out.write('é');
    out.end('ÿ');
    await once(out, 'finish');
    expect(driver.files.get('l.txt')).toEqual(Buffer.from([0xe9, 0xff]));
    const utf8 = storage.createWriteStream('u.txt');
    utf8.end('é');
    await once(utf8, 'finish');
    expect(driver.files.get('u.txt')).toEqual(Buffer.from('é'));
  });

  it('createWriteStream emits the errors of writeFile and writes nothing when destroyed', async () => {
    const { storage, driver } = setup();
    const failing = storage.createWriteStream('fail.txt');
    failing.end('data');
    const error = await nextError(failing);
    expect(error).toMatchObject({ code: 'EACCES', path: 'fail.txt' });
    const aborted = storage.createWriteStream('aborted.txt');
    aborted.write('x');
    aborted.destroy();
    await once(aborted, 'close');
    expect(driver.files.has('aborted.txt')).toBe(false);
  });

  it('streams pipe from one disk to another', async () => {
    const { storage } = setup({ 'src.txt': 'piped' });
    const out = storage.createWriteStream('dst.txt');
    storage.createReadStream('src.txt').pipe(out);
    await once(out, 'finish');
    expect(await storage.readFile('dst.txt', 'utf8')).toBe('piped');
  });

  it('signed URLs are not supported (ERR_STORAGE_NOT_SUPPORTED)', async () => {
    const { storage } = setup();
    for (const [call, name] of [
      [() => storage.getSignedUrl('a.txt'), 'getSignedUrl'],
      [() => storage.getSignedPutUrl('a.txt'), 'getSignedPutUrl'],
    ] as const) {
      const error = await call().then(
        () => undefined,
        (e) => e,
      );
      expect(isStorageError(error, 'ERR_STORAGE_NOT_SUPPORTED')).toBe(true);
      expect(error.message).toBe(`${name} is not supported by this disk`);
      expect(error.syscall).toBe(name);
    }
  });

  it('uses the stream and signed URL methods of the driver when it has them', async () => {
    const driver: StorageDriver = {
      ...mapDriver({ 'a.txt': 'x' }),
      getSignedUrl: async (p) => `https://example.test/${p}`,
      getSignedPutUrl: async (p, o) => `https://example.test/put/${p}?type=${o.contentType}`,
    };
    const storage = createStorage({ type: 'custom', driver });
    expect(await storage.getSignedUrl('a.txt')).toBe('https://example.test/a.txt');
    expect(await storage.getSignedPutUrl('a.txt', { contentType: 'text/plain' })).toBe(
      'https://example.test/put/a.txt?type=text/plain',
    );
  });
});

describeBackends('signed URLs of the built-in disks', (backend) => {
  if (backend.isS3) return;
  const h = useCtx(backend, 'signed-urls');

  it('are not supported, with the same typed error everywhere', async () => {
    for (const call of [() => h.ctx.service.getSignedUrl('a.txt'), () => h.ctx.service.getSignedPutUrl('a.txt')]) {
      const error = await call().then(
        () => undefined,
        (e) => e,
      );
      expect(isStorageError(error, 'ERR_STORAGE_NOT_SUPPORTED')).toBe(true);
      expect(error.code).toBe('ERR_STORAGE_NOT_SUPPORTED');
    }
  });
});

describe('error helpers', () => {
  it('createFsError builds the error shape of the built-in drivers', async () => {
    const error = createFsError('ENOENT', 'open', '/a/b', '/c');
    expect(util.types.isNativeError(error)).toBe(true);
    expect(error).toMatchObject({ code: 'ENOENT', errno: -2, syscall: 'open', path: '/a/b', dest: '/c' });
    expect(error.message).toBe("ENOENT: no such file or directory, open '/a/b' -> '/c'");
    expect(isStorageError(error)).toBe(true);
    expect(isStorageError(error, 'ENOENT')).toBe(true);
    expect(isStorageError(error, 'EEXIST')).toBe(false);
    expect(createFsError('EACCES', 'mkdir')).not.toHaveProperty('path');
  });

  it('createRmDirectoryError is what fs.rm throws for a directory', () => {
    const error = createRmDirectoryError('/dir');
    expect(isStorageError(error, 'ERR_FS_EISDIR')).toBe(true);
    expect(error).toMatchObject({ syscall: 'rm', path: '/dir' });
  });

  it('errors of a custom driver pass through StorageDisk and the shared error check unchanged', async () => {
    const storage = createStorage({ type: 'custom', driver: mapDriver() });
    const error = await expectFsError(storage.readFile('missing.txt'), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'open',
      path: 'missing.txt',
    });
    expect(isStorageError(error, 'ENOENT')).toBe(true);
    await expectFsError(storage.stat('missing.txt'), { code: 'ENOENT', syscall: 'stat', path: 'missing.txt' });
  });

  it('createStats builds a StorageStats', () => {
    const mtime = new Date(1000);
    const file = createStats({ mode: fs.constants.S_IFREG | 0o644, size: 1024, mtime });
    expect(file.isFile()).toBe(true);
    expect(file.isDirectory()).toBe(false);
    expect(file).toMatchObject({ size: 1024, mtime, atime: mtime, uid: 0, gid: 0, blocks: 2 });
    expect(createStats({ mode: fs.constants.S_IFDIR | 0o755, size: 0, mtime }).isDirectory()).toBe(true);
  });
});

describeBackends('wrap', (backend) => {
  if (backend.name !== 'fileSystem' && backend.name !== 'memory') return;

  it('applies a read-only wrapper: reads work, writes throw EACCES', async () => {
    const wrap = jest.fn(readOnly);
    const h = await createCtx(backend, 'wrap-seed');
    await h.service.writeFile('a.txt', 'seeded');
    try {
      // a second storage on the same data (the fileSystem prefix, or a memory volume of its own for 'memory')
      const options: any =
        backend.name === 'memory'
          ? { type: 'memory', files: { 'a.txt': 'seeded' }, wrap }
          : { type: 'fileSystem', prefix: h.prefix, wrap };
      const storage = createStorage(options);
      expect(wrap).not.toHaveBeenCalled();
      expect(await storage.readFile('a.txt', 'utf8')).toBe('seeded');
      expect(await storage.exists('a.txt')).toBe(true);
      expect((await collect(storage.createReadStream('a.txt'))).toString()).toBe('seeded');
      await expectFsError(storage.writeFile('b.txt', 'x'), {
        code: 'EACCES',
        errno: -13,
        syscall: 'open',
        path: 'b.txt',
      });
      await expectFsError(storage.mkdir('d'), { code: 'EACCES', syscall: 'open' });
      await expectFsError(storage.rm('a.txt'), { code: 'EACCES', syscall: 'open' });
      await expectFsError(storage.rename('a.txt', 'c.txt'), { code: 'EACCES', syscall: 'open', path: 'c.txt' });
      const out = storage.createWriteStream('s.txt');
      out.end('x');
      expect(isStorageError(await nextError(out), 'EACCES')).toBe(true);
      expect(await storage.readFile('a.txt', 'utf8')).toBe('seeded');
      expect(await storage.exists('b.txt')).toBe(false);
      expect(wrap).toHaveBeenCalledTimes(1);
      await storage.destroy();
    } finally {
      await h.close();
    }
  });

  it('applies a transforming wrapper ("encryption") to files and streams, once and lazily', async () => {
    const h = await createCtx(backend, 'wrap-xor');
    const wrap = jest.fn(encrypt);
    try {
      const options: any =
        backend.name === 'memory' ? { type: 'memory', wrap } : { type: 'fileSystem', prefix: h.prefix, wrap };
      const storage = createStorage(options);
      await storage.destroy(); // does not create the wrapper
      expect(wrap).not.toHaveBeenCalled();

      await storage.writeFile('secret.txt', 'attack at dawn');
      expect(wrap).toHaveBeenCalledTimes(1);
      expect(await storage.readFile('secret.txt', 'utf8')).toBe('attack at dawn');

      const out = storage.createWriteStream('streamed.txt');
      out.write('via ');
      out.end('stream');
      await once(out, 'finish');
      expect((await collect(storage.createReadStream('streamed.txt'))).toString()).toBe('via stream');
      expect((await collect(storage.createReadStream('streamed.txt', { start: 4 }))).toString()).toBe('stream');
      expect(await storage.readdir('')).toEqual(expect.arrayContaining(['secret.txt', 'streamed.txt']));
      expect(wrap).toHaveBeenCalledTimes(1);

      // what the backend holds is the XORed content
      if (backend.name === 'fileSystem') {
        const plain = createStorage({ type: 'fileSystem', prefix: h.prefix });
        expect(await plain.readFile('secret.txt')).toEqual(xor(Buffer.from('attack at dawn')));
      }
      await storage.destroy();
    } finally {
      await h.close();
    }
  });

  it('wrap works in a multi-disk config and receives the built-in driver', async () => {
    const seen: StorageDriver[] = [];
    const storage = createStorage({
      default: 'a',
      disks: {
        a: { type: 'memory' },
        b: {
          type: 'memory',
          wrap: (inner) => {
            seen.push(inner);
            return encrypt(inner);
          },
        },
      },
    });
    await storage.disk('b').writeFile('x.txt', 'x');
    await storage.disk('b').readFile('x.txt');
    expect(seen).toHaveLength(1);
    expect(typeof seen[0].mkdir).toBe('function');
    expect(await seen[0].readFile('x.txt', {})).toEqual(xor(Buffer.from('x')));
    await storage.destroy();
  });

  it('wrap can also wrap a custom driver (instance or factory)', async () => {
    const inner = mapDriver();
    const storage = createStorage({ type: 'custom', driver: () => inner, wrap: encrypt });
    await storage.writeFile('a.txt', 'abc');
    expect(inner.files.get('a.txt')).toEqual(xor(Buffer.from('abc')));
    expect(await storage.readFile('a.txt', 'utf8')).toBe('abc');
  });

  describe('init and destroy with a wrapper', () => {
    const tracked = () => {
      const calls: string[] = [];
      const inner: StorageDriver = {
        ...mapDriver(),
        init: async () => void calls.push('inner init'),
        destroy: async () => void calls.push('inner destroy'),
      };
      return { calls, inner };
    };
    // A wrapper that forwards everything except init and destroy (they are left out)
    const without = (inner: StorageDriver) => delegate(inner, { init: undefined, destroy: undefined });
    const withOwn = (calls: string[]) => (inner: StorageDriver) =>
      delegate(inner, {
        init: async () => void calls.push('wrapper init'),
        destroy: async () => void calls.push('wrapper destroy'),
      });

    it('call the ones of the inner driver when the wrapper has none', async () => {
      const { calls, inner } = tracked();
      const storage = createStorage({ type: 'custom', driver: inner, wrap: without });
      await storage.init();
      await storage.destroy();
      expect(calls).toEqual(['inner init', 'inner destroy']);
    });

    it('call only the ones of the wrapper when it has them (it forwards if it wants to)', async () => {
      const { calls, inner } = tracked();
      const storage = createStorage({ type: 'custom', driver: inner, wrap: withOwn(calls) });
      await storage.init();
      await storage.destroy();
      expect(calls).toEqual(['wrapper init', 'wrapper destroy']);
    });

    it('a wrapper that forwards them reaches the inner driver once', async () => {
      const { calls, inner } = tracked();
      const storage = createStorage({ type: 'custom', driver: () => inner, wrap: encrypt });
      await storage.init();
      await storage.destroy();
      expect(calls).toEqual(['inner init', 'inner destroy']);
    });

    it('destroy closes the built-in driver of a wrapped disk although the wrapper has no destroy', async () => {
      const wrap = jest.fn(without);
      const storage = createStorage({
        type: 'fileSystem',
        prefix: fs.mkdtempSync(path.join(os.tmpdir(), 'wrap-')),
        wrap,
      });
      await storage.exists('a.txt');
      expect(wrap).toHaveBeenCalledTimes(1);
      const destroy = jest.spyOn((storage as any).source.builtin as StorageDriver, 'destroy');
      await storage.destroy();
      expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('destroy never creates the wrapper, but still closes the built-in driver', async () => {
      const wrap = jest.fn(without);
      const storage = createStorage({ type: 'fileSystem', wrap });
      const destroy = jest.spyOn((storage as any).source.builtin as StorageDriver, 'destroy');
      await storage.destroy();
      expect(wrap).not.toHaveBeenCalled();
      expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('destroy never creates a custom factory or its wrapper', async () => {
      const factory = jest.fn(() => tracked().inner);
      const wrap = jest.fn(without);
      const storage = createStorage({ type: 'custom', driver: factory, wrap });
      await storage.destroy();
      expect(factory).not.toHaveBeenCalled();
      expect(wrap).not.toHaveBeenCalled();
    });

    it('init of a built-in disk calls the wrapper init, else the built-in one', async () => {
      const own = jest.fn(async () => undefined);
      const a = createStorage({ type: 'fileSystem', wrap: (inner) => delegate(inner, { init: own }) });
      await a.init();
      expect(own).toHaveBeenCalledTimes(1);
      const b = createStorage({ type: 'fileSystem', wrap: without });
      const builtinInit = jest.spyOn((b as any).source.builtin as StorageDriver, 'init');
      await b.init();
      expect(builtinInit).toHaveBeenCalledTimes(1);
    });
  });
});

describeS3('wrap on S3', () => {
  it('s3client still returns the client of a wrapped S3 disk', async () => {
    const wrap = jest.fn(readOnly);
    const storage = createStorage(s3Options(`e2e/wrap-${Date.now()}`, { wrap }));
    try {
      expect(wrap).not.toHaveBeenCalled();
      expect(await storage.exists('missing.txt')).toBe(false);
      expect(wrap).toHaveBeenCalledTimes(1);
      expect(storage.s3client).toBeDefined();
      expect(typeof storage.s3client!.send).toBe('function');
      await expectFsError(storage.writeFile('a.txt', 'x'), { code: 'EACCES', syscall: 'open' });
      // signed URLs of the S3 driver are forwarded by the wrapper
      expect(await storage.getSignedUrl('a.txt')).toContain('a.txt');
    } finally {
      await storage.destroy();
    }
  });
});
