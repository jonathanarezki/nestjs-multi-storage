import 'reflect-metadata';
import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Readable, Writable } from 'stream';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  getStorageToken,
  InjectStorage,
  StorageConfig,
  StorageDisk,
  StorageModule,
  StorageModuleOptions,
  StorageService,
} from 'nestjs-multi-storage';

/** The public file API of 0.5.1 (generated from its StorageService d.ts): StorageService must stay assignable to it. */
interface StorageService051 {
  readonly s3client: import('@aws-sdk/client-s3').S3Client | undefined;
  onModuleInit(): Promise<void>;
  onModuleDestroy(): Promise<void | undefined>;
  mkdir(folderPath: string, options?: import('nestjs-multi-storage').StorageMkdirOptions): Promise<string | undefined>;
  readdir(
    folderPath: string,
    options?: BufferEncoding | import('nestjs-multi-storage').StorageReaddirOptions,
  ): Promise<string[]>;
  rmdir(folderPath: string, options?: import('nestjs-multi-storage').StorageRmdirOptions): Promise<void>;
  stat(p: string, options?: { bucket?: string }): Promise<import('nestjs-multi-storage').StorageStats>;
  exists(p: string, bucket?: string): Promise<boolean>;
  readFile(
    filePath: string,
    options: BufferEncoding | (import('nestjs-multi-storage').StorageReadFileOptions & { encoding: BufferEncoding }),
  ): Promise<string>;
  readFile(
    filePath: string,
    options?: (import('nestjs-multi-storage').StorageReadFileOptions & { encoding?: null }) | null,
  ): Promise<Buffer>;
  readFile(
    filePath: string,
    options?: BufferEncoding | import('nestjs-multi-storage').StorageReadFileOptions | null,
  ): Promise<string | Buffer>;
  writeFile(
    filePath: string,
    data: string | Buffer | Uint8Array,
    options?: BufferEncoding | import('nestjs-multi-storage').StorageWriteFileOptions,
  ): Promise<void>;
  getSignedUrl(
    filePath: string,
    opts?: { bucket?: string; expiresIn?: number; responseContentDisposition?: string; responseContentType?: string },
  ): Promise<string>;
  getSignedPutUrl(
    filePath: string,
    opts?: { bucket?: string; expiresIn?: number; contentType?: string },
  ): Promise<string>;
  rm(filePath: string, options?: import('nestjs-multi-storage').StorageRmOptions): Promise<void>;
  copyFile(src: string, dest: string, mode?: number, bucket?: string): Promise<void>;
  rename(oldPath: string, newPath: string, bucket?: string): Promise<void>;
  createReadStream(filePath: string, options?: import('nestjs-multi-storage').StorageCreateReadStreamOptions): Readable;
  createWriteStream(
    filePath: string,
    options?: import('nestjs-multi-storage').StorageCreateWriteStreamOptions,
  ): Writable;
}

// Compile-time checks (ts-jest reports type errors): nothing from 0.5.1 is removed or narrowed.
function typeChecks(service: StorageService) {
  const compatible: StorageService051 = service;
  const asDisk: StorageDisk = service;
  const legacyOptions: StorageModuleOptions = { type: 'memory' };
  const asConfig: StorageConfig = legacyOptions;
  return [compatible, asDisk, asConfig];
}
void typeChecks; // never called: only compiled

/** Stand-in for @nestjs/config's ConfigService (its `get` returns `any` too). */
@Injectable()
class ConfigService {
  get(key: string): any {
    return key === 'storage.useFileSystem' ? true : undefined;
  }
}

@Injectable()
class Uploads {
  constructor(
    @InjectStorage('uploads') public readonly uploads: StorageDisk,
    @Inject(StorageService) public readonly storage: StorageService,
  ) {}
}

@Module({ providers: [Uploads], exports: [Uploads] })
class UploadsModule {}

describe('named disks (smoke)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nestjs-multi-storage-disks-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('forRoot: injects isolated disks, StorageService is the default disk', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRoot({
          isGlobal: true,
          default: 'cache',
          disks: {
            cache: { type: 'memory' },
            uploads: { type: 'memory' },
            local: { type: 'fileSystem', prefix: tmp },
          },
        }),
        UploadsModule,
      ],
    }).compile();
    await moduleRef.init();

    const storage = moduleRef.get(StorageService);
    const uploads = moduleRef.get(Uploads).uploads;
    const cache = moduleRef.get<StorageDisk>(getStorageToken('cache'));
    const local = moduleRef.get<StorageDisk>(getStorageToken('local'));
    expect(storage.diskNames).toEqual(['cache', 'uploads', 'local']);
    expect(uploads).toBeInstanceOf(StorageDisk);
    expect((uploads as any).disk).toBeUndefined();

    await uploads.writeFile('a.txt', 'uploads');
    await local.writeFile('a.txt', 'local');
    expect(await uploads.exists('a.txt')).toBe(true);
    expect(await cache.exists('a.txt')).toBe(false);
    expect(await storage.exists('a.txt')).toBe(false);
    expect(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8')).toBe('local');

    await storage.writeFile('d.txt', 'default');
    expect(await cache.readFile('d.txt', 'utf8')).toBe('default');
    expect(await storage.disk('cache').readFile('d.txt', 'utf8')).toBe('default');
    expect(storage.disk('cache')).not.toBe(storage);

    expect(() => storage.disk('nope')).toThrow(
      new Error('Unknown storage disk "nope". Configured disks: cache, uploads, local'),
    );
    await moduleRef.close();
  });

  it('forRoot with a single store: one disk named "default"', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot({ type: 'memory' })],
    }).compile();
    await moduleRef.init();
    const storage = moduleRef.get(StorageService);
    expect(storage.diskNames).toEqual(['default']);
    await storage.writeFile('x', '1');
    expect(await moduleRef.get<StorageDisk>(getStorageToken('default')).readFile('x', 'utf8')).toBe('1');
    expect(() => storage.disk('other')).toThrow('Unknown storage disk "other". Configured disks: default');
    await moduleRef.close();
  });

  it('forRootAsync: the disks extra registers the listed names; a missing one fails the bootstrap', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRootAsync({
          disks: ['a', 'b'],
          useFactory: async () => ({
            default: 'a',
            disks: { a: { type: 'memory' as const }, b: { type: 'memory' as const } },
          }),
        }),
      ],
    }).compile();
    await moduleRef.init();
    await moduleRef.get<StorageDisk>(getStorageToken('b')).writeFile('f', 'b');
    expect(await moduleRef.get(StorageService).exists('f')).toBe(false);
    expect(() => moduleRef.get(getStorageToken('default'))).toThrow();
    await moduleRef.close();

    await expect(
      Test.createTestingModule({
        imports: [
          StorageModule.forRootAsync({
            disks: ['a', 'missing'],
            useFactory: () => ({ default: 'a', disks: { a: { type: 'memory' as const } } }),
          }),
        ],
      }).compile(),
    ).rejects.toThrow('Unknown storage disk "missing". Configured disks: a');
  });

  it('forRootAsync single store (union returned from the factory, ConfigService-style typing)', async () => {
    @Module({ providers: [ConfigService], exports: [ConfigService] })
    class ConfigModule {}

    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRootAsync({
          isGlobal: true,
          imports: [ConfigModule],
          inject: [ConfigService],
          useFactory: async (c: ConfigService) =>
            c.get('storage.useFileSystem')
              ? { type: 'fileSystem' }
              : {
                  type: 's3',
                  endpoint: c.get('storage.endpoint'),
                  region: c.get('storage.region'),
                  bucket: c.get('storage.bucket'),
                  forcePathStyle: c.get('storage.forcePathStyle'),
                  accessKeyId: c.get('storage.accessKeyId'),
                  secretAccessKey: c.get('storage.secretAccessKey'),
                },
        }),
      ],
    }).compile();
    await moduleRef.init();
    expect(moduleRef.get(StorageService).diskNames).toEqual(['default']);
    expect(moduleRef.get(StorageService).disk('default')).toBeInstanceOf(StorageDisk);
    await moduleRef.close();
  });

  describe('validation', () => {
    const build = (config: unknown) =>
      Test.createTestingModule({ imports: [StorageModule.forRoot(config as any)] }).compile();

    it.each([
      [{ default: 'a', disks: {} }, 'Storage "disks" must be a non-empty object of named disk configurations'],
      [{ default: 'a', disks: [] }, 'Storage "disks" must be a non-empty object of named disk configurations'],
      [
        { default: 'x', disks: { a: { type: 'memory' } } },
        'Storage "default" must be the name of a configured disk (a), got "x"',
      ],
      [
        { disks: { a: { type: 'memory' } } },
        'Storage "default" must be the name of a configured disk (a), got undefined',
      ],
      [{ default: '', disks: { '': { type: 'memory' } } }, 'Storage disk names must not be empty'],
      [{ default: 'a', disks: { a: 'memory' } }, 'Storage disk "a" must be a configuration object'],
    ])('%j -> %s', async (config, message) => {
      await expect(build(config)).rejects.toThrow(message);
    });
  });
});
