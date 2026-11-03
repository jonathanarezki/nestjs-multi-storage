export interface StorageReadFileOptions {
  encoding?: BufferEncoding | null;
  flag?: string;
}
export interface StorageWriteFileOptions {
  encoding?: BufferEncoding;
  mode?: number;
  flag?: string;
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
  flags?: string;
  mode?: number;
  partSize?: number;
  queueSize?: number;
  contentType?: string;
}
