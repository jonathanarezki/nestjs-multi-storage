import { FS_ERRORS, StorageError, StorageErrorCode } from '../storage-error';

/** Builds the Node-style error `fs` throws for `code` (also used by the S3 and memory backends to emulate it). */
export function fsError(code: Exclude<StorageErrorCode, 'ERR_FS_EISDIR'>, syscall: string, p?: string, dest?: string) {
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

/** What Node throws for `fs.rm` on a directory without `recursive`. */
export function rmDirectoryError(p: string): StorageError {
  return Object.assign(new Error(`Path is a directory: rm returned EISDIR (is a directory) ${p}`), {
    code: 'ERR_FS_EISDIR',
    errno: 21,
    syscall: 'rm',
    path: p,
  });
}
