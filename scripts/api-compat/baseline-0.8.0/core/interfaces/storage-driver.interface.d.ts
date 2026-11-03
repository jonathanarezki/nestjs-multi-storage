import { Readable, Writable } from 'stream';
import { StorageCreateWriteStreamOptions, StorageStats } from '.';
export interface DriverMkdirOptions {
  recursive: boolean;
  mode?: number;
}
export interface DriverReaddirOptions {
  recursive: boolean;
}
export interface DriverRmdirOptions {
  recursive: boolean;
}
export interface DriverRmOptions {
  force: boolean;
  recursive: boolean;
}
export interface DriverReadFileOptions {
  flag?: string;
}
export interface DriverWriteFileOptions {
  mode?: number;
  flag?: string;
  contentType?: string;
}
export interface DriverReadStreamOptions {
  start?: number;
  end?: number;
  highWaterMark?: number;
}
export interface DriverSignedUrlOptions {
  expiresIn?: number;
  responseContentDisposition?: string;
  responseContentType?: string;
}
export interface DriverSignedPutUrlOptions {
  expiresIn?: number;
  contentType?: string;
}
export interface StorageDriver {
  init?(): Promise<void>;
  destroy?(): Promise<void>;
  mkdir(path: string, options: DriverMkdirOptions): Promise<string | undefined>;
  readdir(path: string, options: DriverReaddirOptions): Promise<string[]>;
  rmdir(path: string, options: DriverRmdirOptions): Promise<void>;
  stat(path: string): Promise<StorageStats>;
  exists(path: string): Promise<boolean>;
  readFile(path: string, options: DriverReadFileOptions): Promise<Buffer>;
  writeFile(path: string, data: Buffer, options: DriverWriteFileOptions): Promise<void>;
  getSignedUrl?(path: string, options: DriverSignedUrlOptions): Promise<string>;
  getSignedPutUrl?(path: string, options: DriverSignedPutUrlOptions): Promise<string>;
  rm(path: string, options: DriverRmOptions): Promise<void>;
  copyFile(src: string, dest: string, mode: number): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  createReadStream?(path: string, options: DriverReadStreamOptions): Readable;
  createWriteStream?(path: string, options: StorageCreateWriteStreamOptions): Writable;
}
