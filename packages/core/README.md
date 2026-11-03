# @webbar/node-multi-storage

[![npm version](https://img.shields.io/npm/v/@webbar/node-multi-storage.svg)](https://www.npmjs.com/package/@webbar/node-multi-storage)
[![license](https://img.shields.io/npm/l/@webbar/node-multi-storage.svg)](LICENSE)

A framework-agnostic multi-storage manager for Node whose `Storage` (and every named `StorageDisk`, see [Multiple disks](#multiple-disks)) mirrors the function names and parameters of Node's `fs.promises`. Code written against `fs` can switch to `storage.` and run against the local filesystem, an S3-compatible object store, an FTP or SFTP server or an in-memory store. On the filesystem each method is the corresponding `fs` call; in the other backends the `fs` semantics are emulated, including Node-style error codes (`ENOENT`, `EEXIST`, ...).

It has no framework dependency (its only mandatory dependency is `mime-types`) and works in plain Node, Express, Next.js (Node runtime only, see [Usage in Next.js](#usage-in-nextjs)) and any other Node framework. For NestJS there is a thin wrapper, see [Using with NestJS](#using-with-nestjs).

## Features

- `fs`-compatible API: `readFile`, `writeFile`, `readdir`, `stat`, `copyFile`, `rename`, `mkdir`, `rm`, `rmdir`, `exists`, `createReadStream`, `createWriteStream`.
- Five built-in backends (plus [your own drivers](#custom-drivers-experimental)): the local filesystem, AWS S3 or any S3-compatible provider (MinIO, Cloudflare R2, Hetzner, ...), an FTP or FTPS server (`ftp`, via `basic-ftp`), an SFTP server (`sftp`, via `ssh2`), and an in-memory store (`memory`, backed by `memfs`) for unit tests without disk, Docker or credentials. FTP and SFTP behave like the filesystem backend (real folders, the same Node-style errors), see [FTP and SFTP](#ftp-and-sftp).
- Multiple named disks: configure several stores (for example S3 plus SFTP plus local filesystem plus memory) with `createStorage({ default, disks })` and use them via the storage itself (the default disk) or `storage.disk('name')`. A single-store configuration is one disk.
- Lazy initialisation: connections and clients are created on first use, so there is nothing to start before the first call, which suits serverless. See [Lifecycle](#lifecycle).
- Streams, including range reads, and a write stream that emits `'finish'` only after the upload has completed.
- Signed GET and PUT URLs (S3).
- Optional CDN endpoint (`endpointCDN`) used for `readFile` and signed URLs.
- Prefix scoping: confine a disk to a directory (filesystem, FTP, SFTP) or key prefix (S3); paths escaping it are rejected.

## Requirements

- Node.js >= 22

## Installation

```bash
npm install @webbar/node-multi-storage
```

The drivers that need an extra library take it as an optional peer dependency. Install only what you use:

```bash
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner   # type: 's3'
npm install basic-ftp   # type: 'ftp'
npm install ssh2        # type: 'sftp'
npm install memfs       # type: 'memory' (usually as a dev dependency)
```

The `fileSystem` backend needs nothing. Projects without S3 therefore install about 150 packages and 20 MB of `node_modules` less than with a bundled AWS SDK.

An `s3` disk fails at startup when one of the three AWS packages is missing: `type 's3' requires the optional peer dependencies "@aws-sdk/client-s3", "@aws-sdk/lib-storage" and "@aws-sdk/s3-request-presigner": npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner` (with several disks, prefixed with `Storage disk "name": `). The other drivers report `type 'ftp' requires the optional peer dependency "basic-ftp": npm install basic-ftp`, and likewise for `ssh2` and `memfs`.

### TypeScript without the AWS SDK

`StorageDisk.s3client` is typed `S3Client`, so the declaration file `storage-disk.d.ts` imports `@aws-sdk/client-s3`. In a project that does not install the SDK and compiles with `skipLibCheck: false`, this fails with `error TS2307: Cannot find module '@aws-sdk/client-s3' or its corresponding type declarations.` Either install `@aws-sdk/client-s3` (types only are needed) or set `skipLibCheck: true` (the default in Nest and most project templates).

## Quick start

`createStorage` takes the configuration of one store (or several, see [Multiple disks](#multiple-disks)) and returns a `Storage`, which has the whole file API. No `init()` call is needed.

```ts
import { createStorage } from '@webbar/node-multi-storage';

const storage = createStorage({ type: 'fileSystem', prefix: './uploads' }); // ./uploads must already exist

await storage.writeFile('hello.txt', 'Hello');
console.log(await storage.readFile('hello.txt', 'utf8'));

await storage.destroy(); // on shutdown, see Lifecycle
```

### Filesystem

```ts
import { createStorage } from '@webbar/node-multi-storage';

const storage = createStorage({
  type: 'fileSystem',
  prefix: './uploads', // optional: all paths are relative to this directory, which must already exist
});
```

### S3

```bash
npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner
```

```ts
import { createStorage } from '@webbar/node-multi-storage';

const storage = createStorage({
  type: 's3',
  bucket: 'my-bucket',
  region: 'eu-west-1',
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
  prefix: 'media', // optional: all keys live under "media/"
});
```

### FTP

```bash
npm install basic-ftp
```

```ts
import { createStorage } from '@webbar/node-multi-storage';

const storage = createStorage({
  type: 'ftp',
  host: 'ftp.example.com',
  username: 'user',
  password: process.env.FTP_PASSWORD,
  secure: true, // optional: FTPS (explicit TLS); 'implicit' for implicit TLS
  prefix: 'exports', // optional: remote base directory, relative to the login directory
});
```

### SFTP

```bash
npm install ssh2
```

```ts
import { createStorage } from '@webbar/node-multi-storage';

const storage = createStorage({
  type: 'sftp',
  host: 'sftp.example.com',
  username: 'user',
  privateKey: process.env.SFTP_PRIVATE_KEY, // or password: ...
  hostKey: 'SHA256:3Xl5JCm6hnQZd0Gt1sdQkzJV7dr5CYLK6Z5eiGOWmHo', // required, see "The SFTP host key"
  prefix: '/upload', // optional: remote base directory
});
```

`hostKey` is required and a missing one fails at startup. See [FTP and SFTP](#ftp-and-sftp) for how to get the fingerprint and for the behaviour of both backends.

### Memory (for tests)

```bash
npm install --save-dev memfs
```

```ts
import { createStorage } from '@webbar/node-multi-storage';

const storage = createStorage({ type: 'memory' }); // empty, private, never touches the disk
```

See [Testing with the memory backend](#testing-with-the-memory-backend).

## Configuration

`type` is the only option that is always required (`host` for ftp and sftp, and `hostKey` for sftp, on top of it). Unknown values of `type` fall back to the filesystem. With [multiple disks](#multiple-disks) the same options apply to each disk. The FTP and SFTP options are in their own table below.

| Option                       | Type                                                              | Applies to | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`                       | `'fileSystem' \| 's3' \| 'memory' \| 'ftp' \| 'sftp' \| 'custom'` | all        | Selects the backend. `'memory'` needs the optional peer dependency `memfs`, `'ftp'` needs `basic-ftp` and `'sftp'` needs `ssh2`. `'custom'` uses your own driver, see [Custom drivers](#custom-drivers-experimental) (it only has `driver` and `wrap`, no other option).                                                                                                                                                                                                                                                                                                                        |
| `prefix`                     | `string`                                                          | all        | Root of the storage. A directory on the filesystem, a key prefix on S3 (leading and trailing `/` or `\` are stripped), the remote base directory on FTP and SFTP (relative to the login directory when relative, `'.'` is the login directory; it must exist). Paths resolving outside it throw an `Error`. On the filesystem the directory must already exist: the library does not create it, and the first write fails with `ENOENT` otherwise. In memory mode it is a directory inside the in-memory volume (relative prefixes are resolved under `/`). Default: none (`/` in memory mode). |
| `files`                      | `Record<string, string \| Buffer>`                                | memory     | Pre-populates the in-memory store. Keys are paths relative to `prefix` (parent folders are created, keys escaping the prefix throw), values are the file contents. Default: empty.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `wrap`                       | `(inner: StorageDriver) => StorageDriver`                         | all        | Experimental. Called once, when the disk's driver is first used, with the built-in driver: the returned driver is what the disk uses (encryption, read-only access, logging, caching, ...). See [Wrapping a driver](#wrapping-a-driver).                                                                                                                                                                                                                                                                                                                                                        |
| `driver`                     | `StorageDriver \| (() => StorageDriver)`                          | custom     | Experimental. Your driver, or a synchronous factory called lazily (on first use or by `init()`), at most once. Required. See [Custom drivers](#custom-drivers-experimental).                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `bucket`                     | `string`                                                          | S3         | The bucket of this disk (required). For another bucket, configure another disk, see [Several buckets](#several-buckets).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `region`                     | `string`                                                          | S3         | AWS region. If omitted, the AWS SDK default resolution applies (`AWS_REGION`, shared config, ...).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `endpoint`                   | `string`                                                          | S3         | Custom endpoint URL, for S3-compatible providers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `forcePathStyle`             | `boolean`                                                         | S3         | Use path-style addressing (`https://host/bucket/key`). Often required by MinIO and similar. Default: the SDK default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `accessKeyId`                | `string`                                                          | S3         | Access key. Credentials are used only when both `accessKeyId` and `secretAccessKey` are set; otherwise the AWS default credential chain is used (environment variables, IAM roles, `~/.aws`).                                                                                                                                                                                                                                                                                                                                                                                                   |
| `secretAccessKey`            | `string`                                                          | S3         | Secret key. See `accessKeyId`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `endpointCDN`                | `string`                                                          | S3         | CDN host that replaces `endpoint` in URLs. Used by `readFile` (which then downloads via the CDN) and by `getSignedUrl` / `getSignedPutUrl`. Only takes effect when `endpoint` is set as well; otherwise `readFile` reads directly from S3.                                                                                                                                                                                                                                                                                                                                                      |
| `requestChecksumCalculation` | `'WHEN_SUPPORTED' \| 'WHEN_REQUIRED'`                             | S3         | Passed to the S3 client. Default: `'WHEN_REQUIRED'` when `endpoint` is set (S3-compatible providers often reject the SDK's default CRC32 checksums), otherwise the SDK default. An explicit value always wins; set `'WHEN_SUPPORTED'` to opt back in to the SDK default on a custom endpoint.                                                                                                                                                                                                                                                                                                   |
| `responseChecksumValidation` | `'WHEN_SUPPORTED' \| 'WHEN_REQUIRED'`                             | S3         | Passed to the S3 client. Same defaults and purpose as above; the two options are defaulted independently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

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

The S3 client (one per S3 disk) is created on first use (or by the optional `init()`) and closed by `destroy()`, see [Lifecycle](#lifecycle). An S3 disk without `bucket` throws `type 's3' requires "bucket"` when it is created.

Paths are always relative to `prefix`. With a prefix set, `'../x'` throws in all modes. Without a prefix, the filesystem backend uses paths as given (relative to the working directory) and the S3 backend uses them as keys; there, a path escaping the bucket root (`'../x'`, also `'/../x'`) throws.

On S3, leading slashes are stripped (and `\` is treated as `/`): `'/a.txt'`, `'a.txt'` and `'//a.txt'` are the same object, `'/dir/'` and `'dir'` the same folder. `'/'` is the bucket root (or the prefix root) and behaves exactly like `''`. The filesystem backend keeps plain `fs` semantics, where `'/a.txt'` is an absolute path.

## Multiple disks

Use named disks when one app talks to several stores: user uploads on S3, scratch files on the local filesystem, a second bucket for exports, or a memory disk for a cache. Each disk has its own backend and options (prefix, bucket, credentials, endpoint). Everything below is optional: a plain `{ type: ... }` configuration is one disk named `'default'`.

```ts
import { createStorage } from '@webbar/node-multi-storage';

const storage = createStorage({
  default: 'uploads', // the disk the storage itself operates on
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
});

await storage.writeFile('a.txt', 'default disk');
await storage.disk('tmp').writeFile('b.txt', 'tmp disk');
await storage.disk('exports').writeFile('c.txt', 'looked up by name');
```

Every disk is a `StorageDisk`, which has the complete file API described in the [API reference](#api-reference) and `s3client`.

- The `Storage` returned by `createStorage` is itself the default disk (it extends `StorageDisk`) and has the whole file API. It also has `disk(name)`, `diskNames`, `init()` and `destroy()`.
- `storage.disk('name')` returns the `StorageDisk` of that name, the same instance on every call. `storage.disk('uploads')` (the default's name) is a separate `StorageDisk` object that shares the default disk's backend, so both see the same files. An unknown name throws `Unknown storage disk "x". Configured disks: uploads, exports, tmp, partner`. `storage.diskNames` lists the configured names (`['default']` for a single store).
- `StorageDisk` has no `disk()` method, and its constructor is internal: get disks from `storage.disk(name)`.

`disks` must not be empty, `default` must be one of its names, disk names must not be empty and every disk must be a configuration object; otherwise `createStorage` throws an error naming the problem. Errors while building a disk are prefixed with `Storage disk "name": `.

### Several buckets

Use one disk per bucket: a disk has exactly one bucket (the `bucket` option), and each disk can have its own prefix, endpoint and credentials. The methods take no per-call `bucket` (it was removed in 0.8.0).

```ts
const storage = createStorage({
  default: 'uploads',
  disks: {
    uploads: { type: 's3', bucket: 'my-uploads', region: 'eu-west-1' },
    exports: { type: 's3', bucket: 'my-exports', region: 'eu-west-1' },
  },
});

await storage.writeFile('a.txt', 'hello'); // my-uploads
await storage.disk('exports').writeFile('a.txt', 'hello'); // my-exports
```

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

## Custom drivers (experimental)

> **Experimental.** The `StorageDriver` interface, the `custom` disk type, `wrap` and the helpers below are experimental in 0.8.x and may change in a minor release.

A disk is backed by a driver. Besides the built-in ones you can plug in your own (WebDAV, Google Cloud Storage, a database, an in-process store, ...) with the `custom` type. `StorageDisk` keeps the whole fs-compatible API and does the work that does not depend on the backend, so a driver only deals with plain values.

```ts
import { createStorage } from '@webbar/node-multi-storage';

const storage = createStorage({ type: 'custom', driver: myDriver });

// or lazily: the factory is called on first use (or by init()), at most once
const lazy = createStorage({ type: 'custom', driver: () => new MyDriver(process.env.MY_URL!) });

// in a multi-disk configuration
const several = createStorage({
  default: 'local',
  disks: { local: { type: 'fileSystem', prefix: './data' }, mine: { type: 'custom', driver: () => new MyDriver() } },
});
```

`createStorage` rejects a `driver` that is neither an object nor a function (`Storage disk "mine": type 'custom' needs "driver": ...` in a multi-disk configuration). A driver given as an instance is checked for the required methods right away, so a missing one fails at `createStorage` time and is named; the result of a factory (and of `wrap`) is checked when it is created, on first use. A custom disk has no `prefix` or other options: the driver owns its configuration.

### The driver interface

| Method                                                     | Required | Description                                                                                              |
| ---------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `mkdir(path, { recursive, mode? })`                        | yes      | Returns the first folder created, or `undefined`.                                                        |
| `readdir(path, { recursive })`                             | yes      | The entry names (UTF-8), relative to `path`, in any order (the disk sorts them).                         |
| `rmdir(path, { recursive })`                               | yes      |                                                                                                          |
| `stat(path)`                                               | yes      | A `StorageStats`: build it with `createStats`.                                                           |
| `exists(path)`                                             | yes      | Only "not found" is `false`; other failures are thrown.                                                  |
| `readFile(path, { flag? })`                                | yes      | A `Buffer`.                                                                                              |
| `writeFile(path, data, { mode?, flag?, contentType? })`    | yes      | `data` is a `Buffer`.                                                                                    |
| `rm(path, { force, recursive })`                           | yes      |                                                                                                          |
| `copyFile(src, dest, mode)`                                | yes      | `mode` is the bit field of `fs.copyFile` (`COPYFILE_EXCL`).                                              |
| `rename(oldPath, newPath)`                                 | yes      |                                                                                                          |
| `init()`, `destroy()`                                      | no       | Called by `storage.init()` / `storage.destroy()` if present. The driver must also work without `init()`. |
| `getSignedUrl(path, opts)`, `getSignedPutUrl(path, opts)`  | no       | Without them, `StorageDisk` throws `ERR_STORAGE_NOT_SUPPORTED`.                                          |
| `createReadStream(path, { start?, end?, highWaterMark? })` | no       | Without it, `StorageDisk` streams the result of `readFile`.                                              |
| `createWriteStream(path, options)`                         | no       | Without it, `StorageDisk` buffers the chunks and calls `writeFile` when the stream ends.                 |

The contract:

- **Normalized input.** `StorageDisk` applies defaults and shorthands first, so the driver gets plain option objects (`recursive` and `force` are always booleans), `Buffer`s (never strings or `Uint8Array`s) and returns `Buffer`s; encodings are applied by `StorageDisk`. Names are UTF-8. `start <= end` is already checked.
- **Order is the disk's.** `readdir` may return names in any order; `StorageDisk` sorts them (plain code-unit order of the UTF-8 names) before applying the encoding, so every disk returns sorted results.
- **Paths are yours.** The path is passed as the caller gave it. Resolving it (a prefix, `..`, leading slashes) and rejecting paths that escape your root is the driver's job.
- **Node-style errors.** Failures are errors with a string `code`, like those of `fs.promises` (`ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY`, `EINVAL`, `EACCES`, and `ERR_FS_EISDIR` for `rm` on a folder without `recursive`), so that `isStorageError` and code written against `fs` keep working. Build them with `createFsError(code, syscall, path?, dest?)` and `createRmDirectoryError(path)`. The per-method codes are documented in the JSDoc of `StorageDriver`.
- **Streams report failures as `'error'` events**, not thrown exceptions (only a bad argument throws synchronously).

### An example driver

A complete driver on a `Map` (no streams and no signed URLs: the fallbacks and the "not supported" error apply):

```ts
import * as fs from 'fs';
import { createFsError, createStats, createStorage, StorageDriver } from '@webbar/node-multi-storage';

function mapDriver(): StorageDriver {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>(['']);
  const kind = (p: string) => (files.has(p) ? 'file' : dirs.has(p) ? 'dir' : undefined);
  return {
    async mkdir(p) {
      dirs.add(p);
      return undefined;
    },
    async readdir(p) {
      return [...files.keys()].filter((k) => k.startsWith(p ? `${p}/` : '')).map((k) => k.slice(p ? p.length + 1 : 0));
    },
    async rmdir(p) {
      dirs.delete(p);
    },
    async stat(p) {
      const found = kind(p);
      if (!found) throw createFsError('ENOENT', 'stat', p);
      return createStats({
        mode: (found === 'file' ? fs.constants.S_IFREG : fs.constants.S_IFDIR) | 0o644,
        size: files.get(p)?.length ?? 0,
        mtime: new Date(),
      });
    },
    async exists(p) {
      return kind(p) !== undefined;
    },
    async readFile(p) {
      if (kind(p) === 'dir') throw createFsError('EISDIR', 'read', p);
      const data = files.get(p);
      if (!data) throw createFsError('ENOENT', 'open', p);
      return data;
    },
    async writeFile(p, data) {
      files.set(p, data);
    },
    async rm(p, { force }) {
      if (!files.delete(p) && !force) throw createFsError('ENOENT', 'rm', p);
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

const storage = createStorage({ type: 'custom', driver: mapDriver });
await storage.writeFile('a.txt', 'hello');
```

### Fallbacks and their cost

- **`createReadStream`** (missing): a `Readable` that calls `readFile` as soon as it is created, applies `start` / `end` (inclusive, like `fs`) and `highWaterMark`, and emits `ENOENT`, `EISDIR` and the other errors as `'error'`. `encoding` is applied by `StorageDisk` as for every driver.
- **`createWriteStream`** (missing): a `Writable` that **buffers all chunks in memory** and calls `writeFile` (with `contentType`) when the stream ends; `'finish'` is emitted once it has completed and a failure is emitted as `'error'`. String chunks are decoded with `encoding`. A stream destroyed before its end writes nothing.

Both fallbacks hold the whole file in memory: implement the stream methods in the driver for large files.

### Wrapping a driver

`wrap` is an option of every disk type. It is called once, when the driver is created (on first use or by `init()`), with the driver of the disk (the built-in one, or your custom driver) and returns the driver the disk uses instead. The result goes through the same required-methods check. Use it for encryption, read-only access, logging or caching on top of any backend. A wrapper has to forward every method it does not change. `init` and `destroy` follow one rule: if the wrapper defines the method it is called (and is responsible for forwarding to `inner`); if it does not, the method of the inner driver is called, so a wrapper that leaves them out does not leak the S3 client or the FTP / SFTP connections. `destroy()` still never creates a driver or a wrapper that was not used. Do not spread a class instance (`{ ...inner }` loses its prototype methods): bind or delegate the methods. To make `StorageDisk` use its stream fallbacks (so that the streams go through your `readFile` / `writeFile`), leave `createReadStream` and `createWriteStream` out of the wrapper.

```ts
import { createFsError, StorageDriver } from '@webbar/node-multi-storage';

// A read-only disk: reads and listings pass through, everything that changes something is EACCES
const readOnly = (inner: StorageDriver): StorageDriver => {
  const denied = (path: string) => createFsError('EACCES', 'open', path);
  return {
    readdir: (p, o) => inner.readdir(p, o),
    stat: (p) => inner.stat(p),
    exists: (p) => inner.exists(p),
    readFile: (p, o) => inner.readFile(p, o),
    createReadStream: inner.createReadStream?.bind(inner),
    mkdir: async (p) => Promise.reject(denied(p)),
    rmdir: async (p) => Promise.reject(denied(p)),
    writeFile: async (p) => Promise.reject(denied(p)),
    rm: async (p) => Promise.reject(denied(p)),
    copyFile: async (_src, dest) => Promise.reject(denied(dest)),
    rename: async (_from, to) => Promise.reject(denied(to)),
  };
};

const storage = createStorage({ type: 's3', bucket: 'backups', wrap: readOnly });
await storage.readFile('2026/db.dump'); // works
await storage.writeFile('x', 'y'); // rejects with EACCES
```

`storage.s3client` still returns the S3 client of a wrapped S3 disk. A logging wrapper that forwards every method is the same shape: call `inner.method(...)` after logging.

### Testing a custom driver

The package ships its fs-behaviour suite for driver authors, as the subpath `@webbar/node-multi-storage/testing`. It runs the behaviour that all five built-in drivers share (the Node-style results and errors listed above) against your driver, through `createStorage({ type: 'custom', driver })`, so the argument normalization and the stream fallbacks are covered too. It uses `node:assert/strict` and has no dependency on a test framework: `describe`, `it`, `beforeEach` and `afterEach` default to the globals of Jest, Vitest (with `globals: true`) and Mocha.

```ts
// my-driver.spec.ts (Jest, or Vitest with globals: true, or Mocha)
import { describeStorageDriver } from '@webbar/node-multi-storage/testing';
import { mkdtemp, rm } from 'node:fs/promises';
import { MyDriver } from './my-driver';

describeStorageDriver('MyDriver', {
  create: async () => new MyDriver({ root: await mkdtemp('/tmp/my-driver-') }),
  cleanup: async (driver) => rm((driver as MyDriver).root, { recursive: true, force: true }),
  skip: ['rename-folder'], // optional: groups your backend cannot satisfy
});
```

Vitest without globals (and `node:test`) take the test functions explicitly:

```ts
import { afterEach, beforeEach, describe, it } from 'vitest'; // or 'node:test'
import { describeStorageDriver } from '@webbar/node-multi-storage/testing';

describeStorageDriver('MyDriver', {
  create: () => new MyDriver(),
  test: { describe, it, beforeEach, afterEach },
});
```

Options:

```ts
interface DescribeStorageDriverOptions {
  create: () => StorageDriver | Promise<StorageDriver>;
  cleanup?: (driver: StorageDriver) => Promise<void> | void;
  skip?: string[]; // group names, see below; an unknown name throws
  test?: Partial<{
    describe: (name: string, fn: () => void) => unknown;
    it: (name: string, fn: () => any) => unknown;
    beforeEach: (fn: () => any) => unknown;
    afterEach: (fn: () => any) => unknown;
  }>;
}
```

**Every test needs a fresh, empty store.** `create` is called before each test and must return a driver on a new empty store (a new temporary folder, key prefix, database or in-memory instance): the suite does not clean up by itself, and the tests assume that the root `''` is an empty folder that exists. `cleanup(driver)` runs after the test (delete the temporary folder, drop the database, ...); the disk is destroyed afterwards, which calls `driver.destroy()` if you have one. Folders behave like on a real filesystem in the suite (a file is written into an existing folder, so the tests create the parent first): a backend with implicit folders, like S3, also passes.

`skip` takes the names of the groups below, each a `describe` block of the same name. `STORAGE_DRIVER_TEST_GROUPS` exports the list.

| Group           | What it checks                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------- |
| `root`          | the root `''` is an existing, empty folder                                                            |
| `mkdir`         | recursive by default, `EEXIST`, `ENOENT`, `ENOTDIR`                                                   |
| `readdir`       | listing, sorted listing, recursive listing with the ancestors, encodings, `ENOENT`, `ENOTDIR`         |
| `readFile`      | `readFile` / `writeFile`: encodings, Buffers, `Uint8Array`, overwriting, `ENOENT`, `EISDIR`           |
| `stat`          | files, folders, the `fs.Stats` shape, `ENOENT`                                                        |
| `exists`        | files, folders (also implicit ones), missing paths                                                    |
| `rm`            | recursive, `force`, `ERR_FS_EISDIR`, `ENOENT`                                                         |
| `rmdir`         | recursive by default, `ENOTEMPTY`, `ENOTDIR`, `ENOENT`                                                |
| `copyFile`      | overwriting, `COPYFILE_EXCL`, `ENOENT`, `EISDIR`, copying onto itself                                 |
| `rename`        | files: overwriting, onto itself, `EISDIR`, `ENOENT`                                                   |
| `rename-folder` | folders: nested content, `EINVAL`, `ENOTEMPTY`, `ENOTDIR`, onto an empty folder                       |
| `streams`       | `createReadStream` (range, encoding, errors) and `createWriteStream` (also the fallbacks of the disk) |

Not part of the suite, because the built-in drivers differ there: writing below a file or into a missing folder (S3 allows both), writing over a folder, the `flag` option of `writeFile`, content types, signed URLs and timestamps. Test those yourself. The suite is experimental like the rest of the interface and may grow between minor releases.

### Exported helpers

All experimental, like the interface:

| Export                                                   | Description                                                                                                                                                                                                                       |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StorageDriver`, `Driver*Options`                        | The interface and the option types of its methods (`DriverMkdirOptions`, `DriverReadFileOptions`, ...).                                                                                                                           |
| `StorageCustomDiskOptions`                               | The configuration type of a `custom` disk.                                                                                                                                                                                        |
| `createFsError(code, syscall, path?, dest?)`             | The Node-style error `fs` throws (`code`, `errno`, `syscall`, `path`, `dest` and a message like `ENOENT: no such file or directory, open '/a'`). Codes: `ENOENT`, `EACCES`, `EEXIST`, `ENOTDIR`, `EISDIR`, `EINVAL`, `ENOTEMPTY`. |
| `createRmDirectoryError(path)`                           | What `fs.rm` throws for a folder without `recursive` (`ERR_FS_EISDIR`).                                                                                                                                                           |
| `createStats({ mode, size, mtime, atime?, uid?, gid? })` | Builds a `StorageStats`; the `isFile()` / `isDirectory()` ... predicates come from the type bits of `mode` (`fs.constants.S_IFREG \| 0o644`).                                                                                     |

## Lifecycle

**No initialisation is needed.** Every driver connects or creates its client on first use: an S3 client is created by the first operation, FTP and SFTP connections are opened by the first operation, and the filesystem and memory backends have nothing to set up. `createStorage` itself does no I/O. `await storage.init()` is an optional warm-up of all disks: it creates the S3 clients eagerly (FTP and SFTP connect on first use either way, so it neither connects nor checks credentials).

**Call `destroy()` on shutdown** where there is a shutdown (a server's close hook, the end of a script, a `SIGTERM` handler). It closes the S3 clients and the FTP and SFTP connections of all disks. Every disk is closed even if closing one of them fails (the first error is then rethrown). Open FTP and SFTP connections can keep a script from exiting, so scripts should call it.

```ts
process.once('SIGTERM', async () => {
  await storage.destroy();
  process.exit(0);
});
```

A custom driver, or the `wrap` function of a disk, is created on first use or by `init()`; `destroy()` never creates one that was not used. `init()` and `destroy()` of the driver are called if it has them; for a wrapped disk, those of the wrapper if it has them, else those of the driver it wraps.

**After `destroy()` the storage stays usable.** S3, FTP and SFTP reconnect on the next operation (a new S3 client, new connections), so `destroy()` can be called after every unit of work in a serverless function without breaking the next one. `destroy()` rejects callers that were waiting for a free FTP connection with `The ftp storage has been destroyed`; operations started afterwards work. `storage.s3client` is `undefined` until the client has been created (by `init()` or the first operation) and again after `destroy()`.

## Usage in Next.js

The core has no Next.js dependency. Create the storage once, as a module-level singleton, and import it where you need it. Caching it on `globalThis` keeps development hot reloads from creating a new storage (and new connections) on every edit.

```ts
// lib/storage.ts
import { createStorage, Storage } from '@webbar/node-multi-storage';

const globalForStorage = globalThis as unknown as { storage?: Storage };

export const storage = (globalForStorage.storage ??= createStorage({
  type: 's3',
  bucket: process.env.S3_BUCKET,
  region: process.env.S3_REGION,
  accessKeyId: process.env.S3_ACCESS_KEY_ID,
  secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
}));
```

Use it in a Route Handler:

```ts
// app/api/files/[name]/route.ts
import { isStorageError } from '@webbar/node-multi-storage';
import { storage } from '@/lib/storage';

export const runtime = 'nodejs'; // required: the Edge runtime is not supported

export async function GET(_request: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  try {
    const data = await storage.readFile(`files/${name}`);
    return new Response(new Uint8Array(data));
  } catch (error) {
    if (isStorageError(error, 'ENOENT')) {
      return new Response('Not found', { status: 404 });
    }
    throw error;
  }
}
```

Or in a Server Action:

```ts
// app/actions.ts
'use server';

import { randomUUID } from 'crypto';
import { storage } from '@/lib/storage';

export async function upload(formData: FormData) {
  const file = formData.get('file');
  if (!(file instanceof File)) {
    throw new Error('No file');
  }
  const key = `uploads/${randomUUID()}`;
  await storage.writeFile(key, new Uint8Array(await file.arrayBuffer()), { contentType: file.type });
  return key;
}
```

Server Actions and Route Handlers on the default runtime run on Node, so they work as they are; put `export const runtime = 'nodejs'` on a route or page if the project defaults to something else.

**The Edge runtime is not supported**, because the core needs Node's `fs`, `net` and `stream` modules, which the Edge runtime does not have.

On serverless platforms a warm instance keeps the module-level singleton, and with it any open FTP or SFTP connection, between invocations; the platform may freeze or drop the instance, and the connection with it. A dropped connection is replaced on the next operation, and S3 needs no connection management at all. If you prefer not to hold connections between invocations, call `await storage.destroy()` at the end of the request; the next call reconnects.

## Usage in plain Node / Express

```ts
import express from 'express';
import { createStorage, isStorageError } from '@webbar/node-multi-storage';

const storage = createStorage({ type: 'fileSystem', prefix: './uploads' }); // ./uploads must already exist
const app = express();

app.get('/files/:name', (req, res) => {
  const stream = storage.createReadStream(req.params.name);
  stream.on('error', (error) => {
    res.status(isStorageError(error, 'ENOENT') ? 404 : 500).end();
  });
  stream.pipe(res);
});

app.put('/files/:name', express.raw({ type: '*/*', limit: '10mb' }), async (req, res) => {
  await storage.writeFile(req.params.name, req.body); // a Buffer, parsed by express.raw()
  res.sendStatus(204);
});

const server = app.listen(3000);
process.once('SIGTERM', () => {
  server.close(() => storage.destroy());
});
```

Names from a request are used as paths here for brevity: validate them (the `prefix` rejects paths that escape it, but not everything inside it is meant to be public).

## Using with NestJS

For NestJS there is [`nestjs-multi-storage`](https://www.npmjs.com/package/nestjs-multi-storage), a thin wrapper around this package with `StorageModule.forRoot` / `forRootAsync`, an injectable `StorageService` and `@InjectStorage('name')` for named disks. It calls `init()` and `destroy()` through Nest's lifecycle hooks and exposes the same file API, options and errors described here. See its [README](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/nestjs/README.md).

## API reference

The file methods below exist on `Storage` (the default disk) and, identically, on every `StorageDisk` (`storage.disk('name')`). Parameters mirror `fs.promises`. A plain string in an options position is an encoding, as in `fs`. The S3-only options are ignored by the other backends.

| Method                                                                                                        | Returns                                                  | S3 notes                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mkdir(path, { recursive?, mode? }?)`                                                                         | `Promise<string \| undefined>`                           | `recursive` defaults to `true` (unlike `fs`). Writes a `folder/` marker. `EEXIST` for a file; with `recursive: false` also for a folder, `ENOENT` for a missing parent.      |
| `readdir(path, encoding \| { recursive?, encoding? }?)`                                                       | `Promise<string[]>`                                      | Sorted. `ENOENT` for a missing folder, `ENOTDIR` for a file. `withFileTypes` is not supported.                                                                               |
| `rmdir(path, { recursive? }?)`                                                                                | `Promise<void>`                                          | `recursive` defaults to `true` (like `fs.rm(path, { recursive: true })`). Deletes in batches of 1000. `ENOENT` if missing; `recursive: false` gives `ENOTEMPTY` / `ENOTDIR`. |
| `rm(path, { force?, recursive? }?)`                                                                           | `Promise<void>`                                          | `ENOENT` unless `force`. A folder needs `recursive`, else `ERR_FS_EISDIR`.                                                                                                   |
| `stat(path)`                                                                                                  | `Promise<StorageStats>`                                  | Synthesized fields; adds `contentType` and `etag`. Throws `ENOENT`.                                                                                                          |
| `exists(path)`                                                                                                | `Promise<boolean>`                                       | `true` for an object, a marker or an implicit folder. Throws on errors other than "not found".                                                                               |
| `readFile(path, encoding \| { encoding?, flag? }?)`                                                           | `Promise<Buffer>`, or `Promise<string>` with an encoding | `ENOENT` for a missing key, `EISDIR` for a folder. Via `endpointCDN` if both it and `endpoint` are set. `flag` is ignored.                                                   |
| `writeFile(path, data, encoding \| { encoding?, mode?, flag?, contentType? }?)`                               | `Promise<void>`                                          | `data` is `string \| Buffer \| Uint8Array`. Content type is `contentType`, else looked up from the file name. `mode` and `flag` are ignored.                                 |
| `copyFile(src, dest, mode?)`                                                                                  | `Promise<void>`                                          | `CopyObject`, multipart copy above 5 GiB. Supports `COPYFILE_EXCL` (also for `src === dest`).                                                                                |
| `rename(oldPath, newPath)`                                                                                    | `Promise<void>`                                          | Copy then delete; works on files and folders.                                                                                                                                |
| `createReadStream(path, { start?, end?, highWaterMark?, encoding? }?)`                                        | `Readable`                                               | Ranged `GetObject`; `start` and `end` are inclusive. A missing key emits `ENOENT`, a folder `EISDIR`, as `'error'`.                                                          |
| `createWriteStream(path, { highWaterMark?, encoding?, flags?, mode?, partSize?, queueSize?, contentType? }?)` | `Writable`                                               | Multipart upload. `flags` and `mode` are ignored; `partSize`, `queueSize` and `contentType` are S3 only.                                                                     |
| `getSignedUrl(path, opts?)`                                                                                   | `Promise<string>`                                        | S3 only. Throws `ERR_STORAGE_NOT_SUPPORTED` in every other mode.                                                                                                             |
| `getSignedPutUrl(path, opts?)`                                                                                | `Promise<string>`                                        | S3 only. Throws `ERR_STORAGE_NOT_SUPPORTED` in every other mode.                                                                                                             |
| `s3client`                                                                                                    | `S3Client \| undefined`                                  | Getter. `undefined` in filesystem and memory mode.                                                                                                                           |

`mkdir` resolves to the first directory created on the filesystem (as `fs` does) and to `undefined` on S3.

### Disks and lifecycle

| Member                  | Returns         | Description                                                                                                                      |
| ----------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `createStorage(config)` | `Storage`       | Builds the storage from a single-store or multi-disk configuration. Same as `new Storage(config)`.                               |
| `Storage`               | class           | The default disk: the file API, plus `disk()`, `diskNames`, `init()` and `destroy()`.                                            |
| `storage.disk(name)`    | `StorageDisk`   | The disk of that name (same instance every time). Throws `Unknown storage disk "x". Configured disks: a, b` for an unknown name. |
| `storage.diskNames`     | `string[]`      | Names of all configured disks (`['default']` for a single store).                                                                |
| `storage.init()`        | `Promise<void>` | Optional warm-up of all disks (creates the S3 clients). Not required, see [Lifecycle](#lifecycle).                               |
| `storage.destroy()`     | `Promise<void>` | Closes the clients and connections of all disks. The storage stays usable: S3, FTP and SFTP reconnect on the next operation.     |
| `StorageDisk`           | class           | One named store: every file method above and `s3client`, but no `disk()`, `init()` or `destroy()`.                               |

Config types: `StorageModuleOptions` (one store), `StorageDiskOptions` (alias of it, the options of one disk), `StorageMultiDiskOptions` (`{ default: string; disks: Record<string, StorageDiskOptions> }`) and `StorageConfig` (either of the two). The option types of the methods (`StorageReadFileOptions`, `StorageWriteFileOptions`, `StorageReaddirOptions`, `StorageMkdirOptions`, `StorageRmdirOptions`, `StorageRmOptions`, `StorageCreateReadStreamOptions`, `StorageCreateWriteStreamOptions`, `StorageBucketOptions`) and `StorageStats` are exported as well.

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
```

On S3 the recursive result includes every ancestor folder of each object (`'2024'`, `'2024/jan'`, `'2024/jan/a.csv'`), like Node's recursive `readdir`. Results are de-duplicated, and listing errors are thrown. A missing folder throws `ENOENT` and a file `ENOTDIR`; an existing empty folder and the root give `[]`. Without a `prefix` the root (`''`, `'.'`) is the whole bucket. A nonexistent bucket rejects with the SDK's `NoSuchBucket` error (in every method), not `ENOENT`.

### stat and StorageStats

```ts
import { StorageStats } from '@webbar/node-multi-storage';

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

On S3 the source must be a file (a folder throws `EISDIR`, a missing path `ENOENT`), content type and metadata are preserved, and copying a file onto itself is a no-op. Copying onto an existing folder throws `EISDIR`.

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

// Serve a stream, e.g. from an Express handler: storage.createReadStream('video.mp4').pipe(res)

// Upload by piping
await storage.mkdir('uploads'); // not needed on S3; on fileSystem, memory, FTP and SFTP the folder must exist
await pipeline(
  source, // any Readable, e.g. an incoming file stream
  storage.createWriteStream('uploads/video.mp4', { contentType: 'video/mp4' }),
);
```

On S3:

- `createReadStream` returns immediately; request errors are emitted as `'error'` on the stream (a missing key as `ENOENT`). `encoding` calls `setEncoding` on the stream. Omitting `end` reads to the end of the object.
- `createWriteStream` performs a multipart upload. `'finish'` is emitted once, after the upload has completed, so awaiting `pipeline` (or a `'finish'` listener) means the object exists. Upload failures are emitted as `'error'`, and destroying the stream aborts the upload.
- `options.partSize` is at least 5 MiB (the default); `options.queueSize` defaults to 4. If `contentType` is not given it is looked up from the file name.
- Paths outside `prefix` (or the bucket root) make both methods throw synchronously.

### Signed URLs

S3 only; both throw in every other mode (filesystem, memory, ftp, sftp) and on any custom disk whose driver does not implement them: a typed error with the code `ERR_STORAGE_NOT_SUPPORTED` (`isStorageError(error, 'ERR_STORAGE_NOT_SUPPORTED')`) and the message `getSignedUrl is not supported by this disk`. `expiresIn` is in seconds and defaults to 60. If `endpointCDN` and `endpoint` are both set, the host in the URL is replaced by the CDN host.

```ts
const downloadUrl = await storage.getSignedUrl('reports/a.csv', {
  expiresIn: 300,
  responseContentDisposition: 'attachment; filename="report.csv"',
  responseContentType: 'text/csv',
});

const uploadUrl = await storage.getSignedPutUrl('uploads/photo.jpg', {
  expiresIn: 600,
  contentType: 'image/jpeg', // the client must then send the same Content-Type
});
```

### The s3client getter

`storage.s3client` (on every S3 `StorageDisk`) exposes the underlying `S3Client` for anything the `fs`-style API does not cover. It is `undefined` in every mode but S3. It is created on first use (or by `init()`), so it is `undefined` until then, and again after `destroy()`; call `await storage.init()` first if you need it right away.

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

## How S3 differs from a real filesystem

- **Keys never start with `/`.** Leading slashes are stripped from every path, so `'/uploads/x.png'` is the key `uploads/x.png`, and `'/'` is the root, not a folder of its own. Objects that were stored under a key starting with `/` (written by an older version without a `prefix`) are not reachable until renamed, see [Upgrading from 0.4.x](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/nestjs/CHANGELOG.md#upgrading-from-04x).
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
  - `readdir` output is always sorted (plain code-unit order, on every backend); on S3 it is also de-duplicated.
  - `readdir` does not support `withFileTypes`; `readFile` / `writeFile` ignore `flag`, `mode` is ignored on S3, and `mkdir` resolves to `undefined` on S3.
- **No real metadata.** Ownership, permissions and timestamps other than `mtime` are synthesized (see [stat](#stat-and-storagestats)).
- **S3-compatible providers** (MinIO, Cloudflare R2, Hetzner, ...) may reject the AWS SDK's default checksums, which breaks multipart uploads. When `endpoint` is set, `requestChecksumCalculation` and `responseChecksumValidation` therefore default to `'WHEN_REQUIRED'`, so you do not need to set them (usually `forcePathStyle: true` is still needed). To opt back in to the SDK defaults, set either option to `'WHEN_SUPPORTED'` explicitly; without `endpoint` (plain AWS) the SDK defaults apply anyway:

```ts
createStorage({
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

Both backends behave like the filesystem backend, not like S3: folders are real, a missing parent folder is `ENOENT`, writing below a file is `ENOTDIR`, and failures are the same Node-style errors (`ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY`, `EINVAL`, `ERR_FS_EISDIR`, and `EACCES` on SFTP). `readdir` supports `recursive` (folders are included, as paths relative to the folder) and `mkdir` / `rmdir` default to `recursive: true` as everywhere. `prefix` is the remote base directory: absolute, or relative to the login directory (`'.'` is the login directory itself); paths escaping it throw. The directory itself is never created, so it must exist. Signed URLs are not supported (`getSignedUrl` and `getSignedPutUrl` throw `ERR_STORAGE_NOT_SUPPORTED`) and `s3client` is `undefined`. `bucket` options are ignored. `readFile` and `writeFile` buffer the whole file in memory; use the streams for large files.

```ts
const partner = storage.disk('partner'); // the sftp disk of the multi-disk example
await partner.mkdir('2026/11');
await partner.writeFile('2026/11/invoice.pdf', pdf);
const names = await partner.readdir('2026', { recursive: true }); // ['11', '11/invoice.pdf']
```

### FTP

- **Connection pool.** Up to `maxConnections` (default 2) connections are opened, lazily, on first use. A FTP connection runs one command or transfer at a time, so every operation and every open stream holds one connection until it ends. With `maxConnections: 1` an open stream blocks all other operations until it has ended or been destroyed; consume or destroy streams you open. Further callers wait in line for a free connection.
- **Reconnect and retry.** A connection the server dropped while idle is replaced transparently, and after `destroy()` the next operation opens new connections. If a connection dies during an operation, the operation is retried once on a new connection, except for operations that are not safe to repeat (appending with `flag: 'a'`, `copyFile`, `rename`) and for streams.
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
import { isStorageError } from '@webbar/node-multi-storage';

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

`isStorageError(e)` without a code accepts any error with a string `code`. `StorageErrorCode` lists the codes the library emulates (`ENOENT`, `EACCES`, `EEXIST`, `ENOTDIR`, `EISDIR`, `EINVAL`, `ENOTEMPTY`, `ERR_FS_EISDIR`; `EACCES` is reported by the SFTP backend) and `ERR_STORAGE_NOT_SUPPORTED` (an operation the disk's driver does not implement, e.g. signed URLs outside S3); any string is accepted. `StorageError` also has `cleanupError`, see [`rename`](#how-s3-differs-from-a-real-filesystem).

## Testing with the memory backend

`type: 'memory'` keeps all files in a private in-memory volume ([memfs](https://github.com/streamich/memfs)), so unit tests need no disk, Docker or S3 credentials. Every memory disk gets its own empty store, so a fresh `createStorage` in each test starts from scratch and tests cannot leak data into each other.

`memfs` is an optional peer dependency and must be installed in your project: `npm i -D memfs`. Without it, creating a memory disk throws `type 'memory' requires the optional peer dependency "memfs": npm install memfs`.

```ts
import { createStorage, Storage } from '@webbar/node-multi-storage';

describe('reports', () => {
  let storage: Storage;

  beforeEach(() => {
    storage = createStorage({
      type: 'memory',
      files: {
        'templates/welcome.txt': 'Hello {{name}}',
        'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47]),
      },
    });
  });

  it('reads the seeded template and writes a report', async () => {
    expect(await storage.readFile('templates/welcome.txt', 'utf8')).toBe('Hello {{name}}');
    await storage.mkdir('reports');
    await storage.writeFile('reports/a.txt', 'done');
    expect(await storage.readdir('reports')).toEqual(['a.txt']);
  });
});
```

Memory mode runs the same code as the filesystem backend on top of memfs, so it behaves like `fileSystem`: same methods, options and Node-style errors (`ENOENT`, `EEXIST`, `ENOTEMPTY`, `ERR_FS_EISDIR`, ...), and `prefix` escapes are rejected. Without a `prefix` the store root is `/`, whatever the working directory is (so `'..'` is clamped at `/`). A few memfs gaps are patched so that results match Node's `fs`. Known deviations:

- Permission bits differ: `stat().mode` has `0o666` for files and `0o777` for folders instead of Node's umask-dependent `0o644` / `0o755`.
- Signed URLs are not available (they throw, like in filesystem mode) and `s3client` is `undefined`.
- Nothing is persisted: data lives as long as the storage instance.

With [multiple disks](#multiple-disks), configure each disk as `type: 'memory'`; every memory disk is its own empty, isolated store. To test Nest applications, see the [nestjs-multi-storage README](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/nestjs/README.md#testing-with-the-memory-backend).

## Changelog

See [CHANGELOG.md](CHANGELOG.md). The history before 0.7.0 is in the [nestjs-multi-storage changelog](https://github.com/jonathanarezki/node-multi-storage/blob/main/packages/nestjs/CHANGELOG.md), this package was extracted from it.

## License

[MIT](LICENSE)
