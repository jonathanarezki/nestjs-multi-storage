import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PassThrough, Readable, Writable } from 'stream';
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
import { fsError, rmDirectoryError } from './fs-error';
import { remotePath } from './remote-path';
import { encodeNames, readdirOptions, readFileOptions, writeFileOptions } from './options';
import { buildStats, defaultMode } from './stats';

type FtpClient = import('basic-ftp').Client;

/** What a lookup finds at a path (`mtime` is the epoch when the server cannot tell). */
type FtpEntry = { isDirectory: boolean; size: number; mtime: Date };

/** The `ftp` backend (needs the optional peer dependency `basic-ftp`). */
export class FtpDriver implements StorageDriver {
  /** The lazily loaded `basic-ftp` module (private: its type must not leak into the emitted .d.ts) */
  private readonly lib: typeof import('basic-ftp');
  protected readonly prefix: string;
  protected readonly host: string;
  protected readonly port: number;
  protected readonly username?: string;
  protected readonly password?: string;
  protected readonly timeout?: number;
  protected readonly secure: boolean | 'implicit';
  protected readonly maxConnections: number;
  /** Every open connection (one command at a time each), the idle ones, and the callers waiting for a free one (FIFO) */
  private readonly clients = new Set<FtpClient>();
  private idle: FtpClient[] = [];
  private readonly waiters: { resolve: (client: FtpClient) => void; reject: (error: Error) => void }[] = [];
  private destroyed = false;

  constructor(options: StorageModuleOptions) {
    // basic-ftp is an optional peer dependency: only loaded when a 'ftp' disk is created
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.lib = require('basic-ftp');
    } catch (error: any) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
      throw Object.assign(
        new Error(`type 'ftp' requires the optional peer dependency "basic-ftp": npm install basic-ftp`),
        { cause: error },
      );
    }
    if (!options.host) {
      throw new Error(`type 'ftp' requires "host"`);
    }
    this.secure = options.secure ?? false;
    this.maxConnections = options.maxConnections ?? 2;
    this.host = options.host;
    this.port = options.port ?? 21;
    this.username = options.username;
    this.password = options.password;
    this.timeout = options.timeout;
    this.prefix = options.prefix ?? '';
  }

  async init(): Promise<void> {
    // Connections are opened lazily, on the first operation
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    for (const waiter of this.waiters.splice(0)) waiter.reject(new Error('The ftp storage has been destroyed'));
    for (const client of this.clients) client.close();
    this.clients.clear();
    this.idle = [];
  }

  /** Unlike `fs.promises.mkdir`, `recursive` defaults to `true`. The `mode` is ignored. */
  async mkdir(folderPath: string, options?: StorageMkdirOptions): Promise<string | undefined> {
    const full = this.ftpPath(folderPath);
    const recursive = options?.recursive ?? true;

    return this.run(async (client) => {
      if (!recursive) {
        try {
          await this.mkd(client, full);
        } catch (error) {
          if (!this.isReply(error)) throw error;
          if (await this.lookup(client, full)) throw fsError('EEXIST', 'mkdir', full);
          const parent = await this.lookup(client, path.posix.dirname(full));
          if (!parent) throw fsError(await this.missingParentCode(client, full), 'mkdir', full);
          if (!parent.isDirectory) throw fsError('ENOTDIR', 'mkdir', full);
          throw error;
        }
        return undefined;
      }

      // Walk up to the first existing ancestor, then create the missing folders downwards
      const missing: string[] = [];
      for (let current = full; ; current = path.posix.dirname(current)) {
        const found = await this.lookup(client, current);
        if (found) {
          if (!found.isDirectory) throw fsError(current === full ? 'EEXIST' : 'ENOTDIR', 'mkdir', full);
          break;
        }
        missing.unshift(current);
      }
      for (const folder of missing) {
        try {
          await this.mkd(client, folder);
        } catch (error) {
          // Another client may have created it in the meantime
          if (!this.isReply(error) || !(await this.lookup(client, folder))?.isDirectory) throw error;
        }
      }
      return missing[0];
    });
  }

  async readdir(folderPath: string, options?: BufferEncoding | StorageReaddirOptions): Promise<string[]> {
    const full = this.ftpPath(folderPath);
    const opts = readdirOptions(options);

    const names = await this.run(async (client) => {
      const found = await this.lookup(client, full);
      if (!found) throw fsError('ENOENT', 'scandir', full);
      if (!found.isDirectory) throw fsError('ENOTDIR', 'scandir', full);

      const names: string[] = [];
      const walk = async (folder: string, relative: string) => {
        for (const entry of await this.entries(client, folder)) {
          const name = path.posix.join(relative, entry.name);
          names.push(name);
          if (opts.recursive && entry.isDirectory) await walk(path.posix.join(folder, entry.name), name);
        }
      };
      await walk(full, '');
      return names;
    });
    return encodeNames(names, opts.encoding);
  }

  /** Unlike `fs.promises.rmdir`, `recursive` defaults to `true` (like `fs.promises.rm(path, { recursive: true })`). */
  async rmdir(folderPath: string, options?: StorageRmdirOptions): Promise<void> {
    const full = this.ftpPath(folderPath);
    const recursive = options?.recursive ?? true;

    return this.run(async (client) => {
      const found = await this.lookup(client, full);
      if (recursive) {
        if (!found) throw fsError('ENOENT', 'lstat', full);
        if (!found.isDirectory) return void (await client.remove(full));
        return this.removeTree(client, full);
      }
      if (!found) throw fsError('ENOENT', 'rmdir', full);
      if (!found.isDirectory) throw fsError('ENOTDIR', 'rmdir', full);
      try {
        await client.removeEmptyDir(full);
      } catch (error) {
        if (this.isReply(error) && (await this.entries(client, full)).length > 0) {
          throw fsError('ENOTEMPTY', 'rmdir', full);
        }
        throw error;
      }
    });
  }

  async stat(p: string): Promise<StorageStats> {
    const full = this.ftpPath(p);

    const found = await this.run((client) => this.lookup(client, full));
    if (!found) throw fsError('ENOENT', 'stat', full);
    return buildStats({ mode: defaultMode(found.isDirectory), size: found.size, mtime: found.mtime });
  }

  /**
   * Unlike `fs.existsSync`, errors other than "not found" (login, network, ...) are thrown, not turned into `false`.
   */
  async exists(p: string): Promise<boolean> {
    const full = this.ftpPath(p);

    return !!(await this.run((client) => this.lookup(client, full)));
  }

  async readFile(
    filePath: string,
    options: BufferEncoding | (StorageReadFileOptions & { encoding: BufferEncoding }),
  ): Promise<string>;
  async readFile(filePath: string, options?: (StorageReadFileOptions & { encoding?: null }) | null): Promise<Buffer>;
  async readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer>;
  async readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer> {
    const { encoding } = readFileOptions(options).fsOptions;
    const full = this.ftpPath(filePath);

    // A retry starts from scratch
    const chunks: Buffer[] = [];
    await this.run(async (client) => {
      chunks.length = 0;
      const sink = new Writable({
        write(chunk, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      });
      try {
        await client.downloadTo(sink, full);
      } catch (error) {
        throw await this.readError(client, error, full, true);
      }
    });
    const data = Buffer.concat(chunks);
    return encoding ? data.toString(encoding) : data;
  }

  async writeFile(
    filePath: string,
    data: string | Buffer | Uint8Array,
    options?: BufferEncoding | StorageWriteFileOptions,
  ): Promise<void> {
    const { encoding, flag } = writeFileOptions(options);
    const full = this.ftpPath(filePath);

    const buffer = typeof data === 'string' ? Buffer.from(data, encoding) : Buffer.from(data);
    const append = !!flag?.startsWith('a');
    // Appending is not idempotent: it must not be retried on a new connection
    return this.run(async (client) => {
      if (flag?.includes('x') && (await this.lookup(client, full))) throw fsError('EEXIST', 'open', full);
      const source = Readable.from(buffer.length ? [buffer] : []);
      try {
        await (append ? client.appendFrom(source, full) : client.uploadFrom(source, full));
      } catch (error) {
        throw await this.uploadError(client, error, full, (code) => fsError(code, 'open', full));
      }
    }, !append);
  }

  async getSignedUrl(): Promise<string> {
    throw new Error('Signed URLs are not supported for ftp storage.');
  }

  async getSignedPutUrl(): Promise<string> {
    throw new Error('Signed URLs are not supported for ftp storage.');
  }

  async rm(filePath: string, options?: StorageRmOptions): Promise<void> {
    const full = this.ftpPath(filePath);

    return this.run(async (client) => {
      const found = await this.lookup(client, full);
      if (!found) {
        if (options?.force) return;
        throw fsError('ENOENT', 'lstat', full);
      }
      if (!found.isDirectory) return void (await client.remove(full));
      if (!options?.recursive) {
        throw rmDirectoryError(full);
      }
      return this.removeTree(client, full);
    });
  }

  /**
   * FTP has no server-side copy: the file is downloaded to a temporary local file and uploaded again (one connection,
   * any size). `COPYFILE_EXCL` is a check followed by the upload, so it is not atomic.
   */
  async copyFile(src: string, dest: string, mode?: number): Promise<void> {
    const [from, to] = [this.ftpPath(src), this.ftpPath(dest)];

    return this.run(async (client) => {
      const source = await this.lookup(client, from);
      if (!source) throw fsError('ENOENT', 'copyfile', from, to);
      const target = await this.lookup(client, to);
      if (source.isDirectory || target?.isDirectory) throw fsError('EISDIR', 'copyfile', from, to);
      if (target && (mode ?? 0) & fs.constants.COPYFILE_EXCL) throw fsError('EEXIST', 'copyfile', from, to);
      if (from === to) return;

      const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'nestjs-multi-storage-'));
      try {
        const local = path.join(folder, 'copy');
        await client.downloadTo(local, from);
        try {
          await client.uploadFrom(local, to);
        } catch (error) {
          throw await this.uploadError(client, error, to, (code) => fsError(code, 'copyfile', from, to));
        }
      } finally {
        await fs.promises.rm(folder, { recursive: true, force: true });
      }
    }, false);
  }

  /** RNFR / RNTO, after the checks that make servers behave like `fs.rename`. */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const [from, to] = [this.ftpPath(oldPath), this.ftpPath(newPath)];

    return this.run(async (client) => {
      const source = await this.lookup(client, from);
      if (!source) throw fsError('ENOENT', 'rename', from, to);
      const [fromDir, toDir] = [from.replace(/\/+$/, ''), to.replace(/\/+$/, '')];
      if (fromDir === toDir) return;
      if (source.isDirectory && toDir.startsWith(`${fromDir}/`)) throw fsError('EINVAL', 'rename', from, to);

      const target = await this.lookup(client, to);
      if (target) {
        if (source.isDirectory && !target.isDirectory) throw fsError('ENOTDIR', 'rename', from, to);
        if (!source.isDirectory && target.isDirectory) throw fsError('EISDIR', 'rename', from, to);
        if (target.isDirectory && (await this.entries(client, to)).length > 0) {
          throw fsError('ENOTEMPTY', 'rename', from, to);
        }
      }
      try {
        await client.rename(from, to);
      } catch (error) {
        if (!this.isReply(error)) throw error;
        if (target) {
          // Some servers refuse to replace an existing file or folder: remove it (it is a file or an empty folder)
          await (target.isDirectory ? client.removeEmptyDir(to) : client.remove(to));
          return void (await client.rename(from, to));
        }
        const parent = await this.lookup(client, path.posix.dirname(to));
        if (!parent) throw fsError(await this.missingParentCode(client, to), 'rename', from, to);
        if (!parent.isDirectory) throw fsError('ENOTDIR', 'rename', from, to);
        throw error;
      }
    }, false);
  }

  /** `start` is a REST offset, `end` is applied client-side: the connection is dropped once enough bytes arrived. */
  createReadStream(filePath: string, options?: StorageCreateReadStreamOptions): Readable {
    const full = this.ftpPath(filePath);
    const start = options?.start ?? 0;

    const pass = new PassThrough({ highWaterMark: options?.highWaterMark });
    if (options?.encoding) {
      pass.setEncoding(options.encoding);
    }

    let client: FtpClient | undefined;
    let remaining = typeof options?.end === 'number' ? options.end - start + 1 : Infinity;
    let transferring = false;
    let truncated = false;
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (remaining <= 0) return callback();
        const part = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
        remaining -= part.length;
        const flowing = pass.write(part);
        if (remaining <= 0) {
          // Everything requested has arrived: drop the connection instead of downloading the rest of the file
          truncated = true;
          transferring = false;
          client?.close();
        }
        if (flowing) callback();
        else pass.once('drain', () => callback());
      },
      final(callback) {
        transferring = false;
        callback();
      },
    });
    // Destroyed before the end: abort the transfer (the connection is discarded)
    pass.once('close', () => {
      if (transferring) client?.close();
    });

    this.acquire().then(
      async (acquired) => {
        client = acquired;
        try {
          if (pass.destroyed) return;
          transferring = remaining > 0;
          try {
            if (remaining > 0) await acquired.downloadTo(sink, full, start);
          } catch (error) {
            if (!truncated && !pass.destroyed) throw error;
          } finally {
            transferring = false;
          }
          if (!pass.destroyed) pass.end();
        } catch (error) {
          pass.destroy((await this.readError(acquired, error, full, false).catch(() => error)) as Error);
        } finally {
          this.release(acquired);
        }
      },
      (error) => pass.destroy(error),
    );

    return pass;
  }

  createWriteStream(filePath: string, options?: StorageCreateWriteStreamOptions): Writable {
    const full = this.ftpPath(filePath);
    const append = !!options?.flags?.startsWith('a');

    const pass = new PassThrough({ highWaterMark: options?.highWaterMark });
    let client: FtpClient | undefined;
    let transferring = false;

    const done = this.acquire().then(async (acquired) => {
      client = acquired;
      try {
        if (writable.destroyed) return;
        transferring = true;
        try {
          await (append ? acquired.appendFrom(pass, full) : acquired.uploadFrom(pass, full));
        } finally {
          transferring = false;
        }
      } catch (error) {
        throw await this.uploadError(acquired, error, full, (code) => fsError(code, 'open', full));
      } finally {
        this.release(acquired);
      }
    });

    // 'finish' is only emitted once the upload has completed on the server, like fs.WriteStream after the flush
    const writable = new Writable({
      highWaterMark: options?.highWaterMark,
      defaultEncoding: options?.encoding,
      write(chunk, encoding, callback) {
        if (pass.write(chunk, encoding)) {
          callback();
        } else {
          pass.once('drain', () => callback());
        }
      },
      final(callback) {
        pass.end();
        done.then(() => callback(), callback);
      },
      destroy(error, callback) {
        // Aborted before the upload has completed: drop the connection (it is discarded, not reused)
        if (transferring) client?.close();
        pass.destroy();
        callback(error);
      },
    });

    done.catch((error) => writable.destroy(error));

    return writable;
  }

  // --- connection pool ---

  /** Takes an idle connection, opens one while below `maxConnections`, or waits (FIFO) for a released one. */
  private async acquire(): Promise<FtpClient> {
    if (this.destroyed) throw new Error('The ftp storage has been destroyed');
    for (let client = this.idle.pop(); client; client = this.idle.pop()) {
      if (!client.closed) return client;
      // The server dropped it while idle
      this.clients.delete(client);
    }
    if (this.clients.size < this.maxConnections) return this.connect();
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** Gives the connection back; a closed or unusable one is discarded and its slot goes to the first waiter. */
  private release(client: FtpClient) {
    if (!client.closed && !this.destroyed) {
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(client);
      else this.idle.push(client);
      return;
    }
    client.close();
    this.clients.delete(client);
    this.openForWaiter();
  }

  /** A slot is free: the first waiter (if any) gets a new connection. */
  private openForWaiter() {
    const waiter = this.waiters.shift();
    if (waiter) this.connect().then(waiter.resolve, waiter.reject);
  }

  private async connect(): Promise<FtpClient> {
    const client = new this.lib.Client(this.timeout);
    this.clients.add(client);
    try {
      await client.access({
        host: this.host,
        port: this.port,
        user: this.username,
        password: this.password,
        secure: this.secure,
      });
      return client;
    } catch (error) {
      client.close();
      this.clients.delete(client);
      this.openForWaiter();
      throw error;
    }
  }

  /**
   * Runs `operation` on its own connection. When that connection turns out to be dead (the server dropped it), the
   * operation is retried once on a new one, unless `retry` is false (operations that are not idempotent).
   */
  private async run<T>(operation: (client: FtpClient) => Promise<T>, retry = true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const client = await this.acquire();
      try {
        return await operation(client);
      } catch (error) {
        if (!(retry && attempt === 0 && client.closed && !this.isReply(error))) throw error;
      } finally {
        this.release(client);
      }
    }
  }

  // --- lookups ---

  /** The Node-style path of `p` below the prefix; throws when it escapes the prefix. */
  private ftpPath(p: string) {
    return remotePath(this.prefix, p);
  }

  /** True for an error reply of the server (not for a lost connection or an error of ours). */
  private isReply(error: unknown): error is import('basic-ftp').FTPError {
    return error instanceof this.lib.FTPError;
  }

  /** The entries of a folder, without `.` and `..`. */
  private async entries(client: FtpClient, folder: string) {
    return (await client.list(folder)).filter((entry) => entry.name !== '.' && entry.name !== '..');
  }

  /**
   * Whether `full` is a file or a folder, or `undefined` when it does not exist. SIZE and MDTM identify files; for
   * anything else the parent folder is listed (LIST, or MLSD when the server supports it).
   */
  private async lookup(client: FtpClient, full: string): Promise<FtpEntry | undefined> {
    if (full === '.' || full === '/') {
      return { isDirectory: true, size: 0, mtime: new Date(0) };
    }
    try {
      const size = await client.size(full);
      const mtime = await client.lastMod(full).catch(() => new Date(0));
      return { isDirectory: false, size, mtime };
    } catch (error) {
      if (!this.isReply(error)) throw error;
    }
    let entries;
    try {
      entries = await this.entries(client, path.posix.dirname(full));
    } catch (error) {
      // 550 / 450: the parent does not exist (or is no folder)
      if (this.isReply(error) && [550, 450].includes(error.code)) return undefined;
      throw error;
    }
    const entry = entries.find((candidate) => candidate.name === path.posix.basename(full));
    if (!entry) return undefined;
    if (entry.isDirectory) {
      return { isDirectory: true, size: 0, mtime: entry.modifiedAt ?? new Date(0) };
    }
    return { isDirectory: false, size: entry.size, mtime: entry.modifiedAt ?? new Date(0) };
  }

  /** A failed RETR: the server only says 550 for a missing file and a folder alike. */
  private async readError(client: FtpClient, error: unknown, full: string, withPath: boolean) {
    if (!this.isReply(error)) return error;
    const found = await this.lookup(client, full);
    if (found?.isDirectory) {
      // Node's stream error for a folder carries no path
      return fsError('EISDIR', 'read', withPath ? full : undefined);
    }
    return found ? error : fsError('ENOENT', 'open', full);
  }

  /** A failed STOR / APPE: the target is a folder or its parent is missing or no folder. */
  private async uploadError(
    client: FtpClient,
    error: unknown,
    target: string,
    toError: (code: 'EISDIR' | 'ENOENT' | 'ENOTDIR') => Error,
  ) {
    if (!this.isReply(error)) return error;
    if ((await this.lookup(client, target))?.isDirectory) return toError('EISDIR');
    const parent = await this.lookup(client, path.posix.dirname(target));
    if (!parent) return toError(await this.missingParentCode(client, target));
    return parent.isDirectory ? error : toError('ENOTDIR');
  }

  /** The parent folder of `p` is missing: ENOTDIR when an ancestor is a file (as on Node), else ENOENT. */
  private async missingParentCode(client: FtpClient, p: string): Promise<'ENOENT' | 'ENOTDIR'> {
    for (let ancestor = path.posix.dirname(path.posix.dirname(p)); ; ancestor = path.posix.dirname(ancestor)) {
      const found = await this.lookup(client, ancestor);
      if (found) return found.isDirectory ? 'ENOENT' : 'ENOTDIR';
      if (path.posix.dirname(ancestor) === ancestor) return 'ENOENT';
    }
  }

  /** Creates one folder (not its parents). */
  private async mkd(client: FtpClient, folder: string) {
    await client.send(`MKD ${await client.protectWhitespace(folder)}`);
  }

  /** Deletes a folder with everything below it (the root of the prefix itself is kept). */
  private async removeTree(client: FtpClient, folder: string) {
    for (const entry of await this.entries(client, folder)) {
      const child = path.posix.join(folder, entry.name);
      await (entry.isDirectory ? this.removeTree(client, child) : client.remove(child));
    }
    if (folder !== '.' && folder !== '/') await client.removeEmptyDir(folder);
  }
}
