export * from './storage.module';
export * from './storage.service';
export * from './inject-storage.decorator';
export { StorageDisk, isStorageError } from '@webbar/node-multi-storage';
export type {
  StorageBucketOptions,
  StorageConfig,
  StorageCreateReadStreamOptions,
  StorageCreateWriteStreamOptions,
  StorageDiskOptions,
  StorageError,
  StorageErrorCode,
  StorageMkdirOptions,
  StorageModuleOptions,
  StorageMultiDiskOptions,
  StorageReaddirOptions,
  StorageReadFileOptions,
  StorageRmdirOptions,
  StorageRmOptions,
  StorageStats,
  StorageWriteFileOptions,
} from '@webbar/node-multi-storage';
