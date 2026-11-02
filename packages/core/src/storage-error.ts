/** Node's `fs` error codes (with errno and description) that the s3, ftp and sftp drivers emulate. */
export const FS_ERRORS = {
  ENOENT: [-2, 'no such file or directory'],
  EACCES: [-13, 'permission denied'],
  EEXIST: [-17, 'file already exists'],
  ENOTDIR: [-20, 'not a directory'],
  EISDIR: [-21, 'illegal operation on a directory'],
  EINVAL: [-22, 'invalid argument'],
  ENOTEMPTY: [-39, 'directory not empty'],
} as const;

/**
 * The error codes every backend reports: they come from Node (fileSystem) or memfs (memory), or are emulated by the
 * s3, ftp and sftp drivers (the fileSystem and memory backends may report others).
 */
export type StorageErrorCode = keyof typeof FS_ERRORS | 'ERR_FS_EISDIR';

/**
 * What every backend throws for a filesystem-level failure: Node-style errors with a string `code`.
 * `cleanupError` is set when a failed S3 folder `rename` could not remove the copies it had already made.
 */
export interface StorageError extends Error {
  code: string;
  errno?: number;
  syscall?: string;
  path?: string;
  dest?: string;
  cleanupError?: unknown;
}

/**
 * Structural type guard (not `instanceof`): true for any error-like value with a string `code`, which covers Node's
 * and memfs's own errors (they may come from another realm) as well as the ones emulated by the s3, ftp and sftp drivers. With
 * `code`, it must match too. AWS SDK errors have `name`, not `code`, so they are not storage errors.
 */
export function isStorageError(error: unknown, code?: StorageErrorCode | (string & {})): error is StorageError {
  const errorLike =
    error instanceof Error ||
    (typeof error === 'object' && error !== null && typeof (error as { message?: unknown }).message === 'string');
  if (!errorLike) {
    return false;
  }
  const actual = (error as { code?: unknown }).code;
  return typeof actual === 'string' && (code === undefined || actual === code);
}
