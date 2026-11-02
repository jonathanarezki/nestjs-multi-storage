# nestjs-multi-storage

[![npm version](https://img.shields.io/npm/v/nestjs-multi-storage.svg)](https://www.npmjs.com/package/nestjs-multi-storage)
[![license](https://img.shields.io/npm/l/nestjs-multi-storage.svg)](LICENSE)

A storage module for NestJS whose `StorageService` (and every named `StorageDisk`, see [Multiple disks](#multiple-disks)) mirrors the function names and parameters of Node's `fs.promises`. Code written against `fs` can switch to `storage.` and run against the local filesystem, an S3-compatible object store, an FTP or SFTP server or an in-memory store. In filesystem mode each method is the corresponding `fs` call; in the other modes the `fs` semantics are emulated, including Node-style error codes (`ENOENT`, `EEXIST`, ...).

## Features

- `fs`-compatible API: `readFile`, `writeFile`, `readdir`, `stat`, `copyFile`, `rename`, `mkdir`, `rm`, `rmdir`, `exists`, `createReadStream`, `createWriteStream`.
- Five backends: the local filesystem, AWS S3 or any S3-compatible provider (MinIO, Cloudflare R2, Hetzner, ...), an FTP or FTPS server (`ftp`, via `basic-ftp`), an SFTP server (`sftp`, via `ssh2`), and an in-memory store (`memory`, backed by `memfs`) for unit tests without disk, Docker or credentials. FTP and SFTP behave like the filesystem backend (real folders, the same Node-style errors), see [FTP and SFTP](#ftp-and-sftp).
- Multiple named disks: configure several stores (for example S3 plus SFTP plus local filesystem plus memory) and use them via `StorageService` (the default disk), `storage.disk('name')` or `@InjectStorage('name')`. Single-store configurations keep working unchanged.
- Streams, including range reads, and a write stream that emits `'finish'` only after the upload has completed.
- Signed GET and PUT URLs (S3).
- Optional CDN endpoint (`endpointCDN`) used for `readFile` and signed URLs.
- Prefix scoping: confine the service to a directory (filesystem, FTP, SFTP) or key prefix (S3); paths escaping it are rejected.

## Requirements

- Node.js >= 22
- NestJS 11 (`@nestjs/common` and `@nestjs/core` `^11.0.0`)

## Installation

```bash
npm install nestjs-multi-storage
```

The drivers that need an extra library take it as an optional peer dependency. Install only what you use:

```bash
npm install basic-ftp   # type: 'ftp'
npm install ssh2        # type: 'sftp'
npm install memfs       # type: 'memory' (usually as a dev dependency)
```

## Quick start

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
      hostKey: 'SHA256:3Xl5JCm6hnQZd0Gt1sdQkzJV7dr5CYLK6Z5eiGOWmHo', // required, see "The SFTP host key"
      prefix: '/upload', // optional: remote base directory
    }),
  ],
})
export class AppModule {}
```

`hostKey` is required and a missing one fails at startup. See [FTP and SFTP](#ftp-and-sftp) for how to get the fingerprint and for the behaviour of both backends.

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

See [Testing your app with the memory backend](#testing-your-app-with-the-memory-backend).

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

## Configuration

`type` is the only option that is always required (`host` for ftp and sftp, and `hostKey` for sftp, on top of it). Unknown values of `type` fall back to the filesystem. With [multiple disks](#multiple-disks) the same options apply to each disk. The FTP and SFTP options are in their own table below.

| Option                       | Type                                                  | Applies to | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                       | `'fileSystem' \| 's3' \| 'memory' \| 'ftp' \| 'sftp'` | all        | Selects the backend. `'memory'` needs the optional peer dependency `memfs`, `'ftp'` needs `basic-ftp` and `'sftp'` needs `ssh2`.                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `prefix`                     | `string`                                              | all        | Root of the storage. A directory on the filesystem, a key prefix on S3 (leading and trailing `/` or `\` are stripped), the remote base directory on FTP and SFTP (relative to the login directory when relative, `'.'` is the login directory; it must exist). Paths resolving outside it throw an `Error`. On the filesystem the directory must already exist: the module does not create it, and the first write fails with `ENOENT` otherwise. In memory mode it is a directory inside the in-memory volume (relative prefixes are resolved under `/`). Default: none (`/` in memory mode). |
| `files`                      | `Record<string, string \| Buffer>`                    | memory     | Pre-populates the in-memory store. Keys are paths relative to `prefix` (parent folders are created, keys escaping the prefix throw), values are the file contents. Default: empty.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `bucket`                     | `string`                                              | S3         | Default bucket. Can be overridden per call, see [per-call bucket](#per-call-bucket).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `region`                     | `string`                                              | S3         | AWS region. If omitted, the AWS SDK default resolution applies (`AWS_REGION`, shared config, ...).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `endpoint`                   | `string`                                              | S3         | Custom endpoint URL, for S3-compatible providers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `forcePathStyle`             | `boolean`                                             | S3         | Use path-style addressing (`https://host/bucket/key`). Often required by MinIO and similar. Default: the SDK default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `accessKeyId`                | `string`                                              | S3         | Access key. Credentials are used only when both `accessKeyId` and `secretAccessKey` are set; otherwise the AWS default credential chain is used (environment variables, IAM roles, `~/.aws`).                                                                                                                                                                                                                                                                                                                                                                                                  |
| `secretAccessKey`            | `string`                                              | S3         | Secret key. See `accessKeyId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `endpointCDN`                | `string`                                              | S3         | CDN host that replaces `endpoint` in URLs. Used by `readFile` (which then downloads via the CDN) and by `getSignedUrl` / `getSignedPutUrl`. Only takes effect when `endpoint` is set as well; otherwise `readFile` reads directly from S3.                                                                                                                                                                                                                                                                                                                                                     |
| `requestChecksumCalculation` | `'WHEN_SUPPORTED' \| 'WHEN_REQUIRED'`                 | S3         | Passed to the S3 client. Default: `'WHEN_REQUIRED'` when `endpoint` is set (S3-compatible providers often reject the SDK's default CRC32 checksums), otherwise the SDK default. An explicit value always wins; set `'WHEN_SUPPORTED'` to opt back in to the SDK default on a custom endpoint.                                                                                                                                                                                                                                                                                                  |
| `responseChecksumValidation` | `'WHEN_SUPPORTED' \| 'WHEN_REQUIRED'`                 | S3         | Passed to the S3 client. Same defaults and purpose as above; the two options are defaulted independently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

FTP and SFTP options (`host` is required for both; `hostKey` is required for sftp):

| Option           | Type                    | Applies to | Description                                                                                                                                                                                                   |
| ---------------- | ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host`           | `string`                | ftp, sftp  | Server host name or address. Required.                                                                                                                                                                        |
| `port`           | `number`                | ftp, sftp  | Server port. Default: `21` (ftp), `22` (sftp).                                                                                                                                                                |
| `username`       | `string`                | ftp, sftp  | Login user. Default for ftp: `anonymous`.                                                                                                                                                                     |
| `password`       | `string`                | ftp, sftp  | Login password.                                                                                                                                                                                               |
| `timeout`        | `number`                | ftp, sftp  | Milliseconds. ftp: the network timeout of the connections (default: the `basic-ftp` default, 30 s). sftp: only how long connecting and the SSH handshake may take; it does not limit the individual requests. |
| `secure`         | `boolean \| 'implicit'` | ftp        | FTPS. `true` is explicit TLS (`AUTH TLS`), `'implicit'` is implicit TLS (usually port 990). Default: `false` (plain FTP).                                                                                     |
| `maxConnections` | `number`                | ftp        | Pool size. Default: `2`. See [FTP](#ftp).                                                                                                                                                                     |
| `privateKey`     | `string \| Buffer`      | sftp       | Private key (PEM or OpenSSH format) for key authentication.                                                                                                                                                   |
| `passphrase`     | `string`                | sftp       | Passphrase of an encrypted `privateKey`.                                                                                                                                                                      |
| `hostKey`        | `string \| false`       | sftp       | Required. The server's host key fingerprint, `SHA256:<base64>`, or `false` to skip the verification (insecure). See [The SFTP host key](#the-sftp-host-key).                                                  |

The S3 client (one per S3 disk) is created in `onModuleInit` and destroyed in `onModuleDestroy`. With no `bucket` (and none passed per call), S3 calls throw `No bucket configured: pass a bucket or set the bucket option`.

Paths are always relative to `prefix`. With a prefix set, `'../x'` throws in all modes. Without a prefix, the filesystem backend uses paths as given (relative to the working directory) and the S3 backend uses them as keys; there, a path escaping the bucket root (`'../x'`, also `'/../x'`) throws.

On S3, leading slashes are stripped (and `\` is treated as `/`): `'/a.txt'`, `'a.txt'` and `'//a.txt'` are the same object, `'/dir/'` and `'dir'` the same folder. `'/'` is the bucket root (or the prefix root) and behaves exactly like `''`. The filesystem backend keeps plain `fs` semantics, where `'/a.txt'` is an absolute path.

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

Every disk is a `StorageDisk`, which has the complete file API described in the [API reference](#api-reference) (the same methods, options and errors as `StorageService`) and `s3client`. There are three ways to reach a disk:

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

### Lifecycle

Each S3 disk has its own client, created when the module initializes and destroyed when it is destroyed. FTP and SFTP disks connect lazily, on first use, and close their connections when the module is destroyed. Each memory disk is an isolated store. On shutdown all disks are closed, even if closing one of them fails (the first error is then rethrown).

### Several buckets

The [per-call `bucket`](#per-call-bucket) parameter is still supported and unchanged. Separate disks are the cleaner way to use several buckets (each can have its own prefix, endpoint and credentials), but nothing needs to change in code that passes `bucket`.

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

There is no special test helper: configure the disks with `type: 'memory'` in `StorageModule.forRoot`. Every memory disk is its own empty, isolated store. See also [Testing your app with the memory backend](#testing-your-app-with-the-memory-backend).

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

## API reference

The file methods below exist on `StorageService` and, identically, on every `StorageDisk` (`storage.disk('name')`, `@InjectStorage('name')`). Parameters mirror `fs.promises`. Where `fs` has an options parameter, the S3 `bucket` is a key of that options object; where it has none (`exists`, `rename`, `copyFile`), `bucket` is an extra trailing parameter. A plain string in an options position is an encoding, as in `fs`. In filesystem mode `bucket` (and the S3-only options) are ignored.

| Method                                                                                                                 | Returns                                                  | S3 notes                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mkdir(path, { recursive?, mode?, bucket? }?)`                                                                         | `Promise<string \| undefined>`                           | `recursive` defaults to `true` (unlike `fs`). Writes a `folder/` marker. `EEXIST` for a file; with `recursive: false` also for a folder, `ENOENT` for a missing parent.      |
| `readdir(path, encoding \| { recursive?, encoding?, bucket? }?)`                                                       | `Promise<string[]>`                                      | Sorted. `ENOENT` for a missing folder, `ENOTDIR` for a file. `withFileTypes` is not supported.                                                                               |
| `rmdir(path, { recursive?, bucket? }?)`                                                                                | `Promise<void>`                                          | `recursive` defaults to `true` (like `fs.rm(path, { recursive: true })`). Deletes in batches of 1000. `ENOENT` if missing; `recursive: false` gives `ENOTEMPTY` / `ENOTDIR`. |
| `rm(path, { force?, recursive?, bucket? }?)`                                                                           | `Promise<void>`                                          | `ENOENT` unless `force`. A folder needs `recursive`, else `ERR_FS_EISDIR`.                                                                                                   |
| `stat(path, { bucket? }?)`                                                                                             | `Promise<StorageStats>`                                  | Synthesized fields; adds `contentType` and `etag`. Throws `ENOENT`.                                                                                                          |
| `exists(path, bucket?)`                                                                                                | `Promise<boolean>`                                       | `true` for an object, a marker or an implicit folder. Throws on errors other than "not found".                                                                               |
| `readFile(path, encoding \| { encoding?, flag?, bucket? }?)`                                                           | `Promise<Buffer>`, or `Promise<string>` with an encoding | `ENOENT` for a missing key, `EISDIR` for a folder. Via `endpointCDN` if both it and `endpoint` are set. `flag` is ignored.                                                   |
| `writeFile(path, data, encoding \| { encoding?, mode?, flag?, bucket?, contentType? }?)`                               | `Promise<void>`                                          | `data` is `string \| Buffer \| Uint8Array`. Content type is `contentType`, else looked up from the file name. `mode` and `flag` are ignored.                                 |
| `copyFile(src, dest, mode?, bucket?)`                                                                                  | `Promise<void>`                                          | `CopyObject`, multipart copy above 5 GiB. Supports `COPYFILE_EXCL` (also for `src === dest`).                                                                                |
| `rename(oldPath, newPath, bucket?)`                                                                                    | `Promise<void>`                                          | Copy then delete; works on files and folders.                                                                                                                                |
| `createReadStream(path, { start?, end?, highWaterMark?, encoding?, bucket? }?)`                                        | `Readable`                                               | Ranged `GetObject`; `start` and `end` are inclusive. A missing key emits `ENOENT`, a folder `EISDIR`, as `'error'`.                                                          |
| `createWriteStream(path, { highWaterMark?, encoding?, flags?, mode?, partSize?, queueSize?, contentType?, bucket? }?)` | `Writable`                                               | Multipart upload. `flags` and `mode` are ignored; `partSize`, `queueSize` and `contentType` are S3 only.                                                                     |
| `getSignedUrl(path, opts?)`                                                                                            | `Promise<string>`                                        | S3 only. Throws in every other mode (filesystem, memory, ftp, sftp). `opts.bucket`.                                                                                          |
| `getSignedPutUrl(path, opts?)`                                                                                         | `Promise<string>`                                        | S3 only. Throws in every other mode (filesystem, memory, ftp, sftp). `opts.bucket`.                                                                                          |
| `s3client`                                                                                                             | `S3Client \| undefined`                                  | Getter. `undefined` in filesystem and memory mode.                                                                                                                           |

`mkdir` resolves to the first directory created on the filesystem (as `fs` does) and to `undefined` on S3.

### Disks

| Member                    | Returns             | Description                                                                                                                      |
| ------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `StorageService`          | class               | The default disk: the file API, plus `disk()` and `diskNames`.                                                                   |
| `storage.disk(name)`      | `StorageDisk`       | The disk of that name (same instance every time). Throws `Unknown storage disk "x". Configured disks: a, b` for an unknown name. |
| `storage.diskNames`       | `string[]`          | Names of all configured disks (`['default']` for a single store).                                                                |
| `StorageDisk`             | class               | One named store: every file method above and `s3client`, but no `disk()`.                                                        |
| `@InjectStorage(name)`    | parameter decorator | Injects the `StorageDisk` named `name`.                                                                                          |
| `getStorageToken(name)`   | `string`            | The injection token of a disk, for `moduleRef.get(...)` and for overriding it in tests.                                          |
| `forRootAsync({ disks })` | `string[]` option   | Disk names to register as injectable tokens (the names are not known before the factory runs).                                   |

Config types: `StorageModuleOptions` (one store), `StorageDiskOptions` (alias of it, the options of one disk), `StorageMultiDiskOptions` (`{ default: string; disks: Record<string, StorageDiskOptions> }`) and `StorageConfig` (either of the two).

### readFile and writeFile

```ts
const buffer = await storage.readFile('a.txt');
const text = await storage.readFile('a.txt', 'utf8'); // string
const b64 = await storage.readFile('a.txt', { encoding: 'base64' });

await storage.writeFile('a.txt', 'hello');
await storage.writeFile('a.png', 'aGk=', 'base64');
await storage.writeFile('a.bin', data, { contentType: 'application/x-custom' }); // S3 content type
```

### readdir

```ts
// Entries directly inside the folder (names only, like fs.readdir)
const names = await storage.readdir('reports');

// All descendants, as paths relative to the folder
const all = await storage.readdir('reports', { recursive: true });

// A bucket other than the default (a plain string would be an encoding)
await storage.readdir('reports', { recursive: true, bucket: 'other-bucket' });
```

On S3 the recursive result includes every ancestor folder of each object (`'2024'`, `'2024/jan'`, `'2024/jan/a.csv'`), like Node's recursive `readdir`. Results are de-duplicated and sorted, and listing errors are thrown. A missing folder throws `ENOENT` and a file `ENOTDIR`; an existing empty folder and the root give `[]`. Without a `prefix` the root (`''`, `'.'`) is the whole bucket. A nonexistent bucket rejects with the SDK's `NoSuchBucket` error (in every method), not `ENOENT`.

### stat and StorageStats

```ts
import { StorageStats } from 'nestjs-multi-storage';

const info: StorageStats = await storage.stat('reports/a.csv');
info.isFile(); // true
info.size;
info.mtime;
info.contentType; // S3 only, e.g. 'text/csv'
info.etag; // S3 only, without the surrounding quotes
```

`StorageStats` extends `fs.StatsBase<number>`; a real `fs.Stats` is assignable to it. On the filesystem it is the real `fs.Stats`.

On S3 the following are real: `size` (object size), `mtime` (`LastModified`), `contentType`, `etag`. Everything else is synthesized:

- `atime`, `ctime`, `birthtime` (and the `*Ms` variants) equal `mtime`.
- `mode` is `0o644` for files and `0o755` for folders (with the matching `S_IFREG` / `S_IFDIR` bits); `uid`, `gid`, `dev`, `ino`, `rdev` are `0`; `nlink` is `1`; `blksize` is `4096`; `blocks` is `ceil(size / 512)`.
- A path is a folder if a `folder/` marker or any object under that prefix exists. Folders have `size` 0 and `mtime` of the marker, or `new Date(0)` for implicit folders. The storage root always exists.
- `isSymbolicLink()`, `isFIFO()`, etc. return `false`.

### copyFile

```ts
import { constants } from 'fs';

await storage.copyFile('a.txt', 'b.txt');

// Fail with EEXIST if the destination already exists
await storage.copyFile('a.txt', 'b.txt', constants.COPYFILE_EXCL);
```

Signature is `copyFile(src, dest, mode?, bucket?)`. On S3 the source must be a file (a folder throws `EISDIR`, a missing path `ENOENT`), content type and metadata are preserved, and copying a file onto itself is a no-op. Copying onto an existing folder throws `EISDIR`.

### rename and moving

```ts
await storage.rename('inbox/a.txt', 'archive/a.txt'); // file
await storage.rename('inbox', 'archive/inbox'); // folder, including its contents
```

The same call moves a file between folders. Semantics follow `fs.rename`: a file overwrites an existing file; renaming onto an existing folder throws `EISDIR`; a folder onto a file throws `ENOTDIR`; a folder onto a non-empty folder throws `ENOTEMPTY`; a folder into itself throws `EINVAL`. On the filesystem and memory backends the destination's parent folder must exist (as with `fs.rename`, otherwise `ENOENT`), while on S3 it does not have to. See [the notes below](#how-s3-differs-from-a-real-filesystem) for cost and atomicity.

### Streams

```ts
import { pipeline } from 'stream/promises';

// Range read: bytes 0..1023 inclusive
const head = storage.createReadStream('video.mp4', { start: 0, end: 1023 });

// Serve a stream from a controller
// return new StreamableFile(storage.createReadStream('video.mp4'));

// Upload by piping
await pipeline(
  source, // any Readable, e.g. an incoming file stream
  storage.createWriteStream('uploads/video.mp4', { contentType: 'video/mp4' }),
);
```

On S3:

- `createReadStream` returns immediately; request errors are emitted as `'error'` on the stream (a missing key as `ENOENT`). `encoding` calls `setEncoding` on the stream. Omitting `end` reads to the end of the object.
- `createWriteStream` performs a multipart upload. `'finish'` is emitted once, after the upload has completed, so awaiting `pipeline` (or a `'finish'` listener) means the object exists. Upload failures are emitted as `'error'`, and destroying the stream aborts the upload.
- `options.partSize` is at least 5 MiB (the default); `options.queueSize` defaults to 4. If `contentType` is not given it is looked up from the file name.
- A missing bucket makes both methods throw synchronously.
- Paths outside `prefix` (or the bucket root) make both methods throw synchronously.

### Signed URLs

S3 only; both throw in every other mode (filesystem, memory, ftp, sftp). `expiresIn` is in seconds and defaults to 60. If `endpointCDN` and `endpoint` are both set, the host in the URL is replaced by the CDN host.

```ts
const downloadUrl = await storage.getSignedUrl('reports/a.csv', {
  expiresIn: 300,
  responseContentDisposition: 'attachment; filename="report.csv"',
  responseContentType: 'text/csv',
  bucket: 'other-bucket', // optional
});

const uploadUrl = await storage.getSignedPutUrl('uploads/photo.jpg', {
  expiresIn: 600,
  contentType: 'image/jpeg', // the client must then send the same Content-Type
});
```

### The s3client getter

`storage.s3client` (on every S3 `StorageDisk`) exposes the underlying `S3Client` for anything the `fs`-style API does not cover. It is `undefined` in every mode but S3. It is created when the module initializes, so use it after `onModuleInit`.

```ts
import { PutObjectTaggingCommand } from '@aws-sdk/client-s3';

await storage.s3client?.send(
  new PutObjectTaggingCommand({
    Bucket: 'my-bucket',
    Key: 'media/a.txt', // raw key: the prefix is NOT applied for you
    Tagging: { TagSet: [{ Key: 'kind', Value: 'draft' }] },
  }),
);
```

### Per-call bucket

On S3 every method falls back to the configured `bucket`; pass a different one to address another bucket with the same client and credentials. For methods with an `fs` options parameter it is `options.bucket`; for `exists`, `rename` and `copyFile` it is the last positional argument; `getSignedUrl` / `getSignedPutUrl` use `opts.bucket`. If neither is set, an `Error` is thrown. The `prefix` still applies.

```ts
await storage.writeFile('a.txt', 'hello', { bucket: 'other-bucket', contentType: 'text/plain' });
await storage.readFile('a.txt', { encoding: 'utf8', bucket: 'other-bucket' });
await storage.stat('a.txt', { bucket: 'other-bucket' });
await storage.exists('a.txt', 'other-bucket');
await storage.copyFile('a.txt', 'b.txt', undefined, 'other-bucket'); // mode is skipped with undefined
```

Copies and renames stay within one bucket. With [multiple disks](#multiple-disks) you can instead configure one disk per bucket.

## How S3 differs from a real filesystem

- **Keys never start with `/`.** Leading slashes are stripped from every path, so `'/uploads/x.png'` is the key `uploads/x.png`, and `'/'` is the root, not a folder of its own. Objects that were stored under a key starting with `/` (written by an older version without a `prefix`) are not reachable until renamed, see [Upgrading from 0.4.x](CHANGELOG.md#upgrading-from-04x).
- **Folders are implicit.** S3 has only objects. A folder exists if a `folder/` marker object or any key with that prefix exists. `mkdir` writes the marker. Writing `a/b/c.txt` does not require `a/b` to exist (the equivalent `fs` call would fail with `ENOENT`), and does not create markers for `a` or `b`. `readdir`, `stat` and `exists` still see those folders. A folder that only exists through its objects disappears with its last object.
- **`rename` is copy plus delete, and not atomic.** It costs as much as the data size. Objects over 5 GiB are copied with multipart copy, and a folder rename copies 8 objects at a time. What happens on failure:
  - Folder, a copy fails: the destination keys this call wrote are removed again (best effort, `DeleteObjects` in batches of 1000), the source is untouched and the original error is rethrown. A pre-existing empty destination folder keeps its marker. If that cleanup fails too, the original error is still thrown, with the cleanup failure attached as `error.cleanupError`.
  - Folder, the delete of the originals fails (after all copies succeeded): this cannot be rolled back. The folder then exists at both places and the error is thrown; delete the leftovers or retry the delete yourself.
  - Single file: a failed copy changes nothing. If the delete of the source fails after a successful copy, the file exists at both places.
  - Requests: a single file costs 4 requests in 3 round trips, whether or not the destination exists: 2 `LIST`s that run in parallel (the source, which also yields its size and storage class, and the destination, to detect a folder there), 1 `CopyObject` and 1 `DeleteObject`. `copyFile` costs 3 requests in 2 round trips (`COPYFILE_EXCL` adds 1 `HEAD`). A file over 5 GiB replaces the `CopyObject` with `HEAD`, `GetObjectTagging`, `CreateMultipartUpload`, one `UploadPartCopy` per part and `CompleteMultipartUpload`. A folder with `n` objects (the folder marker counts as one) costs `n + 2 * ceil(n / 1000) + 6` requests, with or without a marker: 6 lookups (the 2 parallel `LIST`s, then `HEAD` and `LIST` for the source folder and for the destination), `ceil(n / 1000)` `LIST` pages, `n` `CopyObject` and `ceil(n / 1000)` `DeleteObjects`. `stat` and `exists` cost 1 `HEAD` for a file and 2 requests (`HEAD` and 1 `LIST`) for a folder or a missing path.
- **Copies keep the storage class.** `rename` and `copyFile` write the destination with the source's storage class (e.g. `STANDARD_IA`, `GLACIER_IR`) instead of resetting it to `STANDARD`. Objects in `GLACIER` or `DEEP_ARCHIVE` cannot be copied until they are restored: S3's `InvalidObjectState` error is thrown unchanged.
- **Tags** are kept by `CopyObject`. For copies over 5 GiB (multipart) they are read with `GetObjectTagging` and set on the new upload, which needs the `s3:GetObjectTagging` permission; without it (or on a provider without tagging) the copy still succeeds, but without tags.
- **`COPYFILE_EXCL`** checks the destination first and also sends `If-None-Match: *`, which makes it race-safe on providers that honor it (AWS does; some compatible servers ignore it, hence the pre-check).
- **Emulated error codes:** `ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY`, `EINVAL` and `ERR_FS_EISDIR` (`rm` on a folder without `recursive`), with `code`, `errno`, `syscall` and `path` (and `dest` for two-path calls) set, using the same `code` and `syscall` Node reports (`open` for `readFile` / `createReadStream`, `lstat` for `rm` and recursive `rmdir`, `scandir` for `readdir`, `rmdir`, `mkdir`, ...). Errors that have no `fs` equivalent (permissions, network, a nonexistent bucket) surface as the S3 SDK's errors.
- **Deliberate deviations from `fs`:**
  - `mkdir` defaults to `recursive: true` and `rmdir` to `recursive: true` (it behaves like `fs.rm(path, { recursive: true })`), on both backends, so that existing code does not break.
  - `exists` throws on errors other than "not found" (403, network, ...), where `fs.existsSync` returns `false`.
  - A missing parent folder is fine on S3 for `writeFile`, `copyFile`, `rename` and recursive `mkdir`.
  - `stat` fields other than size, `mtime`, `contentType` and `etag` are synthesized.
  - `readdir` output is sorted on S3 (and de-duplicated); the filesystem order is whatever `fs` returns.
  - `readdir` does not support `withFileTypes`; `readFile` / `writeFile` ignore `flag`, `mode` is ignored on S3, and `mkdir` resolves to `undefined` on S3.
- **No real metadata.** Ownership, permissions and timestamps other than `mtime` are synthesized (see [stat](#stat-and-storagestats)).
- **S3-compatible providers** (MinIO, Cloudflare R2, Hetzner, ...) may reject the AWS SDK's default checksums, which breaks multipart uploads. When `endpoint` is set, `requestChecksumCalculation` and `responseChecksumValidation` therefore default to `'WHEN_REQUIRED'`, so you do not need to set them (usually `forcePathStyle: true` is still needed). To opt back in to the SDK defaults, set either option to `'WHEN_SUPPORTED'` explicitly; without `endpoint` (plain AWS) the SDK defaults apply anyway:

```ts
StorageModule.forRoot({
  type: 's3',
  endpoint: 'https://minio.example.com',
  region: 'us-east-1',
  bucket: 'my-bucket',
  accessKeyId: 'minio',
  secretAccessKey: 'minio-secret',
  forcePathStyle: true,
});
```

## FTP and SFTP

Both backends behave like the filesystem backend, not like S3: folders are real, a missing parent folder is `ENOENT`, writing below a file is `ENOTDIR`, and failures are the same Node-style errors (`ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY`, `EINVAL`, `ERR_FS_EISDIR`, and `EACCES` on SFTP). `readdir` supports `recursive` (folders are included, as paths relative to the folder) and `mkdir` / `rmdir` default to `recursive: true` as everywhere. `prefix` is the remote base directory: absolute, or relative to the login directory (`'.'` is the login directory itself); paths escaping it throw. The directory itself is never created, so it must exist. Signed URLs are not supported (`getSignedUrl` and `getSignedPutUrl` throw) and `s3client` is `undefined`. `bucket` options are ignored. `readFile` and `writeFile` buffer the whole file in memory; use the streams for large files.

```ts
const partner = storage.disk('partner'); // the sftp disk of the multi-disk example
await partner.mkdir('2026/11');
await partner.writeFile('2026/11/invoice.pdf', pdf);
const names = await partner.readdir('2026', { recursive: true }); // ['11', '11/invoice.pdf']
```

### FTP

- **Connection pool.** Up to `maxConnections` (default 2) connections are opened, lazily, on first use. A FTP connection runs one command or transfer at a time, so every operation and every open stream holds one connection until it ends. With `maxConnections: 1` an open stream blocks all other operations until it has ended or been destroyed; consume or destroy streams you open. Further callers wait in line for a free connection.
- **Reconnect and retry.** A connection the server dropped while idle is replaced transparently. If a connection dies during an operation, the operation is retried once on a new connection, except for operations that are not safe to repeat (appending with `flag: 'a'`, `copyFile`, `rename`) and for streams.
- **`rename`** is server-side (`RNFR` / `RNTO`). `rename` onto an existing file works as `fs.rename` does (the target is replaced); on servers that refuse it, the target is deleted first, which is not atomic.
- **`copyFile`** is a download followed by an upload through a temporary file in `os.tmpdir()` (FTP has no server-side copy), so it needs local disk space for the file. The temporary file is removed afterwards.
- **`COPYFILE_EXCL` and `flag: 'wx'`** are checked before the upload and are not atomic: another client can create the file in between.
- **Metadata.** `stat` reports the size, `mtime` with second precision (`MDTM`) and the fixed modes `0o644` (file) and `0o755` (folder), uid and gid `0`. Folders report an `mtime` of epoch 0 unless the server supports `MLSD`. `atime`, `ctime` and `birthtime` equal `mtime`.
- **Not supported or ignored:** `mkdir` `mode` (and `writeFile` / `createWriteStream` `mode`). Symbolic links are treated as files and are not followed.
- **Streams.** `createReadStream` supports `start` (a `REST` offset) and `end` (applied on the client: the connection is closed once enough bytes have arrived, and a new one is opened for the next operation). `createWriteStream` emits `'finish'` only after the upload has completed on the server. Destroying a stream before its end drops the connection; a partly uploaded file may stay on the server.
- **`timeout`** is the network timeout of the control and data connections, in milliseconds.
- **FTPS.** `secure: true` upgrades the control connection with `AUTH TLS`; `'implicit'` connects with TLS from the start (usually port 990).
- **Passive mode** is used for data transfers, so the server's passive port range must be reachable from your app.

### SFTP

- **One shared connection.** A single SSH connection with one SFTP channel is opened lazily and shared by all operations (SFTP multiplexes requests, so parallel calls and streams do not block each other). When it drops, the next operation reconnects. Reads (`readFile`, `stat`, `exists`, `readdir`) that fail because the connection was lost are retried once on a new connection; writes, `rename`, `rm` and streams are not retried.
- **Authentication.** `password`, or a `privateKey` (PEM or OpenSSH format, string or Buffer) with an optional `passphrase`. The server is always verified through `hostKey`, see below.
- **`rename`** uses OpenSSH's `posix-rename` extension when the server offers it: a file then replaces an existing target atomically. Without it the target is deleted first and then the rename is done, which is not atomic: if the rename fails, the target is already gone.
- **`copyFile`** is a download followed by an upload (not server-side), so the data passes through your app, and the file mode is not copied. `COPYFILE_EXCL` is checked first and also sent to the server as the exclusive open flag.
- **`flag: 'wx'`** is passed to the server as the exclusive open flag (`EEXIST` if the file exists).
- **Metadata.** `stat` has the real `mode`, `uid`, `gid`, `atime` and `mtime` of the server (`ctime` and `birthtime` equal `mtime`), and `mkdir` / `writeFile` / `createWriteStream` honor `mode`. `stat` follows symbolic links; `rm` and `rename` act on the link itself.
- **Streams.** `createReadStream` supports `start` and `end` natively (both inclusive). `createWriteStream` emits `'finish'` only after the file is closed on the server; destroying it before that deletes the partial file (not for append mode).
- **`timeout`** limits connecting and the SSH handshake (`readyTimeout`) and sets the keepalive: a ping every third of `timeout` (default without it: every 10 s). A connection that dies silently is dropped after about 4 unanswered intervals: the requests in flight reject and the next operation reconnects. Individual requests have no timeout of their own.
- **`TCP_NODELAY`** is enabled on the connection. Without it, Nagle's algorithm and delayed ACKs made every request take a multiple of 40 ms. Nothing to configure.
- **Errors.** Permission problems are `EACCES`. `exists` throws on errors other than "not found" (permissions, network), where `fs.existsSync` returns `false`.

### The SFTP host key

`hostKey` is required: the connection is only accepted if the server's host key hashes to this fingerprint, which is what protects you from connecting to an impostor. Pass the `SHA256:<base64>` form that OpenSSH prints (the MD5 `aa:bb:...` form is not accepted). If the key does not match, connecting fails with `sftp host key mismatch: expected SHA256:..., got SHA256:...`. A missing or malformed `hostKey` fails at startup.

Get the fingerprint from the server's administrator or provider, or from the key file when you run the server:

```bash
# On the server (or from the provider's documentation), for the ed25519 host key
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
# 256 SHA256:3Xl5JCm6hnQZd0Gt1sdQkzJV7dr5CYLK6Z5eiGOWmHo root@server (ED25519)
```

Or ask the running server for its keys, and compare the result with what the provider published before you trust it:

```bash
ssh-keyscan -t ed25519 sftp.example.com | ssh-keygen -lf -
```

The fingerprint is the second word of the output (`SHA256:...`). The server may have several host keys (ed25519, rsa, ecdsa); use the one the client negotiates. If you get a mismatch, the error message shows the fingerprint it received, to compare against the other keys of the server.

`hostKey: false` disables the verification. Anyone who can intercept the connection can then impersonate the server and read or change your data and credentials (a man-in-the-middle attack). Use it only for throwaway tests on a trusted network.

## Error handling

Failures that have a filesystem equivalent are Node-style errors with a string `code` (`ENOENT`, `EEXIST`, ...) on every backend. Use the structural guard `isStorageError` (it works with Node's and memfs's own errors too, and is `false` for AWS SDK errors) instead of `catch (error: any)`:

```ts
import { isStorageError } from 'nestjs-multi-storage';

try {
  await storage.readFile('missing.txt');
} catch (e) {
  if (isStorageError(e, 'ENOENT')) {
    console.log(e.path, e.syscall); // typed as StorageError
  } else {
    throw e;
  }
}
```

`isStorageError(e)` without a code accepts any error with a string `code`. `StorageErrorCode` lists the codes the library emulates (`ENOENT`, `EACCES`, `EEXIST`, `ENOTDIR`, `EISDIR`, `EINVAL`, `ENOTEMPTY`, `ERR_FS_EISDIR`; `EACCES` is reported by the SFTP backend); any string is accepted. `StorageError` also has `cleanupError`, see [`rename`](#how-s3-differs-from-a-real-filesystem).

## Testing your app with the memory backend

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
    await storage.writeFile('reports/a.txt', 'done');
    expect(await storage.readdir('reports')).toEqual(['a.txt']);
  });
});
```

Memory mode runs the same code as the filesystem backend on top of memfs, so it behaves like `fileSystem`: same methods, options and Node-style errors (`ENOENT`, `EEXIST`, `ENOTEMPTY`, `ERR_FS_EISDIR`, ...), and `prefix` escapes are rejected. Without a `prefix` the store root is `/`, whatever the working directory is (so `'..'` is clamped at `/`). A few memfs gaps are patched so that results match Node's `fs`. Known deviations:

- Permission bits differ: `stat().mode` has `0o666` for files and `0o777` for folders instead of Node's umask-dependent `0o644` / `0o755`.
- Signed URLs are not available (they throw, like in filesystem mode) and `s3client` is `undefined`.
- Nothing is persisted: data lives as long as the service instance.

## Testing

```bash
npm run test:e2e        # all five backends
npm run test:e2e:fast   # memory and fileSystem only, no Docker
E2E_BACKENDS=sftp,memory npm run test:e2e   # selected backends
```

The e2e suite runs the same behaviour tests against every backend; `memory` and `fileSystem` always run. For S3, FTP and SFTP, Docker starts the servers automatically (adobe/s3mock, delfer/alpine-ftp-server and atmoz/sftp, on free ports, removed after the run). `E2E_BACKENDS` is a comma-separated list of `fileSystem`, `memory`, `s3`, `ftp` and `sftp` (case-insensitive; default: all), and only the containers of the selected backends are started.

To use servers you already have instead of containers, set the variables of that service:

| Service | Variables                                                                                                                                                                                                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S3      | `S3_TEST_ENDPOINT`. The bucket `test` must exist.                                                                                                                                                                                                                  |
| FTP     | `FTP_TEST_HOST`, and optionally `FTP_TEST_PORT` (21), `FTP_TEST_USERNAME` (`anonymous`), `FTP_TEST_PASSWORD`, `FTP_TEST_DIR` (a writable base directory, relative to the login directory; default: the login directory).                                           |
| SFTP    | `SFTP_TEST_HOST` and `SFTP_TEST_HOST_KEY` (the `SHA256:<base64>` fingerprint, mandatory), and optionally `SFTP_TEST_PORT` (22), `SFTP_TEST_USERNAME` and `SFTP_TEST_PASSWORD` (`test`), `SFTP_TEST_DIR` (a writable directory, default `/upload`).                 |
| SFTP    | For the key authentication suites: `SFTP_TEST_KEY_PATH`, `SFTP_TEST_ENCRYPTED_KEY_PATH` (private key files the test user can log in with) and `SFTP_TEST_KEY_PASSPHRASE` (the passphrase of the second one). Those suites are skipped for keys that are not given. |

Without Docker (and without the matching variables) the suites of a service are skipped with a console message, unless `REQUIRE_S3_TESTS=1` (or `true`) is set, in which case the run fails instead. The flag covers S3, FTP and SFTP; the release workflow sets it.

## Releasing

Bump the version in `package.json`, add a [CHANGELOG.md](CHANGELOG.md) entry and push to `main`. The `auto-release.yml` workflow then lints, builds and tests on Node 22 and 24, and only if both pass publishes to npm via [trusted publishing](https://docs.npmjs.com/trusted-publishers) (no token, with provenance) and creates the GitHub release from the changelog section. Prerelease versions such as `0.6.0-beta.1` are published under the `next` tag and marked as prereleases on GitHub.

One-time setup in the npm package settings (Trusted Publisher, GitHub Actions): organization or user `jonathanarezki`, repository `nestjs-multi-storage`, workflow filename `auto-release.yml`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md). Upgrading from 0.4.x? Read [Upgrading from 0.4.x](CHANGELOG.md#upgrading-from-04x) first: it requires Node >= 22, and `prefix` now applies to S3 keys and rejects paths outside it.

## License

[MIT](LICENSE)
