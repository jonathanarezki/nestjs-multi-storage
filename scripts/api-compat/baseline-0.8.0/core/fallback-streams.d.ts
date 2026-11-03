import { Readable, Writable } from 'stream';
import { StorageCreateWriteStreamOptions } from './interfaces';
import { DriverReadStreamOptions, StorageDriver } from './interfaces/storage-driver.interface';
export declare function readStreamFallback(
  driver: StorageDriver,
  filePath: string,
  { start, end, highWaterMark }: DriverReadStreamOptions,
): Readable;
export declare function writeStreamFallback(
  driver: StorageDriver,
  filePath: string,
  options: StorageCreateWriteStreamOptions,
): Writable;
