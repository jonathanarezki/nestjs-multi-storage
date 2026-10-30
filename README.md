# nestjs-multi-storage

[![npm version](https://img.shields.io/npm/v/nestjs-multi-storage.svg)](https://www.npmjs.com/package/nestjs-multi-storage)
[![license](https://img.shields.io/npm/l/nestjs-multi-storage.svg)](LICENSE)

A storage module for NestJS whose `StorageService` mirrors the function names and parameters of Node's `fs.promises`. Code written against `fs` can switch to `storage.` and run against the local filesystem, an S3-compatible object store or an in-memory store. In filesystem mode each method is the corresponding `fs` call; in S3 mode the `fs` semantics are emulated, including Node-style error codes (`ENOENT`, `EEXIST`, ...).

## Features

- `fs`-compatible API: `readFile`, `writeFile`, `readdir`, `stat`, `copyFile`, `rename`, `mkdir`, `rm`, `rmdir`, `exists`, `createReadStream`, `createWriteStream`.
- Three backends: the local filesystem, AWS S3 or any S3-compatible provider (MinIO, Cloudflare R2, Hetzner, ...), and an in-memory store (`memory`, backed by `memfs`) for unit tests without disk, Docker or credentials.
- Streams, including range reads, and a write stream that emits `'finish'` only after the upload has completed.
- Signed GET and PUT URLs (S3).
- Optional CDN endpoint (`endpointCDN`) used for `readFile` and signed URLs.
- Prefix scoping: confine the service to a directory (filesystem) or key prefix (S3); paths escaping it are rejected.

## Requirements

- Node.js >= 22
- NestJS 11 (`@nestjs/common` and `@nestjs/core` `^11.0.0`)

## Installation

```bash
npm install nestjs-multi-storage
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
      prefix: './uploads', // optional: all paths are relative to this directory
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

Both `forRoot` and `forRootAsync` accept an extra `isGlobal` flag (default `false`). When `true`, `StorageService` is available everywhere without importing `StorageModule` again.

```ts
StorageModule.forRoot({ isGlobal: true, type: 'fileSystem', prefix: './uploads' });
```

### Using the service

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

`type` is the only required option. Unknown values of `type` fall back to the filesystem.

| Option                       | Type                                  | Applies to | Description                                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                       | `'fileSystem' \| 's3' \| 'memory'`    | all        | Selects the backend. `'memory'` needs the optional peer dependency `memfs`.                                                                                                                                                                                                                                      |
| `prefix`                     | `string`                              | all        | Root of the storage. A directory on the filesystem, a key prefix on S3 (leading and trailing `/` or `\` are stripped). Paths resolving outside it throw an `Error`. In memory mode it is a directory inside the in-memory volume (relative prefixes are resolved under `/`). Default: none (`/` in memory mode). |
| `files`                      | `Record<string, string \| Buffer>`    | memory     | Pre-populates the in-memory store. Keys are paths relative to `prefix` (parent folders are created, keys escaping the prefix throw), values are the file contents. Default: empty.                                                                                                                               |
| `bucket`                     | `string`                              | S3         | Default bucket. Can be overridden per call, see [per-call bucket](#per-call-bucket).                                                                                                                                                                                                                             |
| `region`                     | `string`                              | S3         | AWS region. If omitted, the AWS SDK default resolution applies (`AWS_REGION`, shared config, ...).                                                                                                                                                                                                               |
| `endpoint`                   | `string`                              | S3         | Custom endpoint URL, for S3-compatible providers.                                                                                                                                                                                                                                                                |
| `forcePathStyle`             | `boolean`                             | S3         | Use path-style addressing (`https://host/bucket/key`). Often required by MinIO and similar. Default: the SDK default.                                                                                                                                                                                            |
| `accessKeyId`                | `string`                              | S3         | Access key. Credentials are used only when both `accessKeyId` and `secretAccessKey` are set; otherwise the AWS default credential chain is used (environment variables, IAM roles, `~/.aws`).                                                                                                                    |
| `secretAccessKey`            | `string`                              | S3         | Secret key. See `accessKeyId`.                                                                                                                                                                                                                                                                                   |
| `endpointCDN`                | `string`                              | S3         | CDN host that replaces `endpoint` in URLs. Used by `readFile` (which then downloads via the CDN) and by `getSignedUrl` / `getSignedPutUrl`. Only takes effect when `endpoint` is set as well; otherwise `readFile` reads directly from S3.                                                                       |
| `requestChecksumCalculation` | `'WHEN_SUPPORTED' \| 'WHEN_REQUIRED'` | S3         | Passed to the S3 client. Set to `'WHEN_REQUIRED'` for providers that reject the SDK's default CRC32 checksums. Default: the SDK default.                                                                                                                                                                         |
| `responseChecksumValidation` | `'WHEN_SUPPORTED' \| 'WHEN_REQUIRED'` | S3         | Passed to the S3 client. Same purpose as above.                                                                                                                                                                                                                                                                  |

The S3 client is created in `onModuleInit` and destroyed in `onModuleDestroy`. With no `bucket` (and none passed per call), S3 calls throw `No bucket configured: pass a bucket or set the bucket option`.

Paths are always relative to `prefix`. With a prefix set, `'../x'` throws in all modes. Without a prefix, the filesystem backend uses paths as given (relative to the working directory) and the S3 backend uses them as keys; there, a path escaping the bucket root (`'../x'`, also `'/../x'`) throws.

On S3, leading slashes are stripped (and `\` is treated as `/`): `'/a.txt'`, `'a.txt'` and `'//a.txt'` are the same object, `'/dir/'` and `'dir'` the same folder. `'/'` is the bucket root (or the prefix root) and behaves exactly like `''`. The filesystem backend keeps plain `fs` semantics, where `'/a.txt'` is an absolute path.

## API reference

Parameters mirror `fs.promises`. Where `fs` has an options parameter, the S3 `bucket` is a key of that options object; where it has none (`exists`, `rename`, `copyFile`), `bucket` is an extra trailing parameter. A plain string in an options position is an encoding, as in `fs`. In filesystem mode `bucket` (and the S3-only options) are ignored.

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
| `getSignedUrl(path, opts?)`                                                                                            | `Promise<string>`                                        | S3 only. Throws in filesystem and memory mode. `opts.bucket`.                                                                                                                |
| `getSignedPutUrl(path, opts?)`                                                                                         | `Promise<string>`                                        | S3 only. Throws in filesystem and memory mode. `opts.bucket`.                                                                                                                |
| `s3client`                                                                                                             | `S3Client \| undefined`                                  | Getter. `undefined` in filesystem and memory mode.                                                                                                                           |

`mkdir` resolves to the first directory created on the filesystem (as `fs` does) and to `undefined` on S3.

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

The same call moves a file between folders. Semantics follow `fs.rename`: a file overwrites an existing file; renaming onto an existing folder throws `EISDIR`; a folder onto a file throws `ENOTDIR`; a folder onto a non-empty folder throws `ENOTEMPTY`; a folder into itself throws `EINVAL`. See [the notes below](#how-s3-differs-from-a-real-filesystem) for cost and atomicity.

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

S3 only; both throw in filesystem and memory mode. `expiresIn` is in seconds and defaults to 60. If `endpointCDN` and `endpoint` are both set, the host in the URL is replaced by the CDN host.

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

`storage.s3client` exposes the underlying `S3Client` for anything the `fs`-style API does not cover. It is `undefined` in filesystem and memory mode. It is created when the module initializes, so use it after `onModuleInit`.

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

Copies and renames stay within one bucket.

## How S3 differs from a real filesystem

- **Keys never start with `/`.** Leading slashes are stripped from every path, so `'/uploads/x.png'` is the key `uploads/x.png`, and `'/'` is the root, not a folder of its own. Objects that were stored under a key starting with `/` (written by an older version without a `prefix`) are not reachable until renamed, see [Upgrading from 0.4.x](CHANGELOG.md#upgrading-from-04x).
- **Folders are implicit.** S3 has only objects. A folder exists if a `folder/` marker object or any key with that prefix exists. `mkdir` writes the marker. Writing `a/b/c.txt` does not require `a/b` to exist (the equivalent `fs` call would fail with `ENOENT`), and does not create markers for `a` or `b`. `readdir`, `stat` and `exists` still see those folders. A folder that only exists through its objects disappears with its last object.
- **`rename` is copy plus delete.** It is not atomic, it costs as much as the data size, and a failure can leave copies behind. A folder rename copies every object (8 at a time) and deletes the originals only after all copies succeeded. Objects over 5 GiB are copied with multipart copy.
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
- **S3-compatible providers** (MinIO, Cloudflare R2, Hetzner, ...) may reject the AWS SDK's default checksums, which breaks multipart uploads. Use `requestChecksumCalculation: 'WHEN_REQUIRED'` and `responseChecksumValidation: 'WHEN_REQUIRED'`, and usually `forcePathStyle: true`:

```ts
StorageModule.forRoot({
  type: 's3',
  endpoint: 'https://minio.example.com',
  region: 'us-east-1',
  bucket: 'my-bucket',
  accessKeyId: 'minio',
  secretAccessKey: 'minio-secret',
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});
```

## Testing your app with the memory backend

`type: 'memory'` keeps all files in a private in-memory volume ([memfs](https://github.com/streamich/memfs)), so unit tests need no disk, Docker or S3 credentials. Every `StorageService` instance gets its own empty store, so a fresh Nest testing module starts from scratch and tests cannot leak data into each other.

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
npm run test:e2e
```

The e2e suite runs against all backends; the memory backend always runs. For S3 it starts an S3 mock with Docker automatically, or uses the server at `S3_TEST_ENDPOINT` if set. Without Docker the S3 tests are skipped, unless `REQUIRE_S3_TESTS=1` (or `true`) is set, in which case the run fails instead; the release workflow sets it.

## Releasing

Bump the version in `package.json`, add a [CHANGELOG.md](CHANGELOG.md) entry and push to `main`. The `auto-release.yml` workflow then lints, builds and tests, publishes to npm via [trusted publishing](https://docs.npmjs.com/trusted-publishers) (no token, with provenance) and creates the GitHub release from the changelog section. Prerelease versions such as `0.6.0-beta.1` are published under the `next` tag and marked as prereleases on GitHub.

One-time setup in the npm package settings (Trusted Publisher, GitHub Actions): organization or user `jonathanarezki`, repository `nestjs-multi-storage`, workflow filename `auto-release.yml`.

## Changelog

See [CHANGELOG.md](CHANGELOG.md). Upgrading from 0.4.x? Read [Upgrading from 0.4.x](CHANGELOG.md#upgrading-from-04x) first: it requires Node >= 22, and `prefix` now applies to S3 keys and rejects paths outside it.

## License

[MIT](LICENSE)
