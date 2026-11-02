export interface StorageModuleOptions {
  /**
   * `memory` keeps everything in a private in-memory volume (needs the optional peer dependency `memfs`).
   * `ftp` needs the optional peer dependency `basic-ftp`, `sftp` needs `ssh2`.
   */
  type: 'fileSystem' | 's3' | 'memory' | 'ftp' | 'sftp';
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

/** The options of one named disk (same shape as the single-store options). */
export type StorageDiskOptions = StorageModuleOptions;

/** Several named disks; `default` is the one `Storage` itself operates on. */
export interface StorageMultiDiskOptions {
  default: string;
  disks: Record<string, StorageDiskOptions>;
}

/** What `createStorage` (and nestjs-multi-storage's `StorageModule`) accepts: a single store (the disk named `'default'`) or several named disks. */
export type StorageConfig = StorageModuleOptions | StorageMultiDiskOptions;
