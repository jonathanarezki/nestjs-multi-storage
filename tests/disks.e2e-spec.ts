import 'reflect-metadata';
import { CreateBucketCommand, DeleteBucketCommand } from '@aws-sdk/client-s3';
import { Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getStorageToken,
  InjectStorage,
  StorageConfig,
  StorageDisk,
  StorageModule,
  StorageMultiDiskOptions,
  StorageService,
} from '../lib';
import { collect, describeS3, rawKeys, s3Options } from './support/harness';

const memory = { type: 'memory' as const };

/** The file API every disk (and so the service) must have: the 0.5.1 StorageService methods plus `s3client`. */
const FILE_API_METHODS = [
  'copyFile',
  'createReadStream',
  'createWriteStream',
  'exists',
  'getSignedPutUrl',
  'getSignedUrl',
  'mkdir',
  'readFile',
  'readdir',
  'rename',
  'rm',
  'rmdir',
  'stat',
  'writeFile',
];

@Injectable()
class Consumer {
  constructor(@InjectStorage('x') public readonly x: StorageDisk, @InjectStorage('y') public readonly y: StorageDisk) {}
}

@Injectable()
class DiskConfig {
  constructor(public readonly config: StorageMultiDiskOptions) {}
}

function diskConfigModule(config: StorageMultiDiskOptions) {
  @Module({ providers: [{ provide: DiskConfig, useValue: new DiskConfig(config) }], exports: [DiskConfig] })
  class DiskConfigModule {}
  return DiskConfigModule;
}

describe('multi-disk: mixed backends in one app', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nestjs-multi-storage-mixed-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('memory and fileSystem disks write, read and list independently; the same path holds different content', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRoot({
          default: 'mem',
          disks: { mem: memory, local: { type: 'fileSystem', prefix: tmp }, other: memory },
        }),
      ],
    }).compile();
    await moduleRef.init();
    const storage = moduleRef.get(StorageService);
    const [mem, local, other] = [storage.disk('mem'), storage.disk('local'), storage.disk('other')];

    await mem.writeFile('same.txt', 'in memory');
    await local.writeFile('same.txt', 'on disk');
    await other.writeFile('same.txt', 'other memory');
    await mem.mkdir('only-mem');
    await mem.writeFile('only-mem/a.txt', 'a');
    await local.mkdir('only-local');
    await local.writeFile('only-local/b.txt', 'b');

    expect(await mem.readFile('same.txt', 'utf8')).toBe('in memory');
    expect(await local.readFile('same.txt', 'utf8')).toBe('on disk');
    expect(await other.readFile('same.txt', 'utf8')).toBe('other memory');
    expect(fs.readFileSync(path.join(tmp, 'same.txt'), 'utf8')).toBe('on disk');

    expect((await mem.readdir('')).sort()).toEqual(['only-mem', 'same.txt']);
    expect((await local.readdir('')).sort()).toEqual(['only-local', 'same.txt']);
    expect(await other.readdir('')).toEqual(['same.txt']);
    expect(await mem.exists('only-local/b.txt')).toBe(false);
    expect(await local.exists('only-mem/a.txt')).toBe(false);

    await mem.rm('same.txt');
    expect(await mem.exists('same.txt')).toBe(false);
    expect(await local.exists('same.txt')).toBe(true);
    expect(await other.exists('same.txt')).toBe(true);
    await moduleRef.close();
  });

  describeS3('with S3 disks', () => {
    let bucket2: string;
    let moduleRef: Awaited<ReturnType<typeof build>>;
    const prefix = () => `e2e/disks-${randomUUID().slice(0, 8)}`;

    async function build(config: StorageMultiDiskOptions) {
      const ref = await Test.createTestingModule({ imports: [StorageModule.forRoot(config)] }).compile();
      await ref.init();
      return ref;
    }

    afterEach(async () => {
      if (moduleRef) await moduleRef.close();
    });

    it('S3, memory and fileSystem disks side by side, each isolated', async () => {
      const s3Prefix = prefix();
      moduleRef = await build({
        default: 'mem',
        disks: {
          mem: memory,
          local: { type: 'fileSystem', prefix: tmp },
          remote: s3Options(s3Prefix),
        },
      });
      const storage = moduleRef.get(StorageService);
      const [mem, local, remote] = [storage.disk('mem'), storage.disk('local'), storage.disk('remote')];

      await mem.writeFile('same.txt', 'memory');
      await local.writeFile('same.txt', 'fs');
      await remote.writeFile('same.txt', 's3');
      await remote.writeFile('dir/deep.txt', 'deep');

      expect(await mem.readFile('same.txt', 'utf8')).toBe('memory');
      expect(await local.readFile('same.txt', 'utf8')).toBe('fs');
      expect(await remote.readFile('same.txt', 'utf8')).toBe('s3');
      expect(await mem.readdir('')).toEqual(['same.txt']);
      expect(await local.readdir('')).toEqual(['same.txt']);
      expect(await remote.readdir('', { recursive: true })).toEqual(['dir', 'dir/deep.txt', 'same.txt']);
      expect(await rawKeys(remote, `${s3Prefix}/`)).toEqual([`${s3Prefix}/dir/deep.txt`, `${s3Prefix}/same.txt`]);
      expect(mem.s3client).toBeUndefined();
      expect(local.s3client).toBeUndefined();
      expect(remote.s3client).toBeDefined();

      await remote.rmdir('');
    });

    it('two S3 disks (different prefixes, different buckets) are isolated and own distinct clients', async () => {
      bucket2 = `e2e-disks-${randomUUID().slice(0, 12)}`;
      const [p1, p2] = [prefix(), prefix()];
      moduleRef = await build({
        default: 'a',
        disks: {
          a: s3Options(p1),
          b: s3Options(p1, { bucket: bucket2 }),
          c: s3Options(p2),
        },
      });
      const storage = moduleRef.get(StorageService);
      const [a, b, c] = [storage.disk('a'), storage.disk('b'), storage.disk('c')];
      await a.s3client!.send(new CreateBucketCommand({ Bucket: bucket2 }));
      try {
        expect(a.s3client).not.toBe(b.s3client);
        expect(a.s3client).not.toBe(c.s3client);
        expect(b.s3client).not.toBe(c.s3client);
        // the default disk shares its client with the service
        expect(storage.s3client).toBe(a.s3client);

        await a.writeFile('f.txt', 'bucket test, prefix 1');
        await b.writeFile('f.txt', 'bucket 2');
        await c.writeFile('f.txt', 'bucket test, prefix 2');
        expect(await a.readFile('f.txt', 'utf8')).toBe('bucket test, prefix 1');
        expect(await b.readFile('f.txt', 'utf8')).toBe('bucket 2');
        expect(await c.readFile('f.txt', 'utf8')).toBe('bucket test, prefix 2');
        expect(await a.readdir('')).toEqual(['f.txt']);
        expect(await rawKeys(a, `${p1}/`)).toEqual([`${p1}/f.txt`]);
        expect(await rawKeys(a, `${p2}/`)).toEqual([`${p2}/f.txt`]);

        await b.rm('f.txt');
        expect(await b.exists('f.txt')).toBe(false);
        expect(await a.exists('f.txt')).toBe(true);
      } finally {
        await a.rmdir('').catch(() => undefined);
        await c.rmdir('').catch(() => undefined);
        await b.rmdir('').catch(() => undefined);
        await a.s3client!.send(new DeleteBucketCommand({ Bucket: bucket2 })).catch(() => undefined);
      }
    });

    it('creates each S3 client on init and destroys each one on close', async () => {
      const ref = await Test.createTestingModule({
        imports: [
          StorageModule.forRoot({
            default: 'a',
            disks: { a: s3Options(prefix()), b: s3Options(prefix()), mem: memory },
          }),
        ],
      }).compile();
      const storage = ref.get(StorageService);
      expect(storage.disk('a').s3client).toBeUndefined();
      expect(storage.disk('b').s3client).toBeUndefined();

      await ref.init();
      const [a, b] = [storage.disk('a').s3client!, storage.disk('b').s3client!];
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      expect(a).not.toBe(b);
      const [destroyA, destroyB] = [jest.spyOn(a, 'destroy'), jest.spyOn(b, 'destroy')];
      await storage.disk('a').writeFile('x', '1');
      expect(destroyA).not.toHaveBeenCalled();
      await storage.disk('a').rmdir('');

      await ref.close();
      expect(destroyA).toHaveBeenCalledTimes(1);
      expect(destroyB).toHaveBeenCalledTimes(1);
    });

    it('streams through an S3 disk while the default disk is something else', async () => {
      moduleRef = await build({ default: 'mem', disks: { mem: memory, remote: s3Options(prefix()) } });
      const remote = moduleRef.get(StorageService).disk('remote');
      const writer = remote.createWriteStream('s.bin');
      writer.end(Buffer.from('streamed'));
      await new Promise((resolve, reject) => writer.on('finish', resolve).on('error', reject));
      expect((await collect(remote.createReadStream('s.bin'))).toString()).toBe('streamed');
      await remote.rmdir('');
    });
  });
});

describe('multi-disk: access paths', () => {
  const build = async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot({ default: 'x', disks: { x: memory, y: memory } })],
      providers: [Consumer],
    }).compile();
    await moduleRef.init();
    return moduleRef;
  };

  it('the default disk is seen identically through StorageService, disk(), the token and @InjectStorage', async () => {
    const moduleRef = await build();
    const storage = moduleRef.get(StorageService);
    const views: StorageDisk[] = [
      storage,
      storage.disk('x'),
      moduleRef.get<StorageDisk>(getStorageToken('x')),
      moduleRef.get(Consumer).x,
    ];
    for (const [i, writer] of views.entries()) {
      await writer.writeFile(`from-${i}.txt`, `view ${i}`);
      for (const reader of views) {
        expect(await reader.readFile(`from-${i}.txt`, 'utf8')).toBe(`view ${i}`);
      }
    }
    for (const view of views) {
      expect((await view.readdir('')).sort()).toEqual(['from-0.txt', 'from-1.txt', 'from-2.txt', 'from-3.txt']);
    }
    // another disk sees none of it
    expect(await storage.disk('y').readdir('')).toEqual([]);
    await moduleRef.close();
  });

  it('a non-default disk is seen identically through disk(), the token and @InjectStorage (not through the service)', async () => {
    const moduleRef = await build();
    const storage = moduleRef.get(StorageService);
    const views: StorageDisk[] = [
      storage.disk('y'),
      moduleRef.get<StorageDisk>(getStorageToken('y')),
      moduleRef.get(Consumer).y,
    ];
    for (const [i, writer] of views.entries()) {
      await writer.writeFile(`from-${i}.txt`, `view ${i}`);
      for (const reader of views) {
        expect(await reader.readFile(`from-${i}.txt`, 'utf8')).toBe(`view ${i}`);
      }
    }
    expect(await storage.readdir('')).toEqual([]);
    expect(await storage.exists('from-0.txt')).toBe(false);
    await moduleRef.close();
  });

  it('disk(name) is memoised, and the token resolves to the same instance', async () => {
    const moduleRef = await build();
    const storage = moduleRef.get(StorageService);
    expect(storage.disk('x')).toBe(storage.disk('x'));
    expect(storage.disk('y')).toBe(storage.disk('y'));
    expect(storage.disk('x')).not.toBe(storage.disk('y'));
    expect(moduleRef.get(getStorageToken('x'))).toBe(storage.disk('x'));
    expect(moduleRef.get(Consumer).y).toBe(storage.disk('y'));
    await moduleRef.close();
  });

  it('disk(defaultName) is a plain StorageDisk: not the service, no disk() method', async () => {
    const moduleRef = await build();
    const storage = moduleRef.get(StorageService);
    const def = storage.disk('x');
    expect(def).toBeInstanceOf(StorageDisk);
    expect(def).not.toBe(storage);
    expect(def.constructor).toBe(StorageDisk);
    expect((def as any).disk).toBeUndefined();
    expect((def as any).diskNames).toBeUndefined();
    expect((def as any).onModuleInit).toBeUndefined();
    expect(storage).toBeInstanceOf(StorageDisk);
    expect(typeof storage.disk).toBe('function');
    await moduleRef.close();
  });

  it('single store: StorageService is the one disk named "default", disk("default") shares its data', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [StorageModule.forRoot(memory)] }).compile();
    await moduleRef.init();
    const storage = moduleRef.get(StorageService);
    await storage.writeFile('a', '1');
    expect(await storage.disk('default').readFile('a', 'utf8')).toBe('1');
    expect(await moduleRef.get<StorageDisk>(getStorageToken('default')).readFile('a', 'utf8')).toBe('1');
    await moduleRef.close();
  });
});

describe('multi-disk: API completeness', () => {
  it('StorageDisk has exactly the file API (and s3client), nothing disk-management', () => {
    const own = Object.getOwnPropertyNames(StorageDisk.prototype).filter((n) => n !== 'constructor');
    expect(own.sort()).toEqual([...FILE_API_METHODS, 's3client'].sort());
  });

  it('every method is delegated to the driver, with its arguments and result', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot({ default: 'x', disks: { x: memory, y: memory } })],
    }).compile();
    await moduleRef.init();
    const storage = moduleRef.get(StorageService);
    for (const disk of [storage, storage.disk('y')]) {
      const calls: Array<{ method: string; args: unknown[] }> = [];
      const driver: Record<string, unknown> = {};
      for (const method of FILE_API_METHODS) {
        driver[method] = (...args: unknown[]) => {
          calls.push({ method, args });
          return `result of ${method}`;
        };
      }
      // the disk is a thin wrapper around its driver: swap the driver for a recorder
      const target: any = disk;
      const original = target.driver;
      target.driver = driver;
      try {
        for (const method of FILE_API_METHODS) {
          const args = [`${method}-a`, `${method}-b`, 3, `${method}-d`];
          expect(await (disk as any)[method](...args)).toBe(`result of ${method}`);
          const call = calls.find((c) => c.method === method)!;
          // the disk passes its arguments on as they are (a disk method ignores the surplus ones of a shorter signature)
          expect(call.args.slice(0, 2)).toEqual(args.slice(0, 2));
        }
        expect(calls.map((c) => c.method).sort()).toEqual([...FILE_API_METHODS].sort());
      } finally {
        target.driver = original;
      }
    }
    await moduleRef.close();
  });

  it('every file-API method of StorageService exists on a StorageDisk and on the service', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot({ default: 'x', disks: { x: memory, y: memory } })],
    }).compile();
    const storage = moduleRef.get(StorageService);
    for (const disk of [storage, storage.disk('x'), storage.disk('y')]) {
      for (const method of FILE_API_METHODS) {
        expect(typeof (disk as any)[method]).toBe('function');
      }
      expect('s3client' in disk).toBe(true);
    }
    // the service adds only disk management on top of StorageDisk
    const serviceOwn = Object.getOwnPropertyNames(StorageService.prototype).filter((n) => n !== 'constructor');
    expect(serviceOwn.sort()).toEqual(['disk', 'diskNames', 'onModuleDestroy', 'onModuleInit']);
    await moduleRef.close();
  });
});

describe('multi-disk: forRootAsync', () => {
  const config: StorageMultiDiskOptions = { default: 'a', disks: { a: memory, b: memory, c: memory } };

  it('with disks: the listed tokens are injectable, the factory uses an injected provider', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRootAsync({
          disks: ['b', 'c'],
          imports: [diskConfigModule(config)],
          inject: [DiskConfig],
          useFactory: async (c: DiskConfig) => c.config,
        }),
      ],
    }).compile();
    await moduleRef.init();
    const storage = moduleRef.get(StorageService);
    expect(storage.diskNames).toEqual(['a', 'b', 'c']);
    const b = moduleRef.get<StorageDisk>(getStorageToken('b'));
    const c = moduleRef.get<StorageDisk>(getStorageToken('c'));
    expect(b).toBe(storage.disk('b'));
    await b.writeFile('f', 'b');
    expect(await c.exists('f')).toBe(false);
    expect(await storage.exists('f')).toBe(false);
    // not listed -> not registered
    expect(() => moduleRef.get(getStorageToken('a'))).toThrow();
    await moduleRef.close();
  });

  it('with disks: a listed name missing from the config fails the bootstrap with the unknown-disk error', async () => {
    await expect(
      Test.createTestingModule({
        imports: [
          StorageModule.forRootAsync({
            disks: ['a', 'nope'],
            imports: [diskConfigModule(config)],
            inject: [DiskConfig],
            useFactory: (c: DiskConfig) => c.config,
          }),
        ],
      }).compile(),
    ).rejects.toThrow(new Error('Unknown storage disk "nope". Configured disks: a, b, c'));
  });

  it('without disks: StorageService and disk() work, no disk token is registered', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRootAsync({ useFactory: async () => config })],
    }).compile();
    await moduleRef.init();
    const storage = moduleRef.get(StorageService);
    await storage.disk('b').writeFile('f', 'b');
    expect(await storage.disk('b').readFile('f', 'utf8')).toBe('b');
    expect(await storage.exists('f')).toBe(false);
    for (const name of ['a', 'b', 'default']) {
      expect(() => moduleRef.get(getStorageToken(name))).toThrow();
    }
    await moduleRef.close();
  });

  it("without disks: @InjectStorage('default') fails the bootstrap, even when the factory returns a 'default' disk", async () => {
    @Injectable()
    class NeedsDefault {
      constructor(@InjectStorage('default') public readonly disk: StorageDisk) {}
    }
    for (const factoryConfig of [config, { default: 'default', disks: { default: memory } }, memory]) {
      await expect(
        Test.createTestingModule({
          imports: [StorageModule.forRootAsync({ useFactory: () => factoryConfig as StorageConfig })],
          providers: [NeedsDefault],
        })
          .compile()
          .then((ref) => ref.init()),
      ).rejects.toThrow(/dependency|resolve/i);
    }
  });
});

describe('multi-disk: isGlobal', () => {
  @Injectable()
  class Feature {
    constructor(@InjectStorage('x') public readonly x: StorageDisk) {}
  }
  @Module({ providers: [Feature], exports: [Feature] })
  class FeatureModule {}

  const config: StorageMultiDiskOptions = { default: 'x', disks: { x: memory } };

  const variants: [string, (isGlobal: boolean) => ReturnType<typeof StorageModule.forRoot>][] = [
    ['forRoot', (isGlobal) => StorageModule.forRoot({ ...config, isGlobal })],
    [
      'forRootAsync',
      (isGlobal) => StorageModule.forRootAsync({ isGlobal, disks: ['x'], useFactory: async () => config }),
    ],
  ];

  it.each(variants)(
    '%s, isGlobal: true: a feature module that does not import StorageModule can inject a disk',
    async (_, make) => {
      const moduleRef = await Test.createTestingModule({ imports: [make(true), FeatureModule] }).compile();
      await moduleRef.init();
      const feature = moduleRef.get(Feature);
      expect(feature.x).toBe(moduleRef.get(StorageService).disk('x'));
      await feature.x.writeFile('g', '1');
      expect(await moduleRef.get(StorageService).readFile('g', 'utf8')).toBe('1');
      await moduleRef.close();
    },
  );

  it.each(variants)('%s, isGlobal: false: the same injection fails', async (_, make) => {
    await expect(Test.createTestingModule({ imports: [make(false), FeatureModule] }).compile()).rejects.toThrow(
      /dependency|resolve/i,
    );
  });
});

describe('multi-disk: lifecycle errors', () => {
  const build = (names: string[] = ['a', 'b', 'c']) =>
    Test.createTestingModule({
      imports: [StorageModule.forRoot({ default: names[0], disks: Object.fromEntries(names.map((n) => [n, memory])) })],
    }).compile();
  const driverOf = (storage: StorageService, name: string) => (storage.disk(name) as any).driver;

  it('an init failure on one disk fails the app init', async () => {
    const moduleRef = await build();
    const storage = moduleRef.get(StorageService);
    jest.spyOn(driverOf(storage, 'b'), 'init').mockRejectedValue(new Error('init of b failed'));
    const initA = jest.spyOn(driverOf(storage, 'a'), 'init');
    await expect(moduleRef.init()).rejects.toThrow('init of b failed');
    expect(initA).toHaveBeenCalledTimes(1);
  });

  it('on close, every driver is destroyed even if some destroy() rejects, and the first error is rethrown', async () => {
    const moduleRef = await build(['a', 'b', 'c', 'd']);
    await moduleRef.init();
    const storage = moduleRef.get(StorageService);
    const destroy = Object.fromEntries(
      ['a', 'b', 'c', 'd'].map((n) => [n, jest.spyOn(driverOf(storage, n), 'destroy')]),
    );
    destroy.b.mockRejectedValue(new Error('destroy of b failed'));
    destroy.c.mockRejectedValue(new Error('destroy of c failed'));

    await expect(moduleRef.close()).rejects.toThrow('destroy of b failed');
    for (const spy of Object.values(destroy)) {
      expect(spy).toHaveBeenCalledTimes(1);
    }
  });

  it('on close, a single failing destroy() is rethrown and the others still run', async () => {
    const moduleRef = await build();
    await moduleRef.init();
    const storage = moduleRef.get(StorageService);
    const destroyA = jest.spyOn(driverOf(storage, 'a'), 'destroy');
    const destroyC = jest.spyOn(driverOf(storage, 'c'), 'destroy');
    jest.spyOn(driverOf(storage, 'b'), 'destroy').mockRejectedValue(new Error('only b'));
    await expect(moduleRef.close()).rejects.toThrow('only b');
    expect(destroyA).toHaveBeenCalledTimes(1);
    expect(destroyC).toHaveBeenCalledTimes(1);
  });
});

describe('multi-disk: validation', () => {
  const build = (config: unknown) =>
    Test.createTestingModule({ imports: [StorageModule.forRoot(config as any)] }).compile();

  it.each([
    [{ default: 'a', disks: {} }, 'Storage "disks" must be a non-empty object of named disk configurations'],
    [{ default: 'a', disks: [] }, 'Storage "disks" must be a non-empty object of named disk configurations'],
    [{ default: 'a', disks: null }, 'Storage "disks" must be a non-empty object of named disk configurations'],
    [{ default: 'x', disks: { a: memory } }, 'Storage "default" must be the name of a configured disk (a), got "x"'],
    [
      { disks: { a: memory, b: memory } },
      'Storage "default" must be the name of a configured disk (a, b), got undefined',
    ],
    [{ default: 1, disks: { a: memory } }, 'Storage "default" must be the name of a configured disk (a), got 1'],
    [
      { default: 'toString', disks: { a: memory } },
      'Storage "default" must be the name of a configured disk (a), got "toString"',
    ],
    [{ default: '', disks: { '': memory } }, 'Storage disk names must not be empty'],
    [{ default: 'a', disks: { a: 'memory' } }, 'Storage disk "a" must be a configuration object'],
    [{ default: 'a', disks: { a: null } }, 'Storage disk "a" must be a configuration object'],
    [{ default: 'a', disks: { a: memory, b: [] } }, 'Storage disk "b" must be a configuration object'],
  ])('%j -> %s', async (config, message) => {
    await expect(build(config)).rejects.toThrow(new Error(message));
  });

  describe('missing memfs', () => {
    const MESSAGE = `type 'memory' requires the optional peer dependency "memfs": npm install memfs`;
    afterEach(() => {
      jest.dontMock('memfs');
    });

    const messageOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (error: any) {
        return error.message;
      }
      return undefined;
    };

    function withoutMemfs(run: (Isolated: typeof StorageService) => void) {
      jest.isolateModules(() => {
        jest.doMock('memfs', () => {
          throw Object.assign(new Error("Cannot find module 'memfs'"), { code: 'MODULE_NOT_FOUND' });
        });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        run(require('../lib/storage.service').StorageService);
      });
    }

    it('single store: the error is unchanged (no disk name)', () => {
      withoutMemfs((Isolated) => {
        expect(messageOf(() => new Isolated({ type: 'memory' }))).toBe(MESSAGE);
      });
    });

    it('multi-disk: the error is prefixed with the disk name', () => {
      withoutMemfs((Isolated) => {
        expect(
          messageOf(() => new Isolated({ default: 'a', disks: { a: { type: 'fileSystem' }, cache: memory } })),
        ).toBe(`Storage disk "cache": ${MESSAGE}`);
      });
    });

    it('multi-disk without memory disks does not load memfs', () => {
      withoutMemfs((Isolated) => {
        expect(() => new Isolated({ default: 'a', disks: { a: { type: 's3', bucket: 'b' } } })).not.toThrow();
      });
    });
  });
});
