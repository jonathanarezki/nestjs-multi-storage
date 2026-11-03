import { StorageDriver } from './storage-driver.interface';
export interface StorageModuleOptions {
  type: 'fileSystem' | 's3' | 'memory' | 'ftp' | 'sftp';
  wrap?: (inner: StorageDriver) => StorageDriver;
  endpoint?: string;
  endpointCDN?: string;
  region?: string;
  forcePathStyle?: boolean;
  requestChecksumCalculation?: 'WHEN_SUPPORTED' | 'WHEN_REQUIRED';
  responseChecksumValidation?: 'WHEN_SUPPORTED' | 'WHEN_REQUIRED';
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  prefix?: string;
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  timeout?: number;
  secure?: boolean | 'implicit';
  maxConnections?: number;
  privateKey?: string | Buffer;
  passphrase?: string;
  hostKey?: string | false;
  files?: Record<string, string | Buffer>;
}
export interface StorageCustomDiskOptions {
  type: 'custom';
  driver: StorageDriver | (() => StorageDriver);
  wrap?: (inner: StorageDriver) => StorageDriver;
}
export type StorageDiskOptions = StorageModuleOptions | StorageCustomDiskOptions;
export interface StorageMultiDiskOptions {
  default: string;
  disks: Record<string, StorageDiskOptions>;
}
export type StorageConfig = StorageDiskOptions | StorageMultiDiskOptions;
