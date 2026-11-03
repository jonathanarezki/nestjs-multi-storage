import { FS_ERRORS, StorageError } from '../storage-error';

/**
 * Builds the Node-style error `fs` throws for `code` (also used by the S3 and memory backends to emulate it).
 * @experimental May change in a minor release of 0.8.x.
 */
export function createFsError(code: keyof typeof FS_ERRORS, syscall: string, p?: string, dest?: string) {
  const [errno, description] = FS_ERRORS[code];
  const error: StorageError = Object.assign(
    new Error(
      `${code}: ${description}, ${syscall}${p === undefined ? '' : ` '${p}'`}${
        dest === undefined ? '' : ` -> '${dest}'`
      }`,
    ),
    { code: code as string, errno, syscall },
  );
  if (p !== undefined) {
    error.path = p;
  }
  if (dest !== undefined) {
    error.dest = dest;
  }
  return error;
}

/**
 * What Node throws for `fs.rm` on a directory without `recursive` (`ERR_FS_EISDIR`).
 * @experimental May change in a minor release of 0.8.x.
 */
export function createRmDirectoryError(p: string): StorageError {
  return Object.assign(new Error(`Path is a directory: rm returned EISDIR (is a directory) ${p}`), {
    code: 'ERR_FS_EISDIR',
    errno: 21,
    syscall: 'rm',
    path: p,
  });
}

/** What `StorageDisk` throws for an operation that the driver of the disk does not implement (an optional method). */
export function notSupportedError(operation: string): StorageError {
  return Object.assign(new Error(`${operation} is not supported by this disk`), {
    code: 'ERR_STORAGE_NOT_SUPPORTED',
    syscall: operation,
  });
}
