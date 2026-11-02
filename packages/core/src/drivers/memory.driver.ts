import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import {
  StorageCreateReadStreamOptions,
  StorageMkdirOptions,
  StorageModuleOptions,
  StorageReaddirOptions,
  StorageReadFileOptions,
} from '../interfaces';
import { fsError } from './fs-error';
import { FileSystemDriver } from './file-system.driver';
import { defined, encodeNames, readdirOptions, splitBucket } from './options';

/**
 * The `memory` backend: the filesystem driver on a private in-memory (memfs) volume.
 * memfs does not behave exactly like Node's fs in a few places. The shims below make the memory backend match what
 * Node's fs does (verified against the real fs in the parity tests).
 */
export class MemoryDriver extends FileSystemDriver {
  protected readonly label: string = 'memory';

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

  async mkdir(folderPath: string, options?: StorageMkdirOptions): Promise<string | undefined> {
    const recursive = options?.recursive ?? true;

    return this.memMkdir(this.fsPath(folderPath), recursive, options?.mode);
  }

  async readdir(folderPath: string, options?: BufferEncoding | StorageReaddirOptions): Promise<string[]> {
    const opts = readdirOptions(options);

    if (opts.recursive) {
      return this.memReaddirRecursive(this.fsPath(folderPath), opts.encoding);
    }
    return super.readdir(folderPath, options);
  }

  async readFile(
    filePath: string,
    options: BufferEncoding | (StorageReadFileOptions & { encoding: BufferEncoding }),
  ): Promise<string>;
  async readFile(filePath: string, options?: (StorageReadFileOptions & { encoding?: null }) | null): Promise<Buffer>;
  async readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer>;
  async readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer> {
    return super.readFile(filePath, options).catch((e) => {
      // memfs leaves the path out of the EISDIR error (memory shim)
      if (e?.code === 'EISDIR' && !e.path) throw fsError('EISDIR', 'read', this.fsPath(filePath));
      throw e;
    });
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const [src, dest] = [this.fsPath(oldPath), this.fsPath(newPath)];
    this.memRenameChecks(src, dest);
    return super.rename(oldPath, newPath);
  }

  createReadStream(filePath: string, options?: StorageCreateReadStreamOptions): Readable {
    const { fsOptions } = splitBucket(options);

    return this.memReadStream(this.fsPath(filePath), fsOptions);
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
      throw fsError('EEXIST', 'mkdir', full);
    }
    let first = full;
    while (!this.memStat(path.dirname(first)) && path.dirname(first) !== first) {
      first = path.dirname(first);
    }
    await this.fs.promises.mkdir(full, options);
    return existing ? undefined : first;
  }

  /** memfs lists a recursive readdir in another order than Node (parents first, then breadth-first per folder). */
  private async memReaddirRecursive(full: string, encoding?: string): Promise<any[]> {
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
    return encodeNames(names, encoding);
  }

  /** memfs does not check these rename cases and silently replaces or moves into itself. */
  private memRenameChecks(src: string, dest: string) {
    const source = this.memStat(src);
    if (!source || path.resolve(src) === path.resolve(dest)) return;
    if (source.isDirectory() && path.resolve(dest).startsWith(path.resolve(src) + path.sep)) {
      throw fsError('EINVAL', 'rename', src, dest);
    }
    const target = this.memStat(dest);
    if (!target) return;
    if (source.isDirectory() && !target.isDirectory()) throw fsError('ENOTDIR', 'rename', src, dest);
    if (!source.isDirectory() && target.isDirectory()) throw fsError('EISDIR', 'rename', src, dest);
    if (source.isDirectory() && this.fs.readdirSync(dest).length > 0) {
      throw fsError('ENOTEMPTY', 'rename', src, dest);
    }
  }

  /** memfs ignores `end` without `start`, reads a directory as empty and words the start > end error differently. */
  private memReadStream(full: string, options: Record<string, any>): Readable {
    const { start, end } = options;
    if (typeof start === 'number' && typeof end === 'number' && start > end) {
      const error: NodeJS.ErrnoException = new RangeError(
        `The value of "start" is out of range. It must be <= "end" (here: ${end}). Received ${start}`,
      );
      error.code = 'ERR_OUT_OF_RANGE';
      throw error;
    }
    if (this.memStat(full)?.isDirectory()) {
      const failing = new Readable({ read() {} });
      if (options.encoding) failing.setEncoding(options.encoding);
      process.nextTick(() => failing.destroy(fsError('EISDIR', 'read')));
      return failing;
    }
    const fixed = typeof end === 'number' && start === undefined ? { ...options, start: 0 } : options;
    return this.fs.createReadStream(full, fixed) as Readable;
  }
}
