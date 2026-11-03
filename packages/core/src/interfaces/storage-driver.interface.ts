import { Readable, Writable } from 'stream';
import { StorageCreateWriteStreamOptions, StorageStats } from '.';

/**
 * @experimental The driver interface may change in a minor release of 0.8.x.
 *
 * The options a driver receives: already normalized by `StorageDisk` (defaults applied, strings expanded). */
export interface DriverMkdirOptions {
  recursive: boolean;
  mode?: number;
}

/** @experimental */
export interface DriverReaddirOptions {
  recursive: boolean;
}

/** @experimental */
export interface DriverRmdirOptions {
  recursive: boolean;
}

/** @experimental */
export interface DriverRmOptions {
  force: boolean;
  recursive: boolean;
}

/** @experimental */
export interface DriverReadFileOptions {
  flag?: string;
}

/** @experimental */
export interface DriverWriteFileOptions {
  mode?: number;
  flag?: string;
  /** S3 only */
  contentType?: string;
}

/** @experimental */
export interface DriverReadStreamOptions {
  /** First byte to read (inclusive) */
  start?: number;
  /** Last byte to read (inclusive). `start <= end` is checked by `StorageDisk`. */
  end?: number;
  highWaterMark?: number;
}

/** @experimental */
export interface DriverSignedUrlOptions {
  expiresIn?: number;
  responseContentDisposition?: string;
  responseContentType?: string;
}

/** @experimental */
export interface DriverSignedPutUrlOptions {
  expiresIn?: number;
  contentType?: string;
}

/**
 * One storage backend (real disk, memory, S3, FTP or SFTP, or your own: see `StorageCustomDiskOptions`) behind the
 * fs-compatible file operations.
 *
 * @experimental The driver interface may change in a minor release of 0.8.x.
 *
 * `StorageDisk` normalizes everything that does not depend on the backend before calling a driver: string
 * shorthands and defaults of the options, encodings (the driver only deals with bytes and UTF-8 names) and argument
 * validation. A driver only resolves its paths (applying its `prefix`, rejecting paths that escape it) and talks to
 * the backend. Failures are Node-style errors with a string `code`, like the ones of `fs.promises`
 * (`ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY`, `EINVAL`, ...), as in the contracts below.
 */
export interface StorageDriver {
  /**
   * Optional eager warm-up (connect, create the client). Drivers must also work without it, initializing on first use.
   * A `wrap` function that returns a driver without `init` (or `destroy`) leaves it to the inner driver's.
   */
  init?(): Promise<void>;

  /** Optional: closes connections and clients. The driver may be used again afterwards (it reconnects on demand). */
  destroy?(): Promise<void>;

  /**
   * Creates the folder. Returns the first folder that had to be created, or `undefined` when it already existed
   * (recursive) or the backend has no such notion. Without `recursive`: `EEXIST` when `path` exists (a file too),
   * `ENOENT` when the parent is missing, `ENOTDIR` when the parent is a file. With `recursive`, an existing
   * folder is not an error, but a file at `path` or on the way is (`EEXIST` / `ENOTDIR`).
   */
  mkdir(path: string, options: DriverMkdirOptions): Promise<string | undefined>;

  /**
   * The names (UTF-8, relative to `path`) of the entries of a folder. With `recursive`, all descendants as
   * relative paths with `/` separators, folders included, in any order (`StorageDisk` sorts them). `ENOENT` when `path` is missing, `ENOTDIR` for a file.
   */
  readdir(path: string, options: DriverReaddirOptions): Promise<string[]>;

  /**
   * Removes a folder. Without `recursive` the folder must be empty (`ENOTEMPTY`) and `path` must be a folder
   * (`ENOTDIR`). With `recursive` it removes the whole tree, and also a plain file (like `fs.rm(path, { recursive: true })`).
   * `ENOENT` when `path` is missing.
   */
  rmdir(path: string, options: DriverRmdirOptions): Promise<void>;

  /** The stats of a file or folder. `ENOENT` when `path` is missing. */
  stat(path: string): Promise<StorageStats>;

  /** Whether `path` exists. Only "not found" is `false`: any other failure (permissions, network, ...) is thrown. */
  exists(path: string): Promise<boolean>;

  /** The whole content of a file. `ENOENT` when missing, `EISDIR` for a folder. */
  readFile(path: string, options: DriverReadFileOptions): Promise<Buffer>;

  /**
   * Writes the whole content, replacing an existing file (the `flag` of `fs.writeFile` applies where the backend can:
   * `'a'` appends, `'wx'` fails with `EEXIST`). `ENOENT` / `ENOTDIR` for a missing parent / a file as parent
   * (backends with real folders), `EISDIR` when `path` is a folder.
   */
  writeFile(path: string, data: Buffer, options: DriverWriteFileOptions): Promise<void>;

  /** Optional: a pre-signed GET URL. Without it, `StorageDisk.getSignedUrl` throws `ERR_STORAGE_NOT_SUPPORTED`. */
  getSignedUrl?(path: string, options: DriverSignedUrlOptions): Promise<string>;

  /** Optional: a pre-signed PUT URL. Without it, `StorageDisk.getSignedPutUrl` throws `ERR_STORAGE_NOT_SUPPORTED`. */
  getSignedPutUrl?(path: string, options: DriverSignedPutUrlOptions): Promise<string>;

  /**
   * Removes a file. A folder needs `recursive` (else `ERR_FS_EISDIR`). A missing path is `ENOENT`, unless `force`
   * is set.
   */
  rm(path: string, options: DriverRmOptions): Promise<void>;

  /**
   * Copies a file (not a folder: `EISDIR`) to `dest`, replacing it. `ENOENT` when `src` is missing. `mode` is the
   * bit field of `fs.copyFile`: with `fs.constants.COPYFILE_EXCL` an existing `dest` is `EEXIST`.
   */
  copyFile(src: string, dest: string, mode: number): Promise<void>;

  /**
   * Moves a file or folder, replacing an existing file (or an empty folder) like `fs.rename`. `ENOENT` when
   * `oldPath` is missing, `EINVAL` for a folder into itself, `ENOTDIR` / `EISDIR` / `ENOTEMPTY` for a type mismatch
   * or a non-empty target folder.
   */
  rename(oldPath: string, newPath: string): Promise<void>;

  /**
   * Optional (without it, `StorageDisk` streams the result of `readFile`, which holds the whole file in memory).
   * A stream of the bytes of a file (`start` and `end` select a range, both inclusive). It may be returned before the
   * file is opened: failures (`ENOENT`, `EISDIR`, ...) are emitted as its `'error'` event, not thrown. Only problems
   * with the arguments themselves (e.g. a path outside the prefix) throw synchronously.
   */
  createReadStream?(path: string, options: DriverReadStreamOptions): Readable;

  /**
   * Optional (without it, `StorageDisk` buffers the chunks in memory and calls `writeFile` when the stream ends).
   * A stream that writes a file. `'finish'` is only emitted once the file is complete. Failures are emitted as
   * `'error'`; a stream destroyed before the end must not leave a partial file where the backend can avoid it.
   */
  createWriteStream?(path: string, options: StorageCreateWriteStreamOptions): Writable;
}
