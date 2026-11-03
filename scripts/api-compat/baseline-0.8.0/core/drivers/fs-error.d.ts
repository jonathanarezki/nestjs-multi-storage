import { FS_ERRORS, StorageError } from '../storage-error';
export declare function createFsError(
  code: keyof typeof FS_ERRORS,
  syscall: string,
  p?: string,
  dest?: string,
): StorageError;
export declare function createRmDirectoryError(p: string): StorageError;
export declare function notSupportedError(operation: string): StorageError;
