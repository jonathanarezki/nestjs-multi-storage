import * as fs from 'fs';
import { createFsError, createRmDirectoryError, createStats, StorageDriver } from '@webbar/node-multi-storage';

const dirname = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * A complete custom driver on a Map (files) and a Set (folders), with real-filesystem semantics and nothing optional:
 * no streams, no signed URLs, no init, no destroy. Paths are used as keys ('' is the root). It is what a minimal
 * driver author would write, and the conformance suite runs against it.
 */
export function createMapDriver(): StorageDriver {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();
  const isDir = (p: string) => p === '' || dirs.has(p);
  const exists = (p: string) => isDir(p) || files.has(p);
  const below = (p: string) => (key: string) => p === '' || key.startsWith(`${p}/`);
  const entries = (p: string) => [...files.keys(), ...dirs].filter(below(p));

  /** The parent of `p` must be a folder: ENOENT when it is missing, ENOTDIR when it is a file */
  function checkParent(p: string, syscall: string, path: string, dest?: string) {
    const parent = dirname(p);
    if (files.has(parent)) throw createFsError('ENOTDIR', syscall, path, dest);
    if (!isDir(parent)) throw createFsError('ENOENT', syscall, path, dest);
  }

  function removeTree(p: string) {
    for (const key of entries(p)) {
      files.delete(key);
      dirs.delete(key);
    }
    files.delete(p);
    dirs.delete(p);
  }

  return {
    async mkdir(p, { recursive }) {
      if (p === '') return undefined;
      if (files.has(p)) throw createFsError('EEXIST', 'mkdir', p);
      if (dirs.has(p)) {
        if (recursive) return undefined;
        throw createFsError('EEXIST', 'mkdir', p);
      }
      if (!recursive) {
        checkParent(p, 'mkdir', p);
        dirs.add(p);
        return p;
      }
      const parts = p.split('/');
      let first: string | undefined;
      for (let i = 1; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (files.has(dir)) throw createFsError('ENOTDIR', 'mkdir', p);
        if (!dirs.has(dir)) {
          dirs.add(dir);
          first ??= dir;
        }
      }
      return first;
    },
    async readdir(p, { recursive }) {
      if (files.has(p)) throw createFsError('ENOTDIR', 'scandir', p);
      if (!isDir(p)) throw createFsError('ENOENT', 'scandir', p);
      const names = entries(p).map((key) => (p === '' ? key : key.slice(p.length + 1)));
      return names.filter((name) => recursive || !name.includes('/')).sort();
    },
    async rmdir(p, { recursive }) {
      if (!exists(p)) throw createFsError('ENOENT', recursive ? 'lstat' : 'rmdir', p);
      if (!recursive) {
        if (files.has(p)) throw createFsError('ENOTDIR', 'rmdir', p);
        if (entries(p).length > 0) throw createFsError('ENOTEMPTY', 'rmdir', p);
      }
      removeTree(p);
    },
    async stat(p) {
      const file = files.get(p);
      if (!file && !isDir(p)) throw createFsError('ENOENT', 'stat', p);
      return createStats({
        mode: file ? fs.constants.S_IFREG | 0o644 : fs.constants.S_IFDIR | 0o755,
        size: file?.length ?? 0,
        mtime: new Date(),
      });
    },
    async exists(p) {
      return exists(p);
    },
    async readFile(p) {
      if (isDir(p)) throw createFsError('EISDIR', 'read', p);
      const file = files.get(p);
      if (!file) throw createFsError('ENOENT', 'open', p);
      return Buffer.from(file);
    },
    async writeFile(p, data) {
      if (isDir(p)) throw createFsError('EISDIR', 'open', p);
      checkParent(p, 'open', p);
      files.set(p, Buffer.from(data));
    },
    async rm(p, { force, recursive }) {
      if (!exists(p)) {
        if (force) return;
        throw createFsError('ENOENT', 'lstat', p);
      }
      if (isDir(p) && !recursive) throw createRmDirectoryError(p);
      removeTree(p);
    },
    async copyFile(src, dest, mode) {
      const data = files.get(src);
      if (!data && !isDir(src)) throw createFsError('ENOENT', 'copyfile', src, dest);
      if (!data || isDir(dest)) throw createFsError('EISDIR', 'copyfile', src, dest);
      if (mode & fs.constants.COPYFILE_EXCL && files.has(dest)) throw createFsError('EEXIST', 'copyfile', src, dest);
      checkParent(dest, 'copyfile', src, dest);
      files.set(dest, Buffer.from(data));
    },
    async rename(from, to) {
      if (!exists(from)) throw createFsError('ENOENT', 'rename', from, to);
      if (from === to) return;
      if (files.has(from)) {
        if (isDir(to)) throw createFsError('EISDIR', 'rename', from, to);
        checkParent(to, 'rename', from, to);
        files.set(to, files.get(from)!);
        files.delete(from);
        return;
      }
      if (to.startsWith(`${from}/`)) throw createFsError('EINVAL', 'rename', from, to);
      if (files.has(to)) throw createFsError('ENOTDIR', 'rename', from, to);
      if (isDir(to) && entries(to).length > 0) throw createFsError('ENOTEMPTY', 'rename', from, to);
      checkParent(to, 'rename', from, to);
      const moved = entries(from).map((key) => ({ key, data: files.get(key) }));
      removeTree(from);
      dirs.add(to);
      for (const { key, data } of moved) {
        const target = `${to}${key.slice(from.length)}`;
        if (data) files.set(target, data);
        else dirs.add(target);
      }
    },
  };
}
