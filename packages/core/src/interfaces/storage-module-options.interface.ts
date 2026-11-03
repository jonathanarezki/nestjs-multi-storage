import { StorageDriver } from './storage-driver.interface';

export interface StorageModuleOptions {
  /**
   * `memory` keeps everything in a private in-memory volume (needs the optional peer dependency `memfs`).
   * `ftp` needs the optional peer dependency `basic-ftp`, `sftp` needs `ssh2`.
   */
  type: 'fileSystem' | 's3' | 'memory' | 'ftp' | 'sftp';
  /**
   * All types, experimental (see `StorageDriver`). Called once, when the driver is first used, with the built-in
   * driver: returns the driver the disk uses instead (to add encryption, read-only access, logging, caching, ...).
   * The result must implement the required `StorageDriver` methods. `init` and `destroy` of the wrapper are called if it
   * has them (it must forward them to `inner` itself); if it has none, those of `inner` are called, so a wrapper
   * that leaves them out does not leak the connections.
   */
  wrap?: (inner: StorageDriver) => StorageDriver;
  endpoint?: string;
  endpointCDN?: string;
  region?: string;
  forcePathStyle?: boolean;
  /** Defaults to 'WHEN_REQUIRED' when `endpoint` is set (S3-compatible providers often reject the SDK default checksums); explicit values win */
  requestChecksumCalculation?: 'WHEN_SUPPORTED' | 'WHEN_REQUIRED';
  responseChecksumValidation?: 'WHEN_SUPPORTED' | 'WHEN_REQUIRED';
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  /** All types. For `ftp` and `sftp` it is the remote base directory (paths escaping it throw, as on the filesystem). */
  prefix?: string;
  /** ftp and sftp: server host name or address (required) */
  host?: string;
  /** ftp and sftp: server port. Default: 21 (ftp), 22 (sftp) */
  port?: number;
  /** ftp and sftp: login user. Default: `anonymous` (ftp) */
  username?: string;
  /** ftp and sftp: login password */
  password?: string;
  /** ftp and sftp: connection / network timeout in milliseconds */
  timeout?: number;
  /** ftp only: use FTPS. `true` is explicit TLS (AUTH TLS on the control connection), `'implicit'` is implicit TLS (usually port 990) */
  secure?: boolean | 'implicit';
  /** ftp only: maximum number of simultaneous connections (a FTP connection runs one transfer at a time). Default: 2 */
  maxConnections?: number;
  /** sftp only: private key (PEM / OpenSSH format) for key authentication */
  privateKey?: string | Buffer;
  /** sftp only: passphrase of an encrypted `privateKey` */
  passphrase?: string;
  /**
   * sftp only, required: the expected host key fingerprint of the server, in the `SHA256:<base64>` form printed by
   * `ssh-keygen -lf` (the SHA-256 hash of the host key, base64 without padding). The connection is refused when it
   * does not match. `false` disables the verification (not recommended: it allows man-in-the-middle attacks).
   */
  hostKey?: string | false;
  /**
   * Memory only: files to pre-populate the store with, keyed by path relative to the prefix
   * (e.g. `{ 'docs/a.txt': 'hello', 'img.png': Buffer.from(...) }`). Parent folders are created.
   */
  files?: Record<string, string | Buffer>;
}

/**
 * A disk backed by your own `StorageDriver`, which owns its configuration (no prefix, bucket, ...).
 *
 * @experimental The driver interface may change in a minor release of 0.8.x.
 */
export interface StorageCustomDiskOptions {
  type: 'custom';
  /**
   * The driver, or a synchronous factory for it: called lazily (on first use or by `init()`), at most once, and
   * never by `destroy()` of a disk that was not used. An instance is checked for the required methods by
   * `createStorage`; a factory's result when it is called.
   */
  driver: StorageDriver | (() => StorageDriver);
  /** Called once with the driver, when it is created: returns the driver the disk uses instead. See `StorageModuleOptions.wrap`. */
  wrap?: (inner: StorageDriver) => StorageDriver;
}

/** The options of one named disk (same shape as the single-store options). */
export type StorageDiskOptions = StorageModuleOptions | StorageCustomDiskOptions;

/** Several named disks; `default` is the one `Storage` itself operates on. */
export interface StorageMultiDiskOptions {
  default: string;
  disks: Record<string, StorageDiskOptions>;
}

/** What `createStorage` (and nestjs-multi-storage's `StorageModule`) accepts: a single store (the disk named `'default'`) or several named disks. */
export type StorageConfig = StorageDiskOptions | StorageMultiDiskOptions;
