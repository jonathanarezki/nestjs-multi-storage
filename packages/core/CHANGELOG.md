# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The history before 0.7.0 is in the [nestjs-multi-storage changelog](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/nestjs/CHANGELOG.md): this package was extracted from nestjs-multi-storage 0.6.0, and the file API, backends, options and errors have the same behaviour there.

## [0.8.0] - 2026-11-03

### Upgrading from 0.7.x

- **BREAKING:** The per-call `bucket` is removed. It was an option of `mkdir`, `readdir`, `rmdir`, `rm`, `stat`, `readFile`, `writeFile`, `createReadStream` and `createWriteStream`, the last parameter of `exists`, `rename` and `copyFile`, and `opts.bucket` of `getSignedUrl` and `getSignedPutUrl`. `StorageBucketOptions` is removed too. An S3 disk now always uses the `bucket` of its configuration, which is required (a disk without it throws `type 's3' requires "bucket"` when it is created, instead of `No bucket configured` on the first call). To use several buckets, configure one disk per bucket:

  ```ts
  // Before
  const storage = createStorage({ type: 's3', bucket: 'my-uploads' });
  await storage.writeFile('a.txt', 'hello', { bucket: 'my-exports' });
  await storage.exists('a.txt', 'my-exports');

  // After
  const storage = createStorage({
    default: 'uploads',
    disks: {
      uploads: { type: 's3', bucket: 'my-uploads' },
      exports: { type: 's3', bucket: 'my-exports' },
    },
  });
  await storage.disk('exports').writeFile('a.txt', 'hello');
  await storage.disk('exports').exists('a.txt');
  ```

- **BREAKING:** `getSignedUrl` and `getSignedPutUrl` on the filesystem, memory, FTP and SFTP disks now reject with the code `ERR_STORAGE_NOT_SUPPORTED` (see Changed). Check `isStorageError(error, 'ERR_STORAGE_NOT_SUPPORTED')` instead of matching the old message.
- **BREAKING:** The package has an `exports` map (`.`, `./testing`, `./package.json`). Deep imports into `dist/` (`@webbar/node-multi-storage/dist/...`) no longer resolve; import from the package root.
- **BREAKING:** `createReadStream` with `start > end` now throws a `RangeError` (`ERR_OUT_OF_RANGE`) on every backend, like `fs.createReadStream`; before, the backends disagreed.
- **BREAKING:** An unknown `encoding` (for example `'utf-9'`) is rejected with `ERR_INVALID_ARG_VALUE`, like in `fs`, instead of being passed on or ignored.
- **BREAKING:** `readdir` results are always sorted (plain code-unit order of the UTF-8 names, as S3 already did), on every backend and custom driver. The filesystem backend and SFTP used to return them in directory order, and a recursive filesystem listing level by level. Code that relied on that order must sort itself or use another order explicitly.
- **BREAKING:** `readdir` on the filesystem backend with a non-UTF-8 `encoding` (`'hex'`, `'base64'`, `'buffer'`, ...) now re-encodes the UTF-8 names, like `fs.promises.readdir` does; it used to return them unchanged.

### Added

- **Custom drivers (experimental).** A disk of the new type `{ type: 'custom', driver }` is backed by your own `StorageDriver`: an instance, or a synchronous factory called lazily (on first use or by `init()`), at most once; `destroy()` never creates it. It works in single-disk and multi-disk configurations. `createStorage` rejects a `driver` that is neither an object nor a function, and checks a driver instance for the required methods right away (the missing ones are named); a factory's result is checked when it is created. `init` and `destroy` of the driver are optional. The interface is experimental in 0.8.x and may change in a minor release; see the README.
- **`wrap` option** on every disk type: `wrap: (inner: StorageDriver) => StorageDriver`, applied once when the driver is created, to add encryption, read-only access, logging or caching on top of any driver. `init()` and `destroy()` call the wrapper's method if it has one, else the inner driver's, so a wrapper that does not forward them does not leak connections. `s3client` still returns the client of a wrapped S3 disk.
- `getSignedUrl`, `getSignedPutUrl`, `createReadStream` and `createWriteStream` are optional in `StorageDriver`. Without `createReadStream`, `StorageDisk` streams the result of `readFile` (start / end / highWaterMark / encoding, errors as `'error'`); without `createWriteStream` it buffers the chunks in memory and calls `writeFile` when the stream ends.
- New exports, all experimental: `StorageDriver` and the `Driver*Options` types, `StorageCustomDiskOptions`, `createFsError`, `createRmDirectoryError` and `createStats`.
- **Conformance test kit** at `@webbar/node-multi-storage/testing` (experimental): `describeStorageDriver(name, { create, cleanup?, skip?, test? })` runs the fs-behaviour suite of this library (results, sorted listings and Node-style errors that all five built-in drivers share) against your `StorageDriver`, grouped by feature (`mkdir`, `readdir`, `readFile`, `stat`, `exists`, `rm`, `rmdir`, `copyFile`, `rename`, `rename-folder`, `streams`, `root`) so groups can be skipped. It works with Jest, Vitest and Mocha through their globals (or with explicitly passed test functions, e.g. for `node:test`), uses `node:assert/strict` and adds no dependency. The package declares `typesVersions` for `moduleResolution: node`, so `/testing` also resolves there.
- New error code `ERR_STORAGE_NOT_SUPPORTED` (part of `StorageErrorCode`), thrown for an operation the disk's driver does not implement.

### Changed

- `getSignedUrl` and `getSignedPutUrl` on the filesystem, memory, FTP and SFTP disks now reject with a typed error with the code `ERR_STORAGE_NOT_SUPPORTED` and the message `getSignedUrl is not supported by this disk` (or `getSignedPutUrl ...`), the same for every disk. Before, they were plain `Error`s without a `code` whose message named the storage type (`Signed URLs are not supported for ftp storage.`). Code that matched the old message must check `isStorageError(error, 'ERR_STORAGE_NOT_SUPPORTED')` instead.

## [0.7.0] - 2026-11-02

First release as a standalone package, extracted from [nestjs-multi-storage](https://www.npmjs.com/package/nestjs-multi-storage) 0.6.0 so that the storage can be used without NestJS: in plain Node, Express, Next.js (Node runtime only, not the Edge runtime) and other frameworks. The source lives in the [node-multi-storage](https://github.com/jonathanarezki/node-multi-storage) repository. `nestjs-multi-storage` 0.7.0 is now a thin wrapper around this package.

### Upgrading from nestjs-multi-storage 0.6.x

- **BREAKING:** The AWS SDK is an optional peer dependency (it was a regular dependency of nestjs-multi-storage). If you use `type: 's3'`, install it yourself: `npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner`. Without these packages an s3 disk fails at startup with `type 's3' requires the optional peer dependencies "@aws-sdk/client-s3", "@aws-sdk/lib-storage" and "@aws-sdk/s3-request-presigner": npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner` (prefixed with `Storage disk "name": ` when you configure several disks). Projects that do not use S3 install about 150 packages and 20 MB of `node_modules` less.
- TypeScript: `s3client` is still typed `S3Client`. A project without the AWS SDK that compiles with `skipLibCheck: false` fails with `error TS2307: Cannot find module '@aws-sdk/client-s3' or its corresponding type declarations.` from `storage-disk.d.ts`. Install `@aws-sdk/client-s3`, or set `skipLibCheck: true`.
- FTP disks now reconnect on the next operation after `destroy()`, like S3 and SFTP. Before, they rejected with `The ftp storage has been destroyed`. `destroy()` still closes the connections and rejects the callers that are waiting for a connection.

### Added

- `createStorage(config)` and the `Storage` class: the framework-agnostic multi-disk manager. `config` is a single store (`{ type: ... }`, the disk named `'default'`) or `{ default, disks }`. `Storage` is the default disk (the whole file API) plus `disk(name)`, `diskNames`, `init()` and `destroy()`.
- `StorageDisk`, all five backends (`fileSystem`, `s3`, `memory`, `ftp`, `sftp`), `StorageError`, `StorageErrorCode`, `isStorageError` and all option types (`StorageConfig`, `StorageModuleOptions`, `StorageDiskOptions`, `StorageMultiDiskOptions`, `StorageStats`, ...), with the behaviour of nestjs-multi-storage 0.6.0.
- Lazy initialisation: every driver connects or creates its client on first use, so no `init()` call is needed and `createStorage` does no I/O. `init()` is an optional warm-up (it creates the S3 clients). Call `destroy()` on shutdown where there is one; the storage stays usable afterwards, as S3, FTP and SFTP reconnect on the next operation. This suits serverless environments.
- Optional peer dependencies: `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` and `@aws-sdk/s3-request-presigner` (s3), `basic-ftp` (ftp), `ssh2` (sftp) and `memfs` (memory). The only mandatory dependency is `mime-types`.
- README: the full documentation, plus Lifecycle, Usage in Next.js, Usage in plain Node / Express and Using with NestJS.
