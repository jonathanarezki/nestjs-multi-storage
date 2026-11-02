# Changelog

All notable changes to this project are documented in this file. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

The history before 0.7.0 is in the [nestjs-multi-storage changelog](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/nestjs/CHANGELOG.md): this package was extracted from nestjs-multi-storage 0.6.0, and the file API, backends, options and errors have the same behaviour there.

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
