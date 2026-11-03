import * as fs from 'fs';
import * as path from 'path';
import { Readable, Writable } from 'stream';
import { StorageCreateWriteStreamOptions, StorageModuleOptions, StorageStats } from '../interfaces';
import {
  DriverMkdirOptions,
  DriverReaddirOptions,
  DriverReadFileOptions,
  DriverReadStreamOptions,
  DriverRmdirOptions,
  DriverRmOptions,
  DriverWriteFileOptions,
  StorageDriver,
} from '../interfaces/storage-driver.interface';
import { defined } from './options';

/** The `fileSystem` backend: Node's `fs`, with every path confined to the prefix. */
export class FileSystemDriver implements StorageDriver {
  /** Node's `fs`; the memory driver swaps in the `fs` of a private memfs volume */
  protected fs: typeof fs = fs;
  protected prefix: string;

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

  async mkdir(folderPath: string, options: DriverMkdirOptions): Promise<string | undefined> {
    return this.fs.promises.mkdir(
      this.fsPath(folderPath),
      defined({ recursive: options.recursive, mode: options.mode }),
    );
  }

  async readdir(folderPath: string, options: DriverReaddirOptions): Promise<string[]> {
    return this.fs.promises.readdir(this.fsPath(folderPath), { recursive: options.recursive });
  }

  async rmdir(folderPath: string, options: DriverRmdirOptions): Promise<void> {
    if (options.recursive) {
      return this.fs.promises.rm(this.fsPath(folderPath), { recursive: true });
    }
    return this.fs.promises.rmdir(this.fsPath(folderPath));
  }

  async stat(p: string): Promise<StorageStats> {
    return this.fs.promises.stat(this.fsPath(p));
  }

  async exists(p: string): Promise<boolean> {
    return this.fs.existsSync(this.fsPath(p));
  }

  async readFile(filePath: string, options: DriverReadFileOptions): Promise<Buffer> {
    return this.fs.promises.readFile(this.fsPath(filePath), defined({ flag: options.flag }));
  }

  async writeFile(filePath: string, data: Buffer, options: DriverWriteFileOptions): Promise<void> {
    return this.fs.promises.writeFile(this.fsPath(filePath), data, defined({ mode: options.mode, flag: options.flag }));
  }

  async rm(filePath: string, options: DriverRmOptions): Promise<void> {
    return this.fs.promises.rm(this.fsPath(filePath), { force: options.force, recursive: options.recursive });
  }

  async copyFile(src: string, dest: string, mode: number): Promise<void> {
    return this.fs.promises.copyFile(this.fsPath(src), this.fsPath(dest), mode);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const [src, dest] = [this.fsPath(oldPath), this.fsPath(newPath)];
    return this.fs.promises.rename(src, dest);
  }

  createReadStream(filePath: string, options: DriverReadStreamOptions): Readable {
    return this.fs.createReadStream(this.fsPath(filePath), defined(options));
  }

  createWriteStream(filePath: string, options: StorageCreateWriteStreamOptions): Writable {
    return this.fs.createWriteStream(
      this.fsPath(filePath),
      defined({
        highWaterMark: options.highWaterMark,
        encoding: options.encoding,
        flags: options.flags,
        mode: options.mode,
      }),
    );
  }
}
