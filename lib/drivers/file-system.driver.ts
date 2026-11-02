import * as fs from 'fs';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import {
  StorageCreateReadStreamOptions,
  StorageCreateWriteStreamOptions,
  StorageMkdirOptions,
  StorageModuleOptions,
  StorageReaddirOptions,
  StorageReadFileOptions,
  StorageRmdirOptions,
  StorageRmOptions,
  StorageStats,
  StorageWriteFileOptions,
} from '../interfaces';
import { StorageDriver } from '../interfaces/storage-driver.interface';
import { defined, readdirOptions, readFileOptions, splitBucket, writeFileOptions } from './options';

/** The `fileSystem` backend: Node's `fs`, with every path confined to the prefix. The `bucket` option is S3-only. */
export class FileSystemDriver implements StorageDriver {
  /** Node's `fs`; the memory driver swaps in the `fs` of a private memfs volume */
  protected fs: typeof fs = fs;
  protected prefix: string;
  /** Names the backend in error messages */
  protected readonly label: string = 'filesystem';

  constructor(options: StorageModuleOptions) {
    this.prefix = options.prefix ?? '';
  }

  async init(): Promise<void> {}

  async destroy(): Promise<void> {}

  protected fsPath(p: string) {
    const joined = path.join(this.prefix, p);
    if (this.prefix) {
      const root = path.resolve(this.prefix);
      const resolved = path.resolve(joined);
      // A root such as '/' already ends with a separator
      const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
      if (resolved !== root && !resolved.startsWith(rootWithSep)) {
        throw new Error(`Path "${p}" escapes the storage prefix "${this.prefix}"`);
      }
    }
    return joined;
  }

  /** Unlike `fs.promises.mkdir`, `recursive` defaults to `true`. */
  async mkdir(folderPath: string, options?: StorageMkdirOptions): Promise<string | undefined> {
    const recursive = options?.recursive ?? true;

    return this.fs.promises.mkdir(this.fsPath(folderPath), defined({ recursive, mode: options?.mode }));
  }

  async readdir(folderPath: string, options?: BufferEncoding | StorageReaddirOptions): Promise<string[]> {
    const opts = readdirOptions(options);

    if (opts.recursive !== undefined || opts.encoding !== undefined) {
      return this.fs.promises.readdir(
        this.fsPath(folderPath),
        defined({ recursive: opts.recursive, encoding: opts.encoding }) as { encoding: BufferEncoding },
      );
    }
    return this.fs.promises.readdir(this.fsPath(folderPath));
  }

  /** Unlike `fs.promises.rmdir`, `recursive` defaults to `true` (like `fs.promises.rm(path, { recursive: true })`). */
  async rmdir(folderPath: string, options?: StorageRmdirOptions): Promise<void> {
    const recursive = options?.recursive ?? true;

    if (recursive) {
      return this.fs.promises.rm(this.fsPath(folderPath), { recursive: true });
    }
    return this.fs.promises.rmdir(this.fsPath(folderPath));
  }

  async stat(p: string): Promise<StorageStats> {
    return this.fs.promises.stat(this.fsPath(p));
  }

  /**
   * Unlike `fs.existsSync`, errors other than "not found" (403, network, ...) are thrown, not turned into `false`.
   */
  async exists(p: string): Promise<boolean> {
    return this.fs.existsSync(this.fsPath(p));
  }

  async readFile(
    filePath: string,
    options: BufferEncoding | (StorageReadFileOptions & { encoding: BufferEncoding }),
  ): Promise<string>;
  async readFile(filePath: string, options?: (StorageReadFileOptions & { encoding?: null }) | null): Promise<Buffer>;
  async readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer>;
  async readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer> {
    const { fsOptions } = readFileOptions(options);

    const full = this.fsPath(filePath);
    return this.fs.promises.readFile(full, defined(fsOptions) as { encoding: BufferEncoding });
  }

  async writeFile(
    filePath: string,
    data: string | Buffer | Uint8Array,
    options?: BufferEncoding | StorageWriteFileOptions,
  ): Promise<void> {
    const { encoding, mode, flag } = writeFileOptions(options);

    return this.fs.promises.writeFile(this.fsPath(filePath), data, defined({ encoding, mode, flag }));
  }

  async getSignedUrl(): Promise<string> {
    throw new Error(`Signed URLs are not supported for ${this.label} storage.`);
  }

  async getSignedPutUrl(): Promise<string> {
    throw new Error(`Signed URLs are not supported for ${this.label} storage.`);
  }

  async rm(filePath: string, options?: StorageRmOptions): Promise<void> {
    return this.fs.promises.rm(
      this.fsPath(filePath),
      defined({ force: options?.force, recursive: options?.recursive }),
    );
  }

  async copyFile(src: string, dest: string, mode?: number): Promise<void> {
    return this.fs.promises.copyFile(this.fsPath(src), this.fsPath(dest), mode);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const [src, dest] = [this.fsPath(oldPath), this.fsPath(newPath)];
    return this.fs.promises.rename(src, dest);
  }

  createReadStream(filePath: string, options?: StorageCreateReadStreamOptions): Readable {
    const { fsOptions } = splitBucket(options);

    return this.fs.createReadStream(this.fsPath(filePath), fsOptions);
  }

  createWriteStream(filePath: string, options?: StorageCreateWriteStreamOptions): Writable {
    return this.fs.createWriteStream(
      this.fsPath(filePath),
      defined({
        highWaterMark: options?.highWaterMark,
        encoding: options?.encoding,
        flags: options?.flags,
        mode: options?.mode,
      }),
    );
  }
}
