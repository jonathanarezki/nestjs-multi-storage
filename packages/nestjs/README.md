# nestjs-multi-storage

[![npm version](https://img.shields.io/npm/v/nestjs-multi-storage.svg)](https://www.npmjs.com/package/nestjs-multi-storage)
[![license](https://img.shields.io/npm/l/nestjs-multi-storage.svg)](LICENSE)

A storage module for NestJS whose `StorageService` (and every named `StorageDisk`) mirrors the function names and parameters of Node's `fs.promises`. Code written against `fs` can switch to `storage.` and run against the local filesystem, an S3-compatible object store, an FTP or SFTP server or an in-memory store.

This package is a thin NestJS wrapper around [`@webbar/node-multi-storage`](https://www.npmjs.com/package/@webbar/node-multi-storage), which holds the actual implementation. The **file API, the backends, their options, the S3 / FTP / SFTP behaviour and the error codes are documented in the [core README](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md)**; this page covers what Nest adds: the module, injection, the lifecycle and testing.

## Requirements

- Node.js >= 22
- NestJS 11 (`@nestjs/common` and `@nestjs/core` `^11.0.0`)

## Installation

```bash
npm install nestjs-multi-storage
```

The drivers that need an extra library take it as an optional peer dependency. Install only what you use:

```bash
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner   # type: 's3'
npm install basic-ftp   # type: 'ftp'
npm install ssh2        # type: 'sftp'
npm install memfs       # type: 'memory' (usually as a dev dependency)
```

The `fileSystem` backend needs nothing. Without the AWS SDK packages an `s3` disk fails at startup with `type 's3' requires the optional peer dependencies ...: npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner`. See the [core README](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md#installation) for the details, including the TypeScript note about `skipLibCheck`.

## Quick start

`StorageModule.forRoot` takes the configuration of one store (or several, see [Multiple disks](#multiple-disks)). All options of every backend (`type`, `prefix`, `bucket`, `host`, ...) are listed in the [core configuration tables](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md#configuration).

### Filesystem

```ts
import { Module } from '@nestjs/common';
import { StorageModule } from 'nestjs-multi-storage';

@Module({
  imports: [
    StorageModule.forRoot({
      type: 'fileSystem',
      prefix: './uploads', // optional: all paths are relative to this directory, which must already exist
    }),
  ],
})
export class AppModule {}
```

### S3

```bash
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner
```

```ts
import { Module } from '@nestjs/common';
import { StorageModule } from 'nestjs-multi-storage';

@Module({
  imports: [
    StorageModule.forRoot({
      type: 's3',
      bucket: 'my-bucket',
      region: 'eu-west-1',
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
      prefix: 'media', // optional: all keys live under "media/"
    }),
  ],
})
export class AppModule {}
```

### FTP

```bash
npm install basic-ftp
```

```ts
import { Module } from '@nestjs/common';
import { StorageModule } from 'nestjs-multi-storage';

@Module({
  imports: [
    StorageModule.forRoot({
      type: 'ftp',
      host: 'ftp.example.com',
      username: 'user',
      password: process.env.FTP_PASSWORD,
      secure: true, // optional: FTPS (explicit TLS); 'implicit' for implicit TLS
      prefix: 'exports', // optional: remote base directory, relative to the login directory
    }),
  ],
})
export class AppModule {}
```

### SFTP

```bash
npm install ssh2
```

```ts
import { Module } from '@nestjs/common';
import { StorageModule } from 'nestjs-multi-storage';

@Module({
  imports: [
    StorageModule.forRoot({
      type: 'sftp',
      host: 'sftp.example.com',
      username: 'user',
      privateKey: process.env.SFTP_PRIVATE_KEY, // or password: ...
      hostKey: 'SHA256:3Xl5JCm6hnQZd0Gt1sdQkzJV7dr5CYLK6Z5eiGOWmHo', // required, see "The SFTP host key" in the core README
      prefix: '/upload', // optional: remote base directory
    }),
  ],
})
export class AppModule {}
```

`hostKey` is required and a missing one fails at startup. See [FTP and SFTP](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md#ftp-and-sftp) for how to get the fingerprint and for the behaviour of both backends.

### Memory (for tests)

```bash
npm install --save-dev memfs
```

```ts
import { Module } from '@nestjs/common';
import { StorageModule } from 'nestjs-multi-storage';

@Module({
  imports: [StorageModule.forRoot({ type: 'memory' })], // empty, private, never touches the disk
})
export class TestAppModule {}
```

See [Testing with the memory backend](#testing-with-the-memory-backend).

### Async configuration with `@nestjs/config`

`forRootAsync` accepts the usual `imports`, `inject` and `useFactory` (as well as `useClass` and `useExisting`).

```ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StorageModule } from 'nestjs-multi-storage';

@Module({
  imports: [
    ConfigModule.forRoot(),
    StorageModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        type: 's3' as const,
        bucket: config.getOrThrow<string>('S3_BUCKET'),
        region: config.get<string>('S3_REGION'),
        endpoint: config.get<string>('S3_ENDPOINT'),
        accessKeyId: config.get<string>('S3_ACCESS_KEY_ID'),
        secretAccessKey: config.get<string>('S3_SECRET_ACCESS_KEY'),
      }),
    }),
  ],
})
export class AppModule {}
```

### Global module

Both `forRoot` and `forRootAsync` accept an extra `isGlobal` flag (default `false`). When `true`, `StorageService` (and the injectable disks, see [Multiple disks](#multiple-disks)) is available everywhere without importing `StorageModule` again. With several disks, `isGlobal` sits at the top level next to `default` and `disks`, not inside a disk.

```ts
StorageModule.forRoot({ isGlobal: true, type: 'fileSystem', prefix: './uploads' }); // ./uploads must already exist
```

### Using the service

The service is the default disk. Its API is the same on every `StorageDisk`, see [Multiple disks](#multiple-disks).

```ts
import { Injectable } from '@nestjs/common';
import { StorageService } from 'nestjs-multi-storage';

@Injectable()
export class AvatarService {
  constructor(private readonly storage: StorageService) {}

  async save(userId: string, data: Buffer): Promise<void> {
    await this.storage.mkdir(`avatars/${userId}`);
    await this.storage.writeFile(`avatars/${userId}/avatar.png`, data);
  }

  async load(userId: string): Promise<Buffer> {
    return this.storage.readFile(`avatars/${userId}/avatar.png`);
  }
}
```

## Multiple disks

Use named disks when one app talks to several stores: user uploads on S3, scratch files on the local filesystem, a second bucket for exports, or a memory disk for a cache. Each disk has its own backend and options (prefix, bucket, credentials, endpoint). Everything below is optional: a plain `{ type: ... }` configuration keeps working unchanged, see [Existing configurations keep working](#existing-configurations-keep-working).

```ts
import { Module } from '@nestjs/common';
import { StorageModule } from 'nestjs-multi-storage';

@Module({
  imports: [
    StorageModule.forRoot({
      isGlobal: true, // top level, next to the disks (not inside a disk)
      default: 'uploads', // the disk StorageService itself operates on
      disks: {
        uploads: { type: 's3', bucket: 'my-uploads', region: 'eu-west-1', prefix: 'media' },
        exports: { type: 's3', bucket: 'my-exports', endpoint: 'https://minio.example.com', forcePathStyle: true },
        tmp: { type: 'fileSystem', prefix: './tmp' }, // ./tmp must already exist
        partner: {
          type: 'sftp', // a partner's exchange folder
          host: 'sftp.partner.example.com',
          username: 'acme',
          privateKey: process.env.PARTNER_SFTP_KEY,
          hostKey: process.env.PARTNER_SFTP_HOST_KEY as string, // 'SHA256:...'
          prefix: '/exchange',
        },
      },
    }),
  ],
})
export class AppModule {}
```

Every disk is a `StorageDisk`, which has the complete file API described in the [API reference](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md#api-reference) (the same methods, options and errors as `StorageService`) and `s3client`. There are three ways to reach a disk:

```ts
import { Injectable } from '@nestjs/common';
import { InjectStorage, StorageDisk, StorageService } from 'nestjs-multi-storage';

@Injectable()
export class ImportService {
  constructor(
    private readonly storage: StorageService, // the default disk ('uploads')
    @InjectStorage('tmp') private readonly tmp: StorageDisk, // a named disk, injected
  ) {}

  async run(): Promise<void> {
    await this.storage.writeFile('a.txt', 'default disk');
    await this.tmp.writeFile('b.txt', 'tmp disk');
    await this.storage.disk('exports').writeFile('c.txt', 'looked up by name');
  }
}
```

- `StorageService` is the default disk and has the same API as before. It also has `disk(name)` and `diskNames`.
- `storage.disk('name')` returns the `StorageDisk` of that name, the same instance on every call. `storage.disk('uploads')` (the default's name) is a separate `StorageDisk` object that shares the default disk's backend, so both see the same files. An unknown name throws `Unknown storage disk "x". Configured disks: uploads, exports, tmp, partner`. `storage.diskNames` lists the configured names.
- `@InjectStorage('name')` injects the `StorageDisk` of that name. `StorageDisk` has no `disk()` method. `getStorageToken('name')` returns the injection token, for `app.get(...)` / `moduleRef.get(...)` and for overriding a disk in tests.

`forRoot` registers an injectable token for every disk name (for a single-store configuration: `'default'`). The names of `disks` must not be empty, `disks` must not be empty and `default` must be one of its names, and every disk must be a configuration object; otherwise startup fails with an error naming the problem. Errors while building a disk are prefixed with `Storage disk "name": `.

### Async configuration with disks

With `forRootAsync` the disk names are only known after the factory has run, so list the names you want to inject with `@InjectStorage(...)` in the `disks` option:

```ts
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { StorageModule } from 'nestjs-multi-storage';

@Module({
  imports: [
    ConfigModule.forRoot(),
    StorageModule.forRootAsync({
      isGlobal: true,
      imports: [ConfigModule],
      inject: [ConfigService],
      disks: ['uploads', 'tmp'], // names to make injectable
      useFactory: (config: ConfigService) => ({
        default: 'uploads',
        disks: {
          uploads: {
            type: 's3' as const,
            bucket: config.getOrThrow<string>('UPLOADS_BUCKET'),
            region: config.get<string>('S3_REGION'),
          },
          tmp: { type: 'fileSystem' as const, prefix: config.get<string>('TMP_DIR') },
        },
      }),
    }),
  ],
})
export class AppModule {}
```

A name listed in `disks` that the factory does not return fails the bootstrap with the unknown-disk error. Without `disks`, `forRootAsync` registers no disk tokens: `StorageService` and `storage.disk(name)` still work, but `@InjectStorage(...)` fails at bootstrap with Nest's dependency error.

### Several buckets

Use one disk per bucket: a disk has exactly one bucket (the `bucket` option), and each disk can have its own prefix, endpoint and credentials. The methods take no per-call `bucket` (it was removed in 0.8.0): inject the disk of the other bucket with `@InjectStorage('exports')` or get it with `storage.disk('exports')`.

### Copying between disks

There is no cross-disk copy helper: pipe the streams. This works across backends and does not load the file into memory.

```ts
import { pipeline } from 'stream/promises';

await pipeline(
  storage.disk('tmp').createReadStream('upload.bin'),
  storage.disk('uploads').createWriteStream('files/upload.bin'),
);

// A move is a copy followed by removing the source
await storage.disk('tmp').rm('upload.bin');
```

On `fileSystem` and `memory` destinations the target folder must exist (`await disk.mkdir('files')`), as with `fs`; on S3 folders are implicit.

### Testing with multiple disks

There is no special test helper: configure the disks with `type: 'memory'` in `StorageModule.forRoot`. Every memory disk is its own empty, isolated store. See also [Testing with the memory backend](#testing-with-the-memory-backend).

```ts
import { Test } from '@nestjs/testing';
import { pipeline } from 'stream/promises';
import { getStorageToken, StorageDisk, StorageModule, StorageService } from 'nestjs-multi-storage';

describe('moving between disks', () => {
  it('moves a file from tmp to uploads', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRoot({
          default: 'uploads',
          disks: {
            uploads: { type: 'memory' },
            tmp: { type: 'memory', files: { 'upload.bin': 'data' } },
          },
        }),
      ],
    }).compile();
    await moduleRef.init();

    const tmp = moduleRef.get<StorageDisk>(getStorageToken('tmp'));
    const uploads = moduleRef.get(StorageService); // the default disk
    await uploads.mkdir('files'); // memory disks behave like fs: the folder must exist before writing into it
    await pipeline(tmp.createReadStream('upload.bin'), uploads.createWriteStream('files/upload.bin'));
    await tmp.rm('upload.bin');

    expect(await uploads.readFile('files/upload.bin', 'utf8')).toBe('data');
    expect(await tmp.exists('upload.bin')).toBe(false);
    await moduleRef.close();
  });
});
```

### Existing configurations keep working

A single-store configuration (`{ type: ..., ... }`) is unchanged and fully backward compatible: it becomes one disk named `'default'`, `StorageService` works as before and nothing has to be migrated. For example, this async setup needs no change at all:

```ts
StorageModule.forRootAsync({
  isGlobal: true,
  imports: [ConfigModule],
  useFactory: async (configService: ConfigService) => {
    if (!configService.get('storage.useFileSystem')) {
      return {
        type: 's3',
        endpoint: configService.get('storage.endpoint'),
        region: configService.get('storage.region'),
        bucket: configService.get('storage.bucket'),
        forcePathStyle: configService.get('storage.forcePathStyle'),
        accessKeyId: configService.get('storage.accessKeyId'),
        secretAccessKey: configService.get('storage.secretAccessKey'),
      };
    } else {
      return { type: 'fileSystem' };
    }
  },
  inject: [ConfigService],
});
```

If you later want a second disk, return the multi-disk shape from the same factory and list the names to inject:

```ts
StorageModule.forRootAsync({
  isGlobal: true,
  imports: [ConfigModule],
  disks: ['uploads', 'tmp'],
  useFactory: async (configService: ConfigService) => ({
    default: 'uploads',
    disks: {
      uploads: configService.get('storage.useFileSystem')
        ? { type: 'fileSystem' as const }
        : {
            type: 's3' as const,
            endpoint: configService.get('storage.endpoint'),
            region: configService.get('storage.region'),
            bucket: configService.get('storage.bucket'),
            forcePathStyle: configService.get('storage.forcePathStyle'),
            accessKeyId: configService.get('storage.accessKeyId'),
            secretAccessKey: configService.get('storage.secretAccessKey'),
          },
      tmp: { type: 'fileSystem' as const, prefix: './tmp' }, // ./tmp must already exist
    },
  }),
  inject: [ConfigService],
});
```

## File API, backends and options

`StorageService` and every `StorageDisk` have the complete `fs`-style file API of the core, unchanged. The core README documents:

- the [API reference](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md#api-reference) (`readFile`, `writeFile`, `readdir`, `stat`, `copyFile`, `rename`, `mkdir`, `rm`, `rmdir`, `exists`, streams, signed URLs, `s3client`);
- the [configuration tables](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md#configuration) (`prefix`, `bucket`, `endpoint`, `host`, `hostKey`, ...);
- [how S3 differs from a real filesystem](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md#how-s3-differs-from-a-real-filesystem) and the [FTP and SFTP](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md#ftp-and-sftp) behaviour, including the SFTP host key;
- [error handling](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md#error-handling): `isStorageError` and `StorageErrorCode` are re-exported by this package, so `import { isStorageError } from 'nestjs-multi-storage'` works the same way.

This package re-exports `StorageDisk`, `isStorageError` and all option and config types of the core (`StorageConfig`, `StorageModuleOptions`, `StorageDiskOptions`, `StorageMultiDiskOptions`, `StorageStats`, `StorageError`, `StorageErrorCode`, ...), so you do not need to import from `@webbar/node-multi-storage` yourself.

## Custom drivers (experimental)

A disk can be backed by your own `StorageDriver` (`type: 'custom'`), and any disk can be wrapped (`wrap`) to add encryption, read-only access or logging. The types flow through `forRoot` and `forRootAsync`. The interface is experimental in 0.8.x and may change in a minor release; it is documented in the [core README](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md#custom-drivers-experimental).

```ts
import { StorageModule } from 'nestjs-multi-storage';

StorageModule.forRoot({
  default: 'local',
  disks: {
    local: { type: 'fileSystem', prefix: './data', wrap: (inner) => withLogging(inner) },
    mine: { type: 'custom', driver: () => new MyDriver() }, // created on first use or in onModuleInit
  },
});
```

`StorageDriver`, `StorageCustomDiskOptions`, the `Driver*Options` types and the helpers `createFsError`, `createRmDirectoryError` and `createStats` are re-exported by this package.

## Lifecycle

Nest handles it. `StorageService` extends the core `Storage` and calls `init()` in `onModuleInit` and `destroy()` in `onModuleDestroy`, so all disks are warmed up when the app starts (this creates the S3 clients) and their S3 clients and FTP / SFTP connections are closed on shutdown. `init()` is optional in any case: every disk also connects or creates its client on first use, which is why the `StorageService` of a testing module you only `compile()` (without `init()`) works too. If closing one disk fails on shutdown, the others are still closed and the first error is rethrown. `init()` and `destroy()` are public on `StorageService`, but you normally never call them; after `destroy()` the disks reconnect on the next operation. See [Lifecycle](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md#lifecycle) in the core README.

## Testing with the memory backend

`type: 'memory'` keeps all files in a private in-memory volume ([memfs](https://github.com/streamich/memfs)), so unit tests need no disk, Docker or S3 credentials. Every memory disk (and every `StorageService` instance) gets its own empty store, so a fresh Nest testing module starts from scratch and tests cannot leak data into each other.

`memfs` is an optional peer dependency and must be installed in your project: `npm i -D memfs`. Without it, creating a memory service throws `type 'memory' requires the optional peer dependency "memfs": npm install memfs`.

```ts
import { Test } from '@nestjs/testing';
import { StorageModule, StorageService } from 'nestjs-multi-storage';

describe('ReportService', () => {
  let storage: StorageService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRoot({
          type: 'memory',
          files: {
            'templates/welcome.txt': 'Hello {{name}}',
            'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
          },
        }),
      ],
      providers: [ReportService],
    }).compile();
    storage = moduleRef.get(StorageService);
  });

  it('reads the seeded template and writes a report', async () => {
    expect(await storage.readFile('templates/welcome.txt', 'utf8')).toBe('Hello {{name}}');
    await storage.mkdir('reports'); // memory behaves like fs: the folder must exist before writing into it
    await storage.writeFile('reports/a.txt', 'done');
    expect(await storage.readdir('reports')).toEqual(['a.txt']);
  });
});
```

Memory mode behaves like `fileSystem` (same methods, options and Node-style errors, `prefix` escapes rejected, no signed URLs, nothing persisted); the known deviations are listed in the [core README](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md#testing-with-the-memory-backend). For several disks, see [Testing with multiple disks](#testing-with-multiple-disks).

## Upgrading from 0.7.x

- **BREAKING:** the per-call `bucket` is removed (it was an option of every file method, the last parameter of `exists`, `rename` and `copyFile`, and `opts.bucket` of the signed URL methods). Configure one disk per bucket, see [Several buckets](#several-buckets). An s3 disk without `bucket` now fails when the module is set up.
- Signed URL methods on non-S3 disks reject with `ERR_STORAGE_NOT_SUPPORTED`, `readdir` results are always sorted, `createReadStream` with `start > end` throws on every backend, and unknown encodings are rejected with `ERR_INVALID_ARG_VALUE`.

See the [core changelog](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/CHANGELOG.md) for the details and the [CHANGELOG](CHANGELOG.md) for this package.

## Upgrading from 0.6.x

Up to 0.7.0 the API was identical to 0.6.0: `StorageModule`, `StorageService`, `StorageDisk`, `@InjectStorage`, `getStorageToken`, `isStorageError` and all types are unchanged, and nothing in your code has to change. One thing does:

- **BREAKING:** the AWS SDK is now an optional peer dependency instead of a regular one. If you use `type: 's3'`, install it yourself: `npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner`. Without them an s3 disk fails at startup with `type 's3' requires the optional peer dependencies "@aws-sdk/client-s3", "@aws-sdk/lib-storage" and "@aws-sdk/s3-request-presigner": npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner` (prefixed with `Storage disk "name": ` when you use several disks). Projects without S3 save about 150 packages and 20 MB of `node_modules`.
- If you use TypeScript with `skipLibCheck: false` and no AWS SDK, install `@aws-sdk/client-s3` or set `skipLibCheck: true` (Nest's default), see the [core README](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md#typescript-without-the-aws-sdk).
- FTP disks now reconnect on the next operation after `destroy()`, like S3 and SFTP (before, they rejected with `The ftp storage has been destroyed`).

See the [CHANGELOG](CHANGELOG.md) for the full list.

## Contributing

The source lives in the [node-multi-storage monorepo](https://github.com/jonathanarezki/node-multi-storage) (`packages/core` and `packages/nestjs`); see its README for how to build and test.

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE)
