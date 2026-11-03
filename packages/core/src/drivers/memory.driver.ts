import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import { StorageModuleOptions } from '../interfaces';
import {
  DriverMkdirOptions,
  DriverReaddirOptions,
  DriverReadFileOptions,
  DriverReadStreamOptions,
} from '../interfaces/storage-driver.interface';
import { createFsError } from './fs-error';
import { FileSystemDriver } from './file-system.driver';
import { defined } from './options';

/**
 * The `memory` backend: the filesystem driver on a private in-memory (memfs) volume.
 * memfs does not behave exactly like Node's fs in a few places. The shims below make the memory backend match what
 * Node's fs does (verified against the real fs in the parity tests).
 */
export class MemoryDriver extends FileSystemDriver {
  constructor(options: StorageModuleOptions) {
    super(options);
    // memfs is an optional peer dependency: only loaded when the memory backend is used
    let memfs: typeof import('memfs');
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      memfs = require('memfs');
    } catch (error: any) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
      throw Object.assign(new Error(`type 'memory' requires the optional peer dependency "memfs": npm install memfs`), {
        cause: error,
      });
    }
    // One private volume per instance. The root is '/' (not the cwd) unless a prefix is given
    this.fs = memfs.createFsFromVolume(new memfs.Volume()) as unknown as typeof fs;
    this.prefix = path.resolve('/', options.prefix ?? '');
    this.fs.mkdirSync(this.prefix, { recursive: true });
    for (const [file, content] of Object.entries(options.files ?? {})) {
      const target = this.fsPath(file);
      this.fs.mkdirSync(path.dirname(target), { recursive: true });
      this.fs.writeFileSync(target, content);
    }
  }

  async mkdir(folderPath: string, options: DriverMkdirOptions): Promise<string | undefined> {
    return this.memMkdir(this.fsPath(folderPath), options.recursive, options.mode);
  }

  async readdir(folderPath: string, options: DriverReaddirOptions): Promise<string[]> {
    if (options.recursive) {
      return this.memReaddirRecursive(this.fsPath(folderPath));
    }
    return super.readdir(folderPath, options);
  }

  async readFile(filePath: string, options: DriverReadFileOptions): Promise<Buffer> {
    return super.readFile(filePath, options).catch((e) => {
      // memfs leaves the path out of the EISDIR error (memory shim)
      if (e?.code === 'EISDIR' && !e.path) throw createFsError('EISDIR', 'read', this.fsPath(filePath));
      throw e;
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const [src, dest] = [this.fsPath(oldPath), this.fsPath(newPath)];
    this.memRenameChecks(src, dest);
    return super.rename(oldPath, newPath);
  }

  createReadStream(filePath: string, options: DriverReadStreamOptions): Readable {
    return this.memReadStream(this.fsPath(filePath), options);
  }

  private memStat(p: string) {
    try {
      return this.fs.statSync(p);
    } catch {
      return undefined;
    }
  }

  /** memfs reports the failing parent instead of the requested path for some mkdir errors, Node reports the path. */
  private withErrorPath<E>(error: E, p: string): E {
    const e = error as unknown as NodeJS.ErrnoException;
    if (e?.path && e.path !== p) {
      e.message = e.message.replace(`'${e.path}'`, `'${p}'`);
      e.path = p;
    }
    return error;
  }

  /** memfs returns the deepest directory for a recursive mkdir (Node: the first one created) and accepts a file. */
  private async memMkdir(full: string, recursive: boolean, mode?: number) {
    const options = defined({ recursive, mode });
    if (!recursive) {
      return this.fs.promises.mkdir(full, options).catch((e) => {
        throw this.withErrorPath(e, full);
      });
    }
    const existing = this.memStat(full);
    if (existing && !existing.isDirectory()) {
      throw createFsError('EEXIST', 'mkdir', full);
    }
    let first = full;
    while (!this.memStat(path.dirname(first)) && path.dirname(first) !== first) {
      first = path.dirname(first);
    }
    await this.fs.promises.mkdir(full, options);
    return existing ? undefined : first;
  }

  /** memfs lists a recursive readdir in another order than Node (parents first, then breadth-first per folder). */
  private async memReaddirRecursive(full: string): Promise<string[]> {
    const names: string[] = [];
    const queue = [''];
    for (let dir = queue.shift(); dir !== undefined; dir = queue.shift()) {
      const entries = await this.fs.promises.readdir(path.join(full, dir), { withFileTypes: true });
      for (const entry of entries) {
        const relative = path.join(dir, String(entry.name));
        names.push(relative);
        if (entry.isDirectory()) queue.push(relative);
      }
    }
    return names;
  }

  /** memfs does not check these rename cases and silently replaces or moves into itself. */
  private memRenameChecks(src: string, dest: string) {
    const source = this.memStat(src);
    if (!source || path.resolve(src) === path.resolve(dest)) return;
    if (source.isDirectory() && path.resolve(dest).startsWith(path.resolve(src) + path.sep)) {
      throw createFsError('EINVAL', 'rename', src, dest);
    }
    const target = this.memStat(dest);
    if (!target) return;
    if (source.isDirectory() && !target.isDirectory()) throw createFsError('ENOTDIR', 'rename', src, dest);
    if (!source.isDirectory() && target.isDirectory()) throw createFsError('EISDIR', 'rename', src, dest);
    if (source.isDirectory() && this.fs.readdirSync(dest).length > 0) {
      throw createFsError('ENOTEMPTY', 'rename', src, dest);
    }
  }

  /** memfs ignores `end` without `start` and reads a directory as empty. */
  private memReadStream(full: string, options: DriverReadStreamOptions): Readable {
    const { start, end } = options;
    if (this.memStat(full)?.isDirectory()) {
      const failing = new Readable({ read() {} });
      process.nextTick(() => failing.destroy(createFsError('EISDIR', 'read')));
      return failing;
    }
    const fixed = typeof end === 'number' && start === undefined ? { ...options, start: 0 } : options;
    return this.fs.createReadStream(full, defined(fixed)) as Readable;
  }
}
