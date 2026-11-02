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
import { S3Driver } from './drivers/s3.driver';
import { StorageDriver } from './interfaces/storage-driver.interface';

/**
 * One named storage (filesystem, memory, S3, FTP or SFTP) with the fs-compatible file API.
 * Created by the library: get it with `storage.disk(name)` (nestjs-multi-storage also injects it with `@InjectStorage(name)`).
 */
export class StorageDisk {
  /** @internal */
  constructor(private readonly driver: StorageDriver) {}

  get s3client(): S3Client | undefined {
    return this.driver instanceof S3Driver ? this.driver.client : undefined;
  }

  /** Unlike `fs.promises.mkdir`, `recursive` defaults to `true`. */
  async mkdir(folderPath: string, options?: StorageMkdirOptions): Promise<string | undefined> {
    return this.driver.mkdir(folderPath, options);
  }

  async readdir(folderPath: string, options?: BufferEncoding | StorageReaddirOptions): Promise<string[]> {
    return this.driver.readdir(folderPath, options);
  }

  /** Unlike `fs.promises.rmdir`, `recursive` defaults to `true` (like `fs.promises.rm(path, { recursive: true })`). */
  async rmdir(folderPath: string, options?: StorageRmdirOptions): Promise<void> {
    return this.driver.rmdir(folderPath, options);
  }

  async stat(p: string, options?: { bucket?: string }): Promise<StorageStats> {
    return this.driver.stat(p, options);
  }

  /**
   * Unlike `fs.existsSync`, errors other than "not found" (403, network, ...) are thrown, not turned into `false`.
   */
  async exists(p: string, bucket?: string): Promise<boolean> {
    return this.driver.exists(p, bucket);
  }

  async readFile(
    filePath: string,
    options: BufferEncoding | (StorageReadFileOptions & { encoding: BufferEncoding }),
  ): Promise<string>;
  async readFile(filePath: string, options?: (StorageReadFileOptions & { encoding?: null }) | null): Promise<Buffer>;
  async readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer>;
  async readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer> {
    return this.driver.readFile(filePath, options);
  }

  async writeFile(
    filePath: string,
    data: string | Buffer | Uint8Array,
    options?: BufferEncoding | StorageWriteFileOptions,
  ): Promise<void> {
    return this.driver.writeFile(filePath, data, options);
  }

  public async getSignedUrl(
    filePath: string,
    opts?: { bucket?: string; expiresIn?: number; responseContentDisposition?: string; responseContentType?: string },
  ): Promise<string> {
    return this.driver.getSignedUrl(filePath, opts);
  }

  public async getSignedPutUrl(
    filePath: string,
    opts?: { bucket?: string; expiresIn?: number; contentType?: string },
  ): Promise<string> {
    return this.driver.getSignedPutUrl(filePath, opts);
  }

  async rm(filePath: string, options?: StorageRmOptions): Promise<void> {
    return this.driver.rm(filePath, options);
  }

  async copyFile(src: string, dest: string, mode?: number, bucket?: string): Promise<void> {
    return this.driver.copyFile(src, dest, mode, bucket);
  }

  async rename(oldPath: string, newPath: string, bucket?: string): Promise<void> {
    return this.driver.rename(oldPath, newPath, bucket);
  }

  createReadStream(filePath: string, options?: StorageCreateReadStreamOptions): Readable {
    return this.driver.createReadStream(filePath, options);
  }

  createWriteStream(filePath: string, options?: StorageCreateWriteStreamOptions): Writable {
    return this.driver.createWriteStream(filePath, options);
  }
}
