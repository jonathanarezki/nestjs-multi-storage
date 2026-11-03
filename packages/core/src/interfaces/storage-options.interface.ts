export interface StorageReadFileOptions {
  encoding?: BufferEncoding | null;
  flag?: string;
}

export interface StorageWriteFileOptions {
  encoding?: BufferEncoding;
  mode?: number;
  flag?: string;
  /** S3 only. Defaults to a lookup from the file name. */
  contentType?: string;
}

export interface StorageReaddirOptions {
  recursive?: boolean;
  encoding?: BufferEncoding;
}

export interface StorageMkdirOptions {
  recursive?: boolean;
  mode?: number;
}

export interface StorageRmdirOptions {
  recursive?: boolean;
}

export interface StorageRmOptions {
  force?: boolean;
  recursive?: boolean;
}

export interface StorageCreateReadStreamOptions {
  start?: number;
  end?: number;
  highWaterMark?: number;
  encoding?: BufferEncoding;
}

export interface StorageCreateWriteStreamOptions {
  highWaterMark?: number;
  encoding?: BufferEncoding;
  /** Filesystem only */
  flags?: string;
  /** Filesystem only */
  mode?: number;
  /** S3 only: multipart part size, at least 5 MiB (the default) */
  partSize?: number;
  /** S3 only: parts uploaded in parallel (default 4) */
  queueSize?: number;
  /** S3 only. Defaults to a lookup from the file name. */
  contentType?: string;
}
