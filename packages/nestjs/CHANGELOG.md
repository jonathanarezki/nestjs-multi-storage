# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Releases before 0.5.0 are listed on the [GitHub releases page](https://github.com/jonathanarezki/node-multi-storage/releases).

## [0.8.0] - 2026-11-03

### Upgrading from 0.7.x

- **BREAKING:** The per-call `bucket` is removed. It was an option of `mkdir`, `readdir`, `rmdir`, `rm`, `stat`, `readFile`, `writeFile`, `createReadStream` and `createWriteStream`, the last parameter of `exists`, `rename` and `copyFile`, and `opts.bucket` of `getSignedUrl` and `getSignedPutUrl`. `StorageBucketOptions` is removed too. An S3 disk now always uses the `bucket` of its configuration, which is required (a disk without it throws `type 's3' requires "bucket"` when it is created, instead of `No bucket configured` on the first call). To use several buckets, configure one disk per bucket:

  ```ts
  // Before
  StorageModule.forRoot({ type: 's3', bucket: 'my-uploads' }); // storage: the injected StorageService
  await storage.writeFile('a.txt', 'hello', { bucket: 'my-exports' });
  await storage.exists('a.txt', 'my-exports');

  // After
  StorageModule.forRoot({
    default: 'uploads',
    disks: {
      uploads: { type: 's3', bucket: 'my-uploads' },
      exports: { type: 's3', bucket: 'my-exports' },
    },
  }); // storage: the injected StorageService
  await storage.disk('exports').writeFile('a.txt', 'hello');
  await storage.disk('exports').exists('a.txt');
  ```

### Added

- **Custom drivers (experimental).** `StorageModule.forRoot` and `forRootAsync` accept disks of the type `{ type: 'custom', driver }` (a `StorageDriver` instance or a synchronous factory, created lazily) and the `wrap` option on every disk type. `StorageDriver`, `StorageCustomDiskOptions`, the `Driver*Options` types, `createFsError`, `createRmDirectoryError` and `createStats` are re-exported from the core. The driver interface is experimental in 0.8.x. See the [core README](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md#custom-drivers-experimental).

### Changed

- `readdir` results are always sorted, `createReadStream` with `start > end` throws on every backend, and unknown encodings are rejected with `ERR_INVALID_ARG_VALUE` (all BREAKING for code that relied on the old behaviour; see the core changelog).
- `getSignedUrl` and `getSignedPutUrl` on non-S3 disks now reject with the error code `ERR_STORAGE_NOT_SUPPORTED` (see the [core changelog](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/CHANGELOG.md)).

## [0.7.0] - 2026-11-02

The NestJS wrapper now sits on top of the new framework-agnostic [`@webbar/node-multi-storage`](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md) package, which holds the implementation. The public API is identical to 0.6.0, with one breaking change to the dependencies (see below). The source moved to the renamed repository, [node-multi-storage](https://github.com/jonathanarezki/node-multi-storage), a monorepo with the packages `@webbar/node-multi-storage` and `nestjs-multi-storage`.

### Upgrading from 0.6.x

- **BREAKING:** The AWS SDK is now an optional peer dependency instead of a regular dependency. If you use `type: 's3'`, install it yourself: `npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner`. Without these packages an s3 disk fails at startup with `type 's3' requires the optional peer dependencies "@aws-sdk/client-s3", "@aws-sdk/lib-storage" and "@aws-sdk/s3-request-presigner": npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner` (prefixed with `Storage disk "name": ` when you configure several disks). Projects that do not use S3 install about 150 packages and 20 MB of `node_modules` less.
- TypeScript: `s3client` is still typed `S3Client`. A project without the AWS SDK that compiles with `skipLibCheck: false` fails with `error TS2307: Cannot find module '@aws-sdk/client-s3' or its corresponding type declarations.` from `storage-disk.d.ts`. Install `@aws-sdk/client-s3`, or set `skipLibCheck: true` (Nest's default).
- Nothing else changes: `StorageModule.forRoot` / `forRootAsync`, `StorageService`, `StorageDisk`, `@InjectStorage`, `getStorageToken`, `isStorageError` and the exported types keep their API.

### Changed

- FTP disks now reconnect on the next operation after `destroy()`, like S3 and SFTP. Before, they rejected with `The ftp storage has been destroyed`. `destroy()` still closes the connections and rejects the callers that are waiting for a connection.
- The package is now built on [`@webbar/node-multi-storage`](https://www.npmjs.com/package/@webbar/node-multi-storage), which contains the storage, the drivers, the errors and the types; `nestjs-multi-storage` only adds the module, the service and the decorator, and re-exports `StorageDisk`, `isStorageError` and the types.
- `StorageService` now has public `init()` and `destroy()` methods (it extends the core `Storage`). Nest still calls them through `onModuleInit` / `onModuleDestroy`. This is additive.
- Lazy initialisation: every driver connects or creates its client on first use, so `init()` is optional. In a Nest app nothing changes, because `onModuleInit` still calls `init()`: `storage.s3client` is set once the module has initialized. Outside the module lifecycle (for example a testing module that is only compiled) it is `undefined` until the first operation, and again after `destroy()`.
- The source and the issue tracker moved to the renamed repository, https://github.com/jonathanarezki/node-multi-storage. The old URLs redirect.

### Added

- The framework-agnostic core is published as [`@webbar/node-multi-storage`](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/CHANGELOG.md) (new in 0.7.0), for plain Node, Next.js (Node runtime) and other frameworks. This package depends on it.
- README: split into a Nest-specific README and the [core README](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/core/README.md), which now holds the file API, backends and options.

## [0.6.0] - 2026-11-02

This release is non-breaking: existing single-store configurations and code work unchanged.

### Added

- Multiple named disks. `StorageModule.forRoot` / `forRootAsync` accept `{ default: 'uploads', disks: { uploads: {...}, tmp: {...} } }` (`StorageMultiDiskOptions`) next to the existing single-store options, which become one disk named `'default'`. `isGlobal` stays at the top level. Invalid configurations (empty `disks`, unknown `default`, empty disk name, non-object disk) fail at startup, and disk construction errors are prefixed with `Storage disk "name": `.
- `StorageDisk`: one named store with the complete file API and `s3client` (no `disk()`).
- `StorageService.disk(name)` and `StorageService.diskNames`. `StorageService` is the default disk; an unknown name throws `Unknown storage disk "x". Configured disks: a, b`.
- `@InjectStorage('name')` and `getStorageToken('name')` to inject (or look up and override in tests) a `StorageDisk`. `forRoot` registers a token per disk name.
- `forRootAsync({ disks: ['uploads', 'tmp'] })`: the names to make injectable, as they are only known after the factory has run. Without `disks`, no disk tokens are registered (`StorageService` and `storage.disk(name)` still work).
- The config types `StorageMultiDiskOptions`, `StorageDiskOptions` and `StorageConfig`.
- FTP and SFTP backends (`type: 'ftp'` and `type: 'sftp'`). They behave like the filesystem backend: real folders, Node-style errors, recursive `readdir`; signed URLs are not supported. Each needs an optional peer dependency that you install only if you use it: `basic-ftp` for ftp and `ssh2` for sftp (`type 'ftp' requires the optional peer dependency "basic-ftp": npm install basic-ftp` when it is missing). New options: `host`, `port`, `username`, `password`, `timeout` (both), `secure` (FTPS) and `maxConnections` (ftp), `privateKey`, `passphrase` and `hostKey` (sftp); `prefix` is the remote base directory. sftp sends keepalive pings (every 10 s, or a third of `timeout`), so a silently dead connection is dropped and the next operation reconnects.
- sftp requires `hostKey`, the server's `SHA256:<base64>` fingerprint (as printed by `ssh-keygen -lf`), and fails the connection on a mismatch; `hostKey: false` explicitly disables the verification, which allows man-in-the-middle attacks. See the new "FTP and SFTP" README section.
- `EACCES` (permission denied, reported by sftp) in `StorageErrorCode`.
- README: new "Multiple disks" and "FTP and SFTP" sections, and an updated "Testing" section (`E2E_BACKENDS`, FTP and SFTP servers, `test:e2e:fast`).

### Changed

- Internally the filesystem, memory and S3 backends are now separate driver classes behind `StorageService` / `StorageDisk`. There is no behaviour change.
- `@nestjs/common` is now only a peer dependency (it was also a regular dependency, which could install a second copy of Nest). No action needed: every Nest app already has it.

## [0.5.1] - 2026-10-30

### Added

- `StorageError` (an `Error` with `code`, `errno?`, `syscall?`, `path?`, `dest?`, `cleanupError?`), the `StorageErrorCode` union of the emulated codes and the structural type guard `isStorageError(error, code?)`. It also recognizes the errors of the filesystem and memory backends, and is `false` for AWS SDK errors. See the new "Error handling" README section.

### Changed

- When `endpoint` is set, `requestChecksumCalculation` and `responseChecksumValidation` now default to `'WHEN_REQUIRED'` (each independently), so S3-compatible providers work without setting them. Explicit values still win; set `'WHEN_SUPPORTED'` to opt back in to the SDK defaults. Without `endpoint` the SDK defaults are unchanged.
- S3 `rename` / `copyFile` and the folder lookups behind `stat`, `exists`, `rm`, `rmdir`, `readdir` and `mkdir` need fewer requests, and `rename` / `copyFile` run their source and destination lookups in parallel: a file `rename` takes 4 requests in 3 round trips (was 6, or 4 over an existing file), `copyFile` 3 requests in 2 round trips, and `stat` of a folder or a missing path 2 requests (was 2 to 3). A folder `rename` costs `n + 2 * ceil(n / 1000) + 6` requests. Error codes and their precedence are unchanged.
- README: documented the request cost of an S3 `rename`, that it is not atomic, and that the destination's parent folder must exist on the filesystem and memory backends.
- Releases are now tested on Node 22 and 24 before publishing.

### Fixed

- S3 `rename` and `copyFile` now keep the object's storage class (e.g. `STANDARD_IA`) instead of resetting it to `STANDARD`. Objects in `GLACIER` / `DEEP_ARCHIVE` still need a restore first: S3's `InvalidObjectState` is thrown.
- S3 copies of objects over 5 GiB (multipart) now keep the object's tags (needs `s3:GetObjectTagging`; without it the copy continues without tags).
- A failed S3 folder `rename` no longer leaves copies behind: if a copy fails, the destination keys written by that call are deleted again (a pre-existing empty destination folder is kept), the source is untouched, so a retry no longer fails with `ENOTEMPTY`. The original error is rethrown; a failing cleanup is attached as `error.cleanupError`.

## [0.5.0] - 2026-10-30

### Upgrading from 0.4.x

- **BREAKING:** Node.js >= 22 is now required (`engines`). The AWS SDK now in use itself requires Node 20+.
- **BREAKING:** The `prefix` option is now applied to S3 object keys. Previously it only applied to the filesystem and was ignored for S3. If you set `prefix` with `type: 's3'`, you will now read and write under `<prefix>/...`. Move existing objects to the new keys, or remove `prefix`.
- **BREAKING:** When a `prefix` is set, any path that resolves outside it (e.g. `'../x'`) now throws an `Error`, in both filesystem and S3 mode. Without a `prefix`, behaviour is unchanged.
- **BREAKING:** Method parameters now mirror `fs.promises` exactly. Where `fs` has an options parameter, `bucket` moved into that options object: `readFile`, `writeFile`, `readdir`, `mkdir`, `rmdir`, `rm`, `stat`, `createReadStream` and `createWriteStream`. `exists`, `rename` and `copyFile` keep a trailing `bucket` parameter, `getSignedUrl` / `getSignedPutUrl` keep `opts.bucket`.

  ```ts
  // 0.4.x
  await storage.writeFile('a.txt', 'hi', 'other-bucket', 'text/plain');
  await storage.readFile('a.txt', 'other-bucket');
  await storage.readdir('dir', 'other-bucket');
  await storage.createReadStream('a.txt', { start: 0, end: 9 }, 'other-bucket');

  // 0.5.0
  await storage.writeFile('a.txt', 'hi', { bucket: 'other-bucket', contentType: 'text/plain' });
  await storage.readFile('a.txt', { bucket: 'other-bucket' });
  await storage.readdir('dir', { bucket: 'other-bucket' });
  await storage.createReadStream('a.txt', { start: 0, end: 9, bucket: 'other-bucket' });
  ```

- **BREAKING:** The `mimetype` parameter of `writeFile` is now the `contentType` option.
- **BREAKING:** A plain string in an options position now means what it means in `fs`, an encoding, not a bucket (`readFile(path, 'utf8')` returns a string). `readFile` returns a `string` when an encoding is given, otherwise a `Buffer`.
- **BREAKING:** S3 now throws Node-style errors (`ENOENT`, `ENOTDIR`, `EEXIST`, `ENOTEMPTY`, `ERR_FS_EISDIR`) where it used to succeed silently or throw SDK errors: `readFile` / `createReadStream` on a missing key (`ENOENT`, was `NoSuchKey`), `rm` / `rmdir` / `readdir` on a missing path (`ENOENT`, was a no-op or `[]`), `rm` on a folder without `recursive` (`ERR_FS_EISDIR`), `readdir` on a file (`ENOTDIR`), `mkdir` on a file (`EEXIST`). `rm` on S3 now also removes folders with `recursive: true`.
- **BREAKING:** `exists` on S3 now returns `true` for implicit folders and throws on errors other than "not found" (403, network) instead of returning `false`. Calls without a configured or passed bucket throw `No bucket configured: pass a bucket or set the bucket option`.
- **BREAKING:** Without a `prefix`, S3 keys escaping the bucket root (`'../x'`, also `'/../x'`) now throw.
- **BREAKING:** On S3, leading slashes are now stripped from every key and folder path (a backslash counts as a slash), so `'/a.txt'`, `'a.txt'` and `'//a.txt'` are the same object, `'/dir/'` and `'dir'` the same folder, and `'/'` is the bucket root (or the prefix root), exactly like `''`. Before, without a `prefix`, the leading slash was part of the key. Objects that were stored that way (written without a `prefix` using paths like `'/uploads/x.png'`, which created the key `/uploads/x.png`) are no longer reachable through the library until they are renamed. Run the following once, before upgrading. It is not needed if a `prefix` was set, or if your keys never started with `/`. The filesystem backend is unchanged.

  ```ts
  import { CopyObjectCommand, DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

  const s3 = new S3Client({
    /* same endpoint, region and credentials as the module */
  });
  const Bucket = 'my-bucket';

  let ContinuationToken: string | undefined;
  do {
    // Keys starting with '/' form one contiguous range, so Prefix: '/' lists exactly those
    const page = await s3.send(new ListObjectsV2Command({ Bucket, Prefix: '/', ContinuationToken }));
    // A key consisting only of slashes has no target name and is left alone
    const keys = (page.Contents ?? []).map((object) => object.Key!).filter((key) => key.replace(/^\/+/, ''));
    for (const key of keys) {
      const dest = key.replace(/^\/+/, '');
      await s3.send(
        new CopyObjectCommand({
          Bucket,
          Key: dest,
          // CopySource is URL-encoded per path segment
          CopySource: `${Bucket}/${key.split('/').map(encodeURIComponent).join('/')}`,
        }),
      );
    }
    // Delete the originals of this page only after all its copies succeeded
    if (keys.length) {
      await s3.send(
        new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }),
      );
    }
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
  ```

  The copy overwrites an existing object at the target key (e.g. `/a.txt` replaces `a.txt`), so check for such pairs first if both exist. `CopyObject` handles objects up to 5 GiB; larger ones need a multipart copy.

- The S3 `prefix` is normalized: leading and trailing `/` or `\` are stripped, so `'/media/'` and `'media'` are equivalent.
- For S3, `storage.s3client` is now always defined. Credentials are optional: when `accessKeyId`/`secretAccessKey` are omitted, the AWS default credential chain is used (env vars, IAM roles, shared config). Missing region or endpoint configuration now surfaces as an SDK error on the first call instead of a null dereference.
- The S3 `createWriteStream` return type is now `Writable` (previously inferred as `fs.WriteStream | PassThrough`).
- If you use an S3-compatible provider such as MinIO, Cloudflare R2 or Hetzner, set `requestChecksumCalculation` and `responseChecksumValidation` to `'WHEN_REQUIRED'` (see below).

### Added

- `type: 'memory'`: an in-memory backend for tests, built on [memfs](https://github.com/streamich/memfs) and running the same code as the filesystem backend. Each `StorageService` instance has its own isolated, empty store (root `/`, or `prefix`). The new `files` option (`Record<string, string | Buffer>`) pre-populates it. `memfs` is an optional peer dependency (`npm i -D memfs`), only loaded when `type: 'memory'` is used.
- `requestChecksumCalculation` and `responseChecksumValidation` options (`'WHEN_SUPPORTED'` | `'WHEN_REQUIRED'`), passed to the S3 client. Recent AWS SDK versions send CRC32 checksums by default, which some S3-compatible providers reject (e.g. multipart uploads fail).

  ```ts
  StorageModule.forRoot({
    type: 's3',
    // ...bucket, region, endpoint, credentials
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  ```

- Filesystem-like methods, with an optional trailing `bucket` for S3:
  - `rename(oldPath, newPath)` and `copyFile(src, dest, mode?)` (supports `fs.constants.COPYFILE_EXCL`).
  - `stat(path)` returning `StorageStats` (an `fs.Stats`-compatible type; S3 additionally sets `contentType` and `etag`).
  - `readdir(path, { recursive?, encoding?, bucket? })`.
  - `readFile`, `writeFile`, `readdir`, `mkdir`, `rmdir`, `rm`, `stat`, `createReadStream` and `createWriteStream` take `fs.promises`-style options (`encoding`, `flag`, `mode`, `recursive`, `force`, `start`, `end`, ...) with `bucket` as one of the keys; `writeFile` also takes `contentType`.
  - `rm(path, { force?, recursive? })` and `rmdir(path, { recursive? })` (`recursive: false` mirrors `fs.rmdir`). `mkdir` and `rmdir` default to `recursive: true`, a deliberate deviation from `fs`.
  - `writeFile` accepts `Uint8Array` data. The option types are exported (`StorageReadFileOptions`, `StorageWriteFileOptions`, ...).
  - `createReadStream` supports `encoding` on S3.
  - On S3, errors mimic Node's (`ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY`, `EINVAL`, with `code`, `errno`, `syscall` and `path`). Folders are implicit, so `stat` reports a folder when a `folder/` marker or any object under the prefix exists.
  - S3 `rename` is a copy followed by a delete: it is not atomic and costs as much as the data size. Objects over 5 GiB are copied with multipart copy.

### Changed

- `StorageService.mkdir` now resolves to `string | undefined` (previously a union including `PutObjectCommandOutput`).
- The `prefix` option is enforced for all methods, including signed URLs and streams (`createReadStream` and `createWriteStream` throw synchronously on paths outside the prefix).
- S3 listing now uses ListObjectsV2 instead of ListObjects (v1).
- Removed the unused `@types/node-fetch` dev dependency.
- Releases are published to npm automatically from GitHub Actions via trusted publishing, with provenance. The package now ships only `dist`, README, CHANGELOG and LICENSE (`files`).
- Updated all dependencies to their latest version within the current major (except `@types/node`, now 22.x to match the Node.js requirement). The AWS SDK minimum is now `^3.1160.0`.

### Fixed

- `readFile` via `endpointCDN` crashed because `node-fetch` was used but never declared as a dependency. It now uses Node's built-in `fetch` and throws on non-2xx responses (previously an error body could be returned as the file content).
- S3 `createWriteStream` emitted `'finish'` before the upload had completed, and emitted it twice. `'finish'` now fires once, after the upload completes. Upload errors are emitted as `'error'`, and destroying the stream aborts the multipart upload.
- S3 `rmdir` only deleted the first 1000 objects and failed on empty folders. It now paginates, deletes in batches of 1000, and throws if S3 reports per-object deletion errors.
- S3 `readdir` silently logged errors with `console.log` and returned partial results, and could stop paginating early. Errors are now thrown, pagination uses continuation tokens, and entries are de-duplicated.

- `readFile` only takes the CDN path when both `endpoint` and `endpointCDN` are set (it used to dereference an unset `endpoint`).
- S3 `exists` reported `false` for implicit folders and swallowed every error from the folder lookup.
- S3 `copyFile` with `COPYFILE_EXCL` and `src === dest` now throws `EEXIST`, like Node.
- S3 without a `prefix`: the bucket root (`''`, `'.'`) is now the whole bucket. `readdir('')` (also recursive), `stat('')`, `rm('', { recursive: true })` and `rmdir('')` used to address a key `./` and found nothing; `mkdir('')` is a no-op, and writing the root as a file throws `EISDIR`. A path of `'/'` no longer resolves to an empty object key (it used to be reported as a file, and `readFile('/')` returned the bucket listing).
- S3 methods now reject with the SDK's `NoSuchBucket` error for a nonexistent bucket instead of looking like a missing file, including for the root, which previously never touched the bucket.
- S3 `readFile` and `createReadStream` on a folder throw `EISDIR` (syscall `read`) like Node, instead of `ENOENT`.

### Security

- `npm audit` went from 30 vulnerabilities (2 critical, 9 high) to 0, by updating the AWS SDK and dev tooling within their current major versions.
