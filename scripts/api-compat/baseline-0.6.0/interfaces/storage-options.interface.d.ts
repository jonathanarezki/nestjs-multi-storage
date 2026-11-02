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
    flags?: string;
    mode?: number;
    partSize?: number;
    queueSize?: number;
    contentType?: string;
}
