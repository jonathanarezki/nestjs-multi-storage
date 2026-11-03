import * as fs from 'fs';
import { StorageStats } from '../interfaces';

/** The `mode` reported by backends that have no permissions of their own (S3, FTP): 0755 for a folder, 0644 for a file. */
export function defaultMode(isDirectory: boolean): number {
  return isDirectory ? fs.constants.S_IFDIR | 0o755 : fs.constants.S_IFREG | 0o644;
}

/**
 * Builds the `StorageStats` of a remote entry. The type predicates come from the type bits of `mode`; `atime` defaults
 * to `mtime`, `uid` and `gid` to 0. `ctime` and `birthtime` are not known remotely and are `mtime`.
 * @experimental May change in a minor release of 0.8.x.
 */
export function createStats(entry: {
  mode: number;
  size: number;
  mtime: Date;
  atime?: Date;
  uid?: number;
  gid?: number;
}): StorageStats {
  const { mode, size, mtime, atime = mtime, uid = 0, gid = 0 } = entry;
  const type = mode & fs.constants.S_IFMT;
  return {
    isFile: () => type === fs.constants.S_IFREG,
    isDirectory: () => type === fs.constants.S_IFDIR,
    isSymbolicLink: () => type === fs.constants.S_IFLNK,
    isBlockDevice: () => type === fs.constants.S_IFBLK,
    isCharacterDevice: () => type === fs.constants.S_IFCHR,
    isFIFO: () => type === fs.constants.S_IFIFO,
    isSocket: () => type === fs.constants.S_IFSOCK,
    dev: 0,
    ino: 0,
    mode,
    nlink: 1,
    uid,
    gid,
    rdev: 0,
    size,
    blksize: 4096,
    blocks: Math.ceil(size / 512),
    atimeMs: atime.getTime(),
    mtimeMs: mtime.getTime(),
    ctimeMs: mtime.getTime(),
    birthtimeMs: mtime.getTime(),
    atime,
    mtime,
    ctime: mtime,
    birthtime: mtime,
  };
}
