export declare const FS_ERRORS: {
  readonly ENOENT: readonly [-2, 'no such file or directory'];
  readonly EACCES: readonly [-13, 'permission denied'];
  readonly EEXIST: readonly [-17, 'file already exists'];
  readonly ENOTDIR: readonly [-20, 'not a directory'];
  readonly EISDIR: readonly [-21, 'illegal operation on a directory'];
  readonly EINVAL: readonly [-22, 'invalid argument'];
  readonly ENOTEMPTY: readonly [-39, 'directory not empty'];
};
export type StorageErrorCode = keyof typeof FS_ERRORS | 'ERR_FS_EISDIR' | 'ERR_STORAGE_NOT_SUPPORTED';
export interface StorageError extends Error {
  code: string;
  errno?: number;
  syscall?: string;
  path?: string;
  dest?: string;
  cleanupError?: unknown;
}
export declare function isStorageError(error: unknown, code?: StorageErrorCode | (string & {})): error is StorageError;
