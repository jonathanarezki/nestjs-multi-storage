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
} from '.';

/**
 * One storage backend (real disk, memory, S3, FTP or SFTP) behind the fs-compatible file operations.
 * `init` is an optional warm-up (every driver also initializes lazily on first use), `destroy` runs on shutdown.
 */
export interface StorageDriver {
  init(): Promise<void>;
  destroy(): Promise<void>;

  mkdir(folderPath: string, options?: StorageMkdirOptions): Promise<string | undefined>;
  readdir(folderPath: string, options?: BufferEncoding | StorageReaddirOptions): Promise<string[]>;
  rmdir(folderPath: string, options?: StorageRmdirOptions): Promise<void>;
  stat(p: string, options?: { bucket?: string }): Promise<StorageStats>;
  exists(p: string, bucket?: string): Promise<boolean>;
  readFile(
    filePath: string,
    options: BufferEncoding | (StorageReadFileOptions & { encoding: BufferEncoding }),
  ): Promise<string>;
  readFile(filePath: string, options?: (StorageReadFileOptions & { encoding?: null }) | null): Promise<Buffer>;
  readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer>;
  writeFile(
    filePath: string,
    data: string | Buffer | Uint8Array,
    options?: BufferEncoding | StorageWriteFileOptions,
  ): Promise<void>;
  getSignedUrl(
    filePath: string,
    opts?: { bucket?: string; expiresIn?: number; responseContentDisposition?: string; responseContentType?: string },
  ): Promise<string>;
  getSignedPutUrl(
    filePath: string,
    opts?: { bucket?: string; expiresIn?: number; contentType?: string },
  ): Promise<string>;
  rm(filePath: string, options?: StorageRmOptions): Promise<void>;
  copyFile(src: string, dest: string, mode?: number, bucket?: string): Promise<void>;
  rename(oldPath: string, newPath: string, bucket?: string): Promise<void>;
  createReadStream(filePath: string, options?: StorageCreateReadStreamOptions): Readable;
  createWriteStream(filePath: string, options?: StorageCreateWriteStreamOptions): Writable;
}
