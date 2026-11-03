export * from './storage.module';
export * from './storage.service';
export * from './inject-storage.decorator';
export {
  StorageDisk,
  createFsError,
  createRmDirectoryError,
  createStats,
  isStorageError,
} from '@webbar/node-multi-storage';
export type {
  DriverMkdirOptions,
  DriverReaddirOptions,
  DriverReadFileOptions,
  DriverReadStreamOptions,
  DriverRmdirOptions,
  DriverRmOptions,
  DriverSignedPutUrlOptions,
  DriverSignedUrlOptions,
  DriverWriteFileOptions,
  StorageConfig,
  StorageCustomDiskOptions,
  StorageDriver,
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
