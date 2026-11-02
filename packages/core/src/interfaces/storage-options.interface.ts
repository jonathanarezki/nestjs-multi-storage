/** `bucket` overrides the configured bucket for one call. It is ignored in filesystem mode. */
export interface StorageBucketOptions {
  bucket?: string;
}

export interface StorageReadFileOptions extends StorageBucketOptions {
  encoding?: BufferEncoding | null;
  flag?: string;
}

export interface StorageWriteFileOptions extends StorageBucketOptions {
  encoding?: BufferEncoding;
  mode?: number;
  flag?: string;
  /** S3 only. Defaults to a lookup from the file name. */
  contentType?: string;
}

export interface StorageReaddirOptions extends StorageBucketOptions {
  recursive?: boolean;
  encoding?: BufferEncoding;
}

export interface StorageMkdirOptions extends StorageBucketOptions {
  recursive?: boolean;
  mode?: number;
}

export interface StorageRmdirOptions extends StorageBucketOptions {
  recursive?: boolean;
}

export interface StorageRmOptions extends StorageBucketOptions {
  force?: boolean;
  recursive?: boolean;
}

export interface StorageCreateReadStreamOptions extends StorageBucketOptions {
  start?: number;
  end?: number;
  highWaterMark?: number;
  encoding?: BufferEncoding;
}

export interface StorageCreateWriteStreamOptions extends StorageBucketOptions {
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
