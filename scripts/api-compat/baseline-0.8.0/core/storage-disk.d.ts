import type { S3Client } from '@aws-sdk/client-s3';
import { Readable, Writable } from 'stream';
import {
  StorageCreateReadStreamOptions,
  StorageCreateWriteStreamOptions,
  StorageMkdirOptions,
  StorageReaddirOptions,
  StorageReadFileOptions,
  StorageRmdirOptions,
  StorageRmOptions,
  StorageStats,
  StorageWriteFileOptions,
} from './interfaces';
import { DriverSource } from './driver-source';
export declare class StorageDisk {
  private readonly source;
  constructor(source: DriverSource);
  get s3client(): S3Client | undefined;
  mkdir(folderPath: string, options?: StorageMkdirOptions): Promise<string | undefined>;
  readdir(folderPath: string, options?: BufferEncoding | StorageReaddirOptions): Promise<string[]>;
  rmdir(folderPath: string, options?: StorageRmdirOptions): Promise<void>;
  stat(p: string): Promise<StorageStats>;
  exists(p: string): Promise<boolean>;
  readFile(
    filePath: string,
    options:
      | BufferEncoding
      | (StorageReadFileOptions & {
          encoding: BufferEncoding;
        }),
  ): Promise<string>;
  readFile(
    filePath: string,
    options?:
      | (StorageReadFileOptions & {
          encoding?: null;
        })
      | null,
  ): Promise<Buffer>;
  readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer>;
  writeFile(
    filePath: string,
    data: string | Buffer | Uint8Array,
    options?: BufferEncoding | StorageWriteFileOptions,
  ): Promise<void>;
  getSignedUrl(
    filePath: string,
    opts?: {
      expiresIn?: number;
      responseContentDisposition?: string;
      responseContentType?: string;
    },
  ): Promise<string>;
  getSignedPutUrl(
    filePath: string,
    opts?: {
      expiresIn?: number;
      contentType?: string;
    },
  ): Promise<string>;
  rm(filePath: string, options?: StorageRmOptions): Promise<void>;
  copyFile(src: string, dest: string, mode?: number): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  createReadStream(filePath: string, options?: StorageCreateReadStreamOptions): Readable;
  createWriteStream(filePath: string, options?: StorageCreateWriteStreamOptions): Writable;
}
