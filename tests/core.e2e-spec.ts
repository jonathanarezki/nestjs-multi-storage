import { S3Client } from '@aws-sdk/client-s3';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createStorage, Storage, StorageConfig, StorageDisk, StorageModuleOptions } from '@webbar/node-multi-storage';
import {
  Backend,
  describeBackends,
  describeFtp,
  describeS3,
  describeSftp,
  FTP_SERVER,
  ftpOptions,
  s3Options,
  SFTP_SERVER,
  sftpOptions,
} from './support/harness';

const memory = { type: 'memory' as const };

/** Options of a disk of `backend` below a fresh prefix. Remote prefixes are not created: no test needs them to exist. */
function optionsFor(backend: Backend, overrides: Partial<StorageModuleOptions> = {}): StorageModuleOptions {
  const unique = `core-${randomUUID().slice(0, 8)}`;
  switch (backend.name) {
    case 's3':
      return s3Options(`e2e/${unique}`, overrides);
    case 'ftp':
      return ftpOptions(path.posix.join(FTP_SERVER.dir, 'e2e', unique), overrides);
    case 'sftp':
      return sftpOptions(path.posix.join(SFTP_SERVER.dir, 'e2e', unique), overrides);
    case 'memory':
      return { type: 'memory', prefix: `/e2e/${unique}`, ...overrides };
    default:
      return {
        type: 'fileSystem',
        prefix: fs.mkdtempSync(path.join(os.tmpdir(), 'node-multi-storage-core-')),
        ...overrides,
      };
  }
}

/** Removes what a test left on the backend, then closes the storage. */
async function cleanup(storage: Storage, backend: Backend, options: StorageModuleOptions) {
  if (backend.name !== 'fileSystem' && backend.name !== 'memory') await storage.rmdir('').catch(() => undefined);
  await storage.destroy();
  if (backend.name === 'fileSystem') fs.rmSync(options.prefix!, { recursive: true, force: true });
}

const driverOf = (disk: StorageDisk): any => (disk as any).source.get();

describe('createStorage: configuration', () => {
  it('a single-store config is the disk named "default"', async () => {
    const storage = createStorage({ ...memory, prefix: '/single' });
    expect(storage).toBeInstanceOf(StorageDisk);
    expect(storage.diskNames).toEqual(['default']);
    await storage.writeFile('a.txt', 'hello');
    expect(await storage.readFile('a.txt', 'utf8')).toBe('hello');
    // the named disk shares its storage with the instance
    expect(await storage.disk('default').readFile('a.txt', 'utf8')).toBe('hello');
    await storage.destroy();
  });

  it('a multi-disk config: the default disk is the instance, the others are named disks with their own storage', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-multi-storage-core-'));
    try {
      const storage = createStorage({ default: 'a', disks: { a: memory, b: { type: 'fileSystem', prefix: tmp } } });
      expect(storage.diskNames).toEqual(['a', 'b']);
      await storage.writeFile('x.txt', 'in a');
      await storage.disk('b').writeFile('x.txt', 'in b');
      expect(await storage.disk('a').readFile('x.txt', 'utf8')).toBe('in a');
      expect(fs.readFileSync(path.join(tmp, 'x.txt'), 'utf8')).toBe('in b');
      expect(storage.disk('b')).toBe(storage.disk('b'));
      expect(storage.disk('b')).not.toBeInstanceOf(Storage);
      await storage.destroy();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('an unknown disk name throws, listing the configured disks', () => {
    const storage = createStorage({ default: 'a', disks: { a: memory, b: memory } });
    expect(() => storage.disk('nope')).toThrow('Unknown storage disk "nope". Configured disks: a, b');
    expect(() => storage.disk('toString')).toThrow('Unknown storage disk "toString"');
  });

  it.each([
    [{ default: 'a', disks: {} }, 'Storage "disks" must be a non-empty object of named disk configurations'],
    [{ default: 'x', disks: { a: memory } }, 'Storage "default" must be the name of a configured disk (a), got "x"'],
    [{ disks: { a: memory } }, 'Storage "default" must be the name of a configured disk (a), got undefined'],
    [{ default: '', disks: { '': memory } }, 'Storage disk names must not be empty'],
    [{ default: 'a', disks: { a: 'memory' } }, 'Storage disk "a" must be a configuration object'],
    [{ default: 'a', disks: { a: { type: 'ftp' } } }, `Storage disk "a": type 'ftp' requires "host"`],
    [{ type: 'sftp', host: 'h' }, `type 'sftp' requires "hostKey"`],
  ])('the invalid config %j throws at creation: %s', (config, message) => {
    expect(() => createStorage(config as unknown as StorageConfig)).toThrow(message);
  });
});

describeBackends('createStorage: no init() needed', (backend) => {
  it('the first operation works on a storage that was never initialized', async () => {
    const options = optionsFor(backend);
    const storage = createStorage(options);
    try {
      if (backend.isS3) expect(storage.s3client).toBeUndefined();
      await storage.mkdir('');
      await storage.writeFile('a.txt', 'hello');
      expect(await storage.readFile('a.txt', 'utf8')).toBe('hello');
      expect(await storage.readdir('')).toEqual(['a.txt']);
      if (backend.isS3) expect(storage.s3client).toBeDefined();
    } finally {
      await cleanup(storage, backend, options);
    }
  });

  it('init() is an optional warm-up and may be repeated', async () => {
    const options = optionsFor(backend);
    const storage = createStorage(options);
    try {
      await storage.init();
      await storage.init();
      if (backend.isS3) expect(storage.s3client).toBeDefined();
      await storage.mkdir('');
      await storage.writeFile('a.txt', 'x');
      expect(await storage.exists('a.txt')).toBe(true);
    } finally {
      await cleanup(storage, backend, options);
    }
  });

  it('streams and signed URLs also work as first operation', async () => {
    const options = optionsFor(backend);
    const storage = createStorage(options);
    try {
      if (backend.isS3) {
        // the signed URL needs the client: created on demand, no request is sent
        expect(await storage.getSignedUrl('a.txt')).toContain('a.txt');
        expect(await storage.getSignedPutUrl('a.txt')).toContain('a.txt');
      }
      await storage.mkdir('');
      const out = storage.createWriteStream('s.txt');
      await new Promise<void>((resolve, reject) => out.once('error', reject).once('finish', resolve).end('streamed'));
      const chunks: Buffer[] = [];
      for await (const chunk of storage.createReadStream('s.txt')) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('streamed');
    } finally {
      await cleanup(storage, backend, options);
    }
  });

  it('an S3 read stream as the very first operation (no prior client)', async () => {
    if (!backend.isS3) return;
    const options = optionsFor(backend);
    const seed = createStorage(options);
    await seed.writeFile('r.txt', 'seeded');
    await seed.destroy();
    const storage = createStorage(options);
    try {
      expect(storage.s3client).toBeUndefined();
      const chunks: Buffer[] = [];
      for await (const chunk of storage.createReadStream('r.txt')) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('seeded');
    } finally {
      await cleanup(storage, backend, options);
    }
  });
});

describe('use after destroy: filesystem and memory', () => {
  it('keeps working (nothing to release); a memory disk keeps its content', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'node-multi-storage-core-'));
    try {
      const storage = createStorage({ default: 'm', disks: { m: memory, f: { type: 'fileSystem', prefix: tmp } } });
      await storage.writeFile('a.txt', 'one');
      await storage.disk('f').writeFile('a.txt', 'two');
      await storage.destroy();
      expect(await storage.readFile('a.txt', 'utf8')).toBe('one');
      await storage.disk('f').writeFile('b.txt', 'three');
      expect(await storage.disk('f').readFile('a.txt', 'utf8')).toBe('two');
      await storage.destroy();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('destroy(): multi-disk', () => {
  it('destroys every disk, and rethrows the first failure after all of them were destroyed', async () => {
    const storage = createStorage({ default: 'a', disks: { a: memory, b: memory, c: memory } });
    const spies = ['a', 'b', 'c'].map((name) => jest.spyOn(driverOf(storage.disk(name)), 'destroy'));
    spies[1].mockRejectedValue(new Error('b failed'));
    await expect(storage.destroy()).rejects.toThrow('b failed');
    spies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
  });

  it('init() initializes every disk', async () => {
    const storage = createStorage({ default: 'a', disks: { a: memory, b: memory } });
    const spies = ['a', 'b'].map((name) => jest.spyOn(driverOf(storage.disk(name)), 'init'));
    await storage.init();
    spies.forEach((spy) => expect(spy).toHaveBeenCalledTimes(1));
  });
});

describeS3('S3 lifecycle without Nest', () => {
  const backend = { name: 's3', isS3: true, enabled: true } as Backend;

  it('concurrent first operations create exactly one client', async () => {
    const options = optionsFor(backend);
    const storage = createStorage(options);
    const senders = new Set<unknown>();
    const send = S3Client.prototype.send;
    const spy = jest.spyOn(S3Client.prototype, 'send').mockImplementation(function (this: S3Client, ...args: any[]) {
      senders.add(this);
      return (send as any).apply(this, args);
    });
    try {
      expect(storage.s3client).toBeUndefined();
      await Promise.all([
        ...Array.from({ length: 8 }, (_, i) => storage.exists(`x${i}`)),
        storage.writeFile('w.txt', 'w'),
        storage.getSignedUrl('w.txt'),
      ]);
      expect(senders.size).toBe(1);
      expect(senders.has(storage.s3client)).toBe(true);
    } finally {
      spy.mockRestore();
      await cleanup(storage, backend, options);
    }
  });

  it('destroy() destroys the client; a later operation creates a new one', async () => {
    const options = optionsFor(backend);
    const storage = createStorage(options);
    try {
      await storage.writeFile('a.txt', 'one');
      const first = storage.s3client!;
      const destroy = jest.spyOn(first, 'destroy');
      await storage.destroy();
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(storage.s3client).toBeUndefined();

      expect(await storage.readFile('a.txt', 'utf8')).toBe('one');
      expect(storage.s3client).toBeDefined();
      expect(storage.s3client).not.toBe(first);
      // destroying twice is harmless
      await storage.destroy();
      await storage.destroy();
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      await cleanup(storage, backend, options);
    }
  });
});

describeFtp('FTP lifecycle without Nest', () => {
  const backend = { name: 'ftp', isS3: false, enabled: true } as Backend;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require('basic-ftp') as typeof import('basic-ftp');

  it.each([
    [1, 1],
    [2, 2],
  ])('concurrent first operations open the connections up to maxConnections (%i -> %i)', async (max, expected) => {
    const options = optionsFor(backend, { maxConnections: max });
    const storage = createStorage(options);
    const access = jest.spyOn(Client.prototype, 'access');
    try {
      await Promise.all(Array.from({ length: 10 }, (_, i) => storage.exists(`x${i}`)));
      expect(access).toHaveBeenCalledTimes(expected);
    } finally {
      access.mockRestore();
      await cleanup(storage, backend, options);
    }
  });

  it('destroy() closes the connections; a later operation reconnects, and nothing leaks', async () => {
    const options = optionsFor(backend);
    const storage = createStorage(options);
    const access = jest.spyOn(Client.prototype, 'access');
    const close = jest.spyOn(Client.prototype, 'close');
    try {
      await storage.exists('a');
      expect(access).toHaveBeenCalledTimes(1);
      const before = close.mock.calls.length;
      await storage.destroy();
      expect(close.mock.calls.length).toBeGreaterThan(before);
      expect(await storage.exists('a')).toBe(false);
      expect(access).toHaveBeenCalledTimes(2);
      // destroying twice is harmless, and the storage keeps working
      await storage.destroy();
      await storage.destroy();
      expect(await storage.exists('a')).toBe(false);
      expect(access).toHaveBeenCalledTimes(3);
      // every connection ever opened is closed once the last destroy has run
      await storage.destroy();
      const opened = access.mock.contexts as any[];
      expect(opened.every((client) => client.closed)).toBe(true);
    } finally {
      access.mockRestore();
      close.mockRestore();
    }
  });
});

describeSftp('SFTP lifecycle without Nest', () => {
  const backend = { name: 'sftp', isS3: false, enabled: true } as Backend;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Client } = require('ssh2') as typeof import('ssh2');

  it('concurrent first operations open exactly one connection', async () => {
    const options = optionsFor(backend);
    const storage = createStorage(options);
    const connect = jest.spyOn(Client.prototype, 'connect');
    try {
      await Promise.all(Array.from({ length: 10 }, (_, i) => storage.exists(`x${i}`)));
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      connect.mockRestore();
      await cleanup(storage, backend, options);
    }
  });

  it('destroy() ends the connection; a later operation reconnects', async () => {
    const options = optionsFor(backend);
    const storage = createStorage(options);
    const end = jest.spyOn(Client.prototype, 'end');
    const connect = jest.spyOn(Client.prototype, 'connect');
    try {
      await storage.exists('a');
      await storage.destroy();
      expect(end).toHaveBeenCalledTimes(1);
      await storage.mkdir('');
      await storage.writeFile('a.txt', 'again');
      expect(await storage.readFile('a.txt', 'utf8')).toBe('again');
      expect(connect).toHaveBeenCalledTimes(2);
    } finally {
      end.mockRestore();
      connect.mockRestore();
      await cleanup(storage, backend, options);
    }
  });
});

describe('the core does not load Nest', () => {
  it('requiring the built core, and using it, puts no @nestjs module in the require cache', () => {
    const entry = path.resolve(__dirname, '../packages/core/dist/index.js');
    if (!fs.existsSync(entry)) throw new Error(`${entry} is missing: run "npm run build" first`);
    const script = `
      const { createStorage } = require(${JSON.stringify(entry)});
      (async () => {
        const storage = createStorage({ type: 'memory' });
        await storage.writeFile('a.txt', 'x');
        await storage.readFile('a.txt');
        await storage.destroy();
        const nest = Object.keys(require.cache).filter((file) => file.includes('/@nestjs/'));
        console.log(JSON.stringify(nest));
      })();`;
    const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    expect(JSON.parse(output)).toEqual([]);
  });

  it('puts no @aws-sdk module in the require cache until an s3 disk is created', () => {
    const entry = path.resolve(__dirname, '../packages/core/dist/index.js');
    if (!fs.existsSync(entry)) throw new Error(`${entry} is missing: run "npm run build" first`);
    const script = `
      const { createStorage } = require(${JSON.stringify(entry)});
      const sdk = () => Object.keys(require.cache).filter((file) => file.includes('/@aws-sdk/')).length;
      (async () => {
        const storage = createStorage({ type: 'memory' });
        await storage.writeFile('a.txt', 'x');
        await storage.readFile('a.txt');
        await storage.destroy();
        const afterMemory = sdk();
        createStorage({ default: 'm', disks: { m: { type: 'memory' }, f: { type: 'fileSystem' } } });
        const afterOthers = sdk();
        createStorage({ type: 's3', bucket: 'b' });
        console.log(JSON.stringify({ afterMemory, afterOthers, afterS3: sdk() }));
      })();`;
    const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
    const counts = JSON.parse(output);
    expect(counts).toMatchObject({ afterMemory: 0, afterOthers: 0 });
    expect(counts.afterS3).toBeGreaterThan(0);
  });

  it('declares no Nest dependency', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../packages/core/package.json'), 'utf8'));
    const names = Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.devDependencies });
    expect(names.filter((name) => name.includes('nest') || name === 'rxjs' || name === 'reflect-metadata')).toEqual([]);
  });

  it('declares the AWS SDK as optional peer dependencies, not dependencies', () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../packages/core/package.json'), 'utf8'));
    for (const name of ['@aws-sdk/client-s3', '@aws-sdk/lib-storage', '@aws-sdk/s3-request-presigner']) {
      expect(manifest.dependencies[name]).toBeUndefined();
      expect(manifest.peerDependencies[name]).toBeDefined();
      expect(manifest.peerDependenciesMeta[name]).toEqual({ optional: true });
    }
  });
});
