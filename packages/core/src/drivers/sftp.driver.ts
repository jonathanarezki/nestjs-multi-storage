import { createHash } from 'crypto';
import * as fs from 'fs';
import { connect as tcpConnect, Socket } from 'net';
import * as path from 'path';
import { PassThrough, Readable, Writable } from 'stream';
import { pipeline } from 'stream/promises';
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
import { defined, encodeNames, readdirOptions, readFileOptions, splitBucket, writeFileOptions } from './options';
import { buildStats } from './stats';

/** SFTP status codes that ssh2 puts into `error.code` (the others are not told apart by this driver) */
const SFTP_NO_SUCH_FILE = 2;
const SFTP_PERMISSION_DENIED = 3;
const SFTP_NO_CONNECTION = 6;
const SFTP_CONNECTION_LOST = 7;

/** How many deletions of a recursive `rm` run at once (SFTP multiplexes them over the one connection) */
const RM_CONCURRENCY = 16;

/** The raw ssh2 SFTP channel (`any`: ssh2's types must not leak into the emitted .d.ts, nor become a dependency) */
type Sftp = any;

type SshClient = import('ssh2').Client;

/** The attributes ssh2 returns for a remote path (a subset of its `Stats`); times are in seconds */
interface RemoteStats {
  mode: number;
  uid: number;
  gid: number;
  size: number;
  atime: number;
  mtime: number;
}

const isDirectory = (stats: RemoteStats) => (stats.mode & fs.constants.S_IFMT) === fs.constants.S_IFDIR;

/** ssh2 reports SFTP status errors with a numeric `code`; Node's own (and our) errors have a string one */
const isSftpStatus = (error: any): error is Error & { code: number } => typeof error?.code === 'number';

/** True for a failure of the connection itself (as opposed to a failed operation) */
function isConnectionError(error: any) {
  if (isSftpStatus(error)) {
    return error.code === SFTP_NO_CONNECTION || error.code === SFTP_CONNECTION_LOST;
  }
  return (
    ['ERR_NOT_CONNECTED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT'].includes(error?.code) ||
    /not connected|no response from server|no sftp connection|socket|channel|closed|unexpected (end|close)/i.test(
      String(error?.message),
    )
  );
}

/** The `sftp` backend (needs the optional peer dependency `ssh2`). */
export class SftpDriver implements StorageDriver {
  /** The lazily loaded `ssh2` module (private: its type must not leak into the emitted .d.ts) */
  private readonly lib: typeof import('ssh2');
  protected readonly prefix: string;
  protected readonly host: string;
  protected readonly port: number;
  protected readonly username?: string;
  protected readonly password?: string;
  protected readonly timeout?: number;
  protected readonly privateKey?: string | Buffer;
  protected readonly passphrase?: string;
  /** Expected `SHA256:<base64>` host key fingerprint, or `false` to skip the verification */
  protected readonly hostKey: string | false;
  /** The connected client and its SFTP channel, or undefined before the first use and after the connection dropped */
  private client: SshClient | undefined;
  private sftp: Sftp | undefined;
  /** The connection being established, shared by concurrent first calls */
  private connecting: Promise<Sftp> | undefined;

  constructor(options: StorageModuleOptions) {
    // ssh2 is an optional peer dependency: only loaded when a 'sftp' disk is created
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.lib = require('ssh2');
    } catch (error: any) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
      throw Object.assign(new Error(`type 'sftp' requires the optional peer dependency "ssh2": npm install ssh2`), {
        cause: error,
      });
    }
    if (!options.host) {
      throw new Error(`type 'sftp' requires "host"`);
    }
    if (options.hostKey !== false && (typeof options.hostKey !== 'string' || options.hostKey === '')) {
      throw new Error(
        `type 'sftp' requires "hostKey" (the server's host key fingerprint) or hostKey: false to skip verification`,
      );
    }
    if (options.hostKey !== false && !options.hostKey.startsWith('SHA256:')) {
      throw new Error(
        `type 'sftp': "hostKey" must be a fingerprint in the form SHA256:<base64> (as printed by ssh-keygen -lf)`,
      );
    }
    this.hostKey = options.hostKey;
    this.privateKey = options.privateKey;
    this.passphrase = options.passphrase;
    this.host = options.host;
    this.port = options.port ?? 22;
    this.username = options.username;
    this.password = options.password;
    this.timeout = options.timeout;
    this.prefix = options.prefix ?? '';
  }

  /** The connection is opened lazily by the first operation. */
  async init(): Promise<void> {}

  async destroy(): Promise<void> {
    await this.connecting?.catch(() => undefined);
    const client = this.client;
    this.client = this.sftp = undefined;
    client?.end();
  }

  // --- connection ---

  /** The SFTP channel: the existing one, or a new connection (shared by concurrent callers). */
  private connection(): Promise<Sftp> {
    if (this.sftp) {
      return Promise.resolve(this.sftp);
    }
    return (this.connecting ??= this.connect().finally(() => (this.connecting = undefined)));
  }

  /** Opens an SSH connection and its SFTP channel. */
  private connect(): Promise<Sftp> {
    return new Promise<Sftp>((resolve, reject) => {
      const client: SshClient = new this.lib.Client();
      let mismatch: string | undefined;
      let open = false;
      // ssh2 opens its own socket with Nagle's algorithm on: the small packets of an SFTP request then wait for the
      // server's delayed ACK (~40 ms), which makes every request take a multiple of 40 ms. The socket is created here
      // for TCP_NODELAY; a failed connect reaches the client as the socket's 'error', as with its own socket.
      const socket: Socket = tcpConnect({ host: this.host, port: this.port, noDelay: true });
      // A dropped connection is forgotten, so that the next operation reconnects. Before the channel is open it is
      // a failed connect (settling a promise twice is a no-op, so a late 'close' after an 'error' changes nothing)
      const lost = (error?: Error) => {
        if (this.client === client) {
          this.client = this.sftp = undefined;
        }
        if (!open) {
          client.end();
          // ssh2 leaves a socket it was given open when the connect fails, and an open socket keeps the process alive
          socket.destroy();
          if (mismatch !== undefined) {
            error = Object.assign(new Error(`sftp host key mismatch: expected ${this.hostKey}, got ${mismatch}`), {
              cause: error,
            });
          }
          reject(error ?? new Error('sftp connection closed before it was ready'));
        }
      };
      // Without error listeners, a connection or channel that breaks under in-flight requests would be an uncaught
      // exception
      client.on('error', lost);
      client.on('end', lost);
      client.on('close', lost);
      client.on('ready', () => {
        client.sftp((error: Error | undefined, sftp: Sftp) => {
          if (error) {
            return lost(error);
          }
          sftp.on('error', lost);
          sftp.on('end', lost);
          sftp.on('close', lost);
          open = true;
          this.client = client;
          this.sftp = sftp;
          resolve(sftp);
        });
      });
      try {
        client.connect({
          host: this.host,
          port: this.port,
          sock: socket,
          ...defined({
            username: this.username,
            password: this.password,
            privateKey: this.privateKey,
            passphrase: this.passphrase,
            readyTimeout: this.timeout,
            // Without keepalive a connection that dies silently (a vanished server, a dropped network) never fails its
            // requests. After `keepaliveCountMax` unanswered pings ssh2 closes the connection: the requests in flight
            // are rejected and the next operation reconnects. Default: a ping every 10 s (with `timeout`: a third of
            // it), so a dead connection is noticed after (3 + 1) intervals
            keepaliveInterval: this.timeout ? Math.max(1, Math.ceil(this.timeout / 3)) : 10_000,
            keepaliveCountMax: 3,
          }),
          hostVerifier: (key: Buffer) => {
            if (this.hostKey === false) {
              return true;
            }
            const fingerprint = `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
            if (fingerprint === this.hostKey) {
              return true;
            }
            mismatch = fingerprint;
            return false;
          },
        });
      } catch (error) {
        // ssh2 throws at once for a config it cannot use (an unparseable key, say), with the socket already open
        socket.destroy();
        client.end();
        reject(error);
      }
    });
  }

  /**
   * Runs `operation` on the connection. With `retry` (reads only: they are safe to repeat), an operation that failed
   * because the connection was lost is run once more on a new connection.
   */
  private async withSftp<T>(operation: (sftp: Sftp) => Promise<T>, retry = false): Promise<T> {
    try {
      return await operation(await this.connection());
    } catch (error) {
      if (!retry || !isConnectionError(error)) {
        throw error;
      }
      const stale = this.client;
      this.client = this.sftp = undefined;
      stale?.end();
      return operation(await this.connection());
    }
  }

  /** Promisifies the ssh2 method `method`, whose callback is its last argument. */
  private call<T = void>(sftp: Sftp, method: string, ...args: unknown[]): Promise<T> {
    return new Promise((resolve, reject) => {
      sftp[method](...args, (error: Error | null | undefined, result: T) => (error ? reject(error) : resolve(result)));
    });
  }

  // --- paths and errors ---

  /** The remote path of `p`, below the prefix (the remote base directory, absolute or relative to the login directory). */
  private sftpPath(p: string) {
    return remotePath(this.prefix, p);
  }

  /**
   * Maps a failed SFTP request to the Node-style error `fs` throws. Servers answer most failures with the generic
   * "failure" status, so the callers diagnose those themselves; errors that are not SFTP statuses (network, ...) pass.
   */
  private async fsFailure(sftp: Sftp, error: unknown, syscall: string, p: string, dest?: string): Promise<unknown> {
    if (!isSftpStatus(error)) {
      return error;
    }
    if (error.code === SFTP_PERMISSION_DENIED) {
      return fsError('EACCES', syscall, p, dest);
    }
    if (error.code === SFTP_NO_SUCH_FILE) {
      // OpenSSH reports a file as a parent folder (ENOTDIR) as "no such file" too
      const belowFile = await this.isBelowFile(sftp, p).catch(() => false);
      return fsError(belowFile ? 'ENOTDIR' : 'ENOENT', syscall, p, dest);
    }
    return error;
  }

  /** True when the closest existing ancestor of `p` is a file (which Node reports as ENOTDIR, not ENOENT). */
  private async isBelowFile(sftp: Sftp, p: string): Promise<boolean> {
    for (let ancestor = path.posix.dirname(p); ; ancestor = path.posix.dirname(ancestor)) {
      const existing = await this.statOrUndefined(sftp, ancestor);
      if (existing) return !isDirectory(existing);
      if (path.posix.dirname(ancestor) === ancestor) return false;
    }
  }

  /** `stat` (or `lstat`, not following symbolic links) of `p`, or undefined when it does not exist. */
  private async statOrUndefined(sftp: Sftp, p: string, lstat = false): Promise<RemoteStats | undefined> {
    try {
      return await this.call<RemoteStats>(sftp, lstat ? 'lstat' : 'stat', p);
    } catch (error) {
      if ((error as any)?.code === SFTP_NO_SUCH_FILE) {
        return undefined;
      }
      throw await this.fsFailure(sftp, error, lstat ? 'lstat' : 'stat', p);
    }
  }

  // --- folders ---

  /** Unlike `fs.promises.mkdir`, `recursive` defaults to `true`. */
  async mkdir(folderPath: string, options?: StorageMkdirOptions): Promise<string | undefined> {
    const recursive = options?.recursive ?? true;
    const full = this.sftpPath(folderPath);

    return this.withSftp(async (sftp) => {
      if (!recursive) {
        await this.mkdirOne(sftp, full, options?.mode);
        return undefined;
      }
      // The folders that are missing, outermost first
      const missing: string[] = [];
      for (let current = full; ; ) {
        const existing = await this.statOrUndefined(sftp, current);
        if (existing) {
          if (!isDirectory(existing)) {
            throw fsError(current === full ? 'EEXIST' : 'ENOTDIR', 'mkdir', full);
          }
          break;
        }
        missing.unshift(current);
        const parent = path.posix.dirname(current);
        if (parent === current) {
          break;
        }
        current = parent;
      }
      for (const folder of missing) {
        await this.mkdirOne(sftp, folder, options?.mode).catch(async (error) => {
          // Created meanwhile by a concurrent call
          if (
            error?.code !== 'EEXIST' ||
            !(await this.statOrUndefined(sftp, folder).then((st) => st && isDirectory(st)))
          ) {
            throw error;
          }
        });
      }
      return missing[0];
    });
  }

  private async mkdirOne(sftp: Sftp, folder: string, mode?: number) {
    try {
      await this.call(sftp, 'mkdir', folder, defined({ mode }));
    } catch (error) {
      if (!isSftpStatus(error)) {
        throw error;
      }
      // "failure" is what a server says for a path that exists already
      if (await this.statOrUndefined(sftp, folder)) {
        throw fsError('EEXIST', 'mkdir', folder);
      }
      throw await this.fsFailure(sftp, error, 'mkdir', folder);
    }
  }

  async readdir(folderPath: string, options?: BufferEncoding | StorageReaddirOptions): Promise<string[]> {
    const { recursive, encoding } = readdirOptions(options);
    const full = this.sftpPath(folderPath);

    return encodeNames(await this.withSftp((sftp) => this.list(sftp, full, recursive), true), encoding);
  }

  /** The names in `folder`, with `recursive` the relative paths of everything below it (folders included). */
  private async list(sftp: Sftp, folder: string, recursive?: boolean): Promise<string[]> {
    let entries: { filename: string; attrs: RemoteStats }[];
    try {
      entries = await this.call(sftp, 'readdir', folder);
    } catch (error) {
      if ((error as any)?.code === SFTP_NO_SUCH_FILE) {
        // opendir on a file is "no such file" too
        const existing = await this.statOrUndefined(sftp, folder);
        if (existing && !isDirectory(existing)) {
          throw fsError('ENOTDIR', 'scandir', folder);
        }
      }
      throw await this.fsFailure(sftp, error, 'scandir', folder);
    }
    const names: string[] = [];
    for (const { filename, attrs } of entries.filter((entry) => entry.filename !== '.' && entry.filename !== '..')) {
      names.push(filename);
      if (recursive && isDirectory(attrs)) {
        const children = await this.list(sftp, path.posix.join(folder, filename), true);
        names.push(...children.map((child) => `${filename}/${child}`));
      }
    }
    return names;
  }

  /** Unlike `fs.promises.rmdir`, `recursive` defaults to `true` (like `fs.promises.rm(path, { recursive: true })`). */
  async rmdir(folderPath: string, options?: StorageRmdirOptions): Promise<void> {
    const recursive = options?.recursive ?? true;
    if (recursive) {
      return this.rm(folderPath, { recursive: true });
    }
    const full = this.sftpPath(folderPath);

    return this.withSftp((sftp) => this.rmdirOne(sftp, full));
  }

  private async rmdirOne(sftp: Sftp, folder: string) {
    try {
      await this.call(sftp, 'rmdir', folder);
    } catch (error) {
      if (!isSftpStatus(error) || error.code === SFTP_PERMISSION_DENIED) {
        throw await this.fsFailure(sftp, error, 'rmdir', folder);
      }
      // Servers answer "failure" or "no such file" for a file, and "failure" for a folder with content
      const existing = await this.statOrUndefined(sftp, folder, true);
      if (!existing) {
        throw fsError('ENOENT', 'rmdir', folder);
      }
      if (!isDirectory(existing)) {
        throw fsError('ENOTDIR', 'rmdir', folder);
      }
      if (!(await this.isEmptyFolder(sftp, folder))) {
        throw fsError('ENOTEMPTY', 'rmdir', folder);
      }
      throw error;
    }
  }

  private async isEmptyFolder(sftp: Sftp, folder: string) {
    const entries = await this.call<{ filename: string }[]>(sftp, 'readdir', folder).catch(() => []);
    return entries.every((entry) => entry.filename === '.' || entry.filename === '..');
  }

  // --- files ---

  async stat(p: string): Promise<StorageStats> {
    const full = this.sftpPath(p);

    return this.withSftp(async (sftp) => {
      const stats = await this.statOrUndefined(sftp, full);
      if (!stats) {
        throw fsError('ENOENT', 'stat', full);
      }
      return buildStats({
        mode: stats.mode,
        size: stats.size,
        mtime: new Date(stats.mtime * 1000),
        atime: new Date(stats.atime * 1000),
        uid: stats.uid,
        gid: stats.gid,
      });
    }, true);
  }

  /**
   * Unlike `fs.existsSync`, errors other than "not found" (permissions, network, ...) are thrown, not turned into `false`.
   */
  async exists(p: string): Promise<boolean> {
    const full = this.sftpPath(p);

    return this.withSftp(async (sftp) => !!(await this.statOrUndefined(sftp, full)), true);
  }

  async readFile(
    filePath: string,
    options: BufferEncoding | (StorageReadFileOptions & { encoding: BufferEncoding }),
  ): Promise<string>;
  async readFile(filePath: string, options?: (StorageReadFileOptions & { encoding?: null }) | null): Promise<Buffer>;
  async readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer>;
  async readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer> {
    const { fsOptions } = readFileOptions(options);
    const full = this.sftpPath(filePath);

    const data = await this.withSftp(async (sftp) => {
      const chunks: Buffer[] = [];
      try {
        const source: Readable = sftp.createReadStream(full);
        // ssh2 may report an error twice (when opening, then when destroying): the second must not be unhandled
        source.on('error', () => undefined);
        for await (const chunk of source) {
          chunks.push(chunk);
        }
      } catch (error) {
        throw await this.readFailure(sftp, error, full);
      }
      return Buffer.concat(chunks);
    }, true);
    return fsOptions.encoding ? data.toString(fsOptions.encoding) : data;
  }

  /** What a failed read of `full` is in Node terms (a read stream reports "no such file" at open, "failure" at read). */
  private async readFailure(sftp: Sftp, error: unknown, full: string) {
    if (isSftpStatus(error) && !(error.code === SFTP_NO_SUCH_FILE || error.code === SFTP_PERMISSION_DENIED)) {
      const existing = await this.statOrUndefined(sftp, full).catch(() => undefined);
      if (existing && isDirectory(existing)) {
        return fsError('EISDIR', 'read', full);
      }
      return error;
    }
    return this.fsFailure(sftp, error, 'open', full);
  }

  async writeFile(
    filePath: string,
    data: string | Buffer | Uint8Array,
    options?: BufferEncoding | StorageWriteFileOptions,
  ): Promise<void> {
    const { encoding, mode, flag } = writeFileOptions(options);
    const full = this.sftpPath(filePath);
    const buffer = typeof data === 'string' ? Buffer.from(data, encoding) : data;

    return this.withSftp((sftp) => this.upload(sftp, full, Readable.from([buffer]), flag ?? 'w', mode));
  }

  /** Writes `source` to the remote file; resolves once the file is closed on the server. */
  private async upload(sftp: Sftp, full: string, source: Readable, flags: string, mode?: number) {
    const target: Writable = sftp.createWriteStream(full, defined({ flags, mode }));
    target.on('error', () => undefined);
    const closed = new Promise<void>((resolve) => target.once('close', () => resolve()));
    try {
      await pipeline(source, target);
    } catch (error) {
      throw await this.writeFailure(sftp, error, full, flags);
    }
    await closed;
  }

  private async writeFailure(sftp: Sftp, error: unknown, full: string, flags: string, dest?: string) {
    if (isSftpStatus(error) && error.code !== SFTP_NO_SUCH_FILE && error.code !== SFTP_PERMISSION_DENIED) {
      // "failure" is what a server says for opening a folder, or an existing file with the exclusive flag
      const existing = await this.statOrUndefined(sftp, full).catch(() => undefined);
      if (existing) {
        return fsError(isDirectory(existing) ? 'EISDIR' : 'EEXIST', 'open', full);
      }
      return error;
    }
    return this.fsFailure(sftp, error, 'open', full, dest);
  }

  async getSignedUrl(): Promise<string> {
    throw new Error('Signed URLs are not supported for sftp storage.');
  }

  async getSignedPutUrl(): Promise<string> {
    throw new Error('Signed URLs are not supported for sftp storage.');
  }

  async rm(filePath: string, options?: StorageRmOptions): Promise<void> {
    const full = this.sftpPath(filePath);

    return this.withSftp(async (sftp) => {
      const existing = await this.statOrUndefined(sftp, full, true);
      if (!existing) {
        if (options?.force) {
          return;
        }
        throw fsError('ENOENT', 'lstat', full);
      }
      if (!isDirectory(existing)) {
        return this.removeFile(sftp, full);
      }
      if (!options?.recursive) {
        throw rmDirectoryError(full);
      }
      return this.removeTree(sftp, full);
    });
  }

  private async removeFile(sftp: Sftp, full: string) {
    await this.call(sftp, 'unlink', full).catch(async (error) => {
      throw await this.fsFailure(sftp, error, 'unlink', full);
    });
  }

  /** Deletes the folder `folder` with everything below it. */
  private async removeTree(sftp: Sftp, folder: string): Promise<void> {
    const entries = await this.call<{ filename: string; attrs: RemoteStats }[]>(sftp, 'readdir', folder).catch(
      async (error) => {
        throw await this.fsFailure(sftp, error, 'scandir', folder);
      },
    );
    const children = entries.filter((entry) => entry.filename !== '.' && entry.filename !== '..');
    for (let i = 0; i < children.length; i += RM_CONCURRENCY) {
      await Promise.all(
        children.slice(i, i + RM_CONCURRENCY).map(({ filename, attrs }) => {
          const child = path.posix.join(folder, filename);
          return isDirectory(attrs) ? this.removeTree(sftp, child) : this.removeFile(sftp, child);
        }),
      );
    }
    await this.rmdirOne(sftp, folder);
  }

  /**
   * Downloads, then uploads (a server-side copy needs an extension that few servers have). `COPYFILE_EXCL` is
   * checked up front and passed to the server as the exclusive open flag.
   */
  async copyFile(src: string, dest: string, mode?: number): Promise<void> {
    const [from, to] = [this.sftpPath(src), this.sftpPath(dest)];
    const exclusive = ((mode ?? 0) & fs.constants.COPYFILE_EXCL) !== 0;

    return this.withSftp(async (sftp) => {
      const source = await this.statOrUndefined(sftp, from);
      if (!source) {
        throw fsError('ENOENT', 'copyfile', from, to);
      }
      if (isDirectory(source)) {
        throw fsError('EISDIR', 'copyfile', from, to);
      }
      const existing = await this.statOrUndefined(sftp, to);
      if (existing) {
        if (exclusive) {
          throw fsError('EEXIST', 'copyfile', from, to);
        }
        if (isDirectory(existing)) {
          throw fsError('EISDIR', 'copyfile', from, to);
        }
      }
      if (from === to) {
        return;
      }
      const reader: Readable = sftp.createReadStream(from);
      reader.on('error', () => undefined);
      try {
        await this.upload(sftp, to, reader, exclusive ? 'wx' : 'w');
      } catch (error: any) {
        reader.destroy();
        // The upload reports its failures as errors of `open`; this is a `copyfile`
        throw error?.syscall === 'open' ? fsError(error.code, 'copyfile', from, to) : error;
      }
    });
  }

  /**
   * SFTP v3 `rename` fails when the target exists. With the OpenSSH `posix-rename` extension a file replaces its
   * target atomically; without it the target is deleted first (not atomic: a failing rename then loses the target).
   */
  async rename(oldPath: string, newPath: string): Promise<void> {
    const [from, to] = [this.sftpPath(oldPath), this.sftpPath(newPath)];

    return this.withSftp(async (sftp) => {
      const source = await this.statOrUndefined(sftp, from, true);
      if (!source) {
        throw fsError('ENOENT', 'rename', from, to);
      }
      if (from === to) {
        return;
      }
      if (isDirectory(source) && to.startsWith(from + '/')) {
        throw fsError('EINVAL', 'rename', from, to);
      }
      const target = await this.statOrUndefined(sftp, to, true);
      if (target) {
        if (isDirectory(target) !== isDirectory(source)) {
          throw fsError(isDirectory(target) ? 'EISDIR' : 'ENOTDIR', 'rename', from, to);
        }
        if (isDirectory(target) && !(await this.isEmptyFolder(sftp, to))) {
          throw fsError('ENOTEMPTY', 'rename', from, to);
        }
      }
      try {
        if (!(await this.posixRename(sftp, from, to))) {
          if (target) {
            await (isDirectory(target) ? this.rmdirOne(sftp, to) : this.removeFile(sftp, to));
          }
          await this.call(sftp, 'rename', from, to);
        }
      } catch (error) {
        throw await this.fsFailure(sftp, error, 'rename', from, to);
      }
    });
  }

  /**
   * Renames with the OpenSSH `posix-rename` extension. False when the server does not have it: ssh2 then throws this
   * error at once, without sending anything (any other failure is the rename's own).
   */
  private async posixRename(sftp: Sftp, from: string, to: string): Promise<boolean> {
    try {
      await this.call(sftp, 'ext_openssh_rename', from, to);
      return true;
    } catch (error) {
      if ((error as Error)?.message === 'Server does not support this extended request') {
        return false;
      }
      throw error;
    }
  }

  // --- streams ---

  createReadStream(filePath: string, options?: StorageCreateReadStreamOptions): Readable {
    const full = this.sftpPath(filePath);
    const { start, end, highWaterMark, encoding } = splitBucket(options).fsOptions;

    // The connection is opened asynchronously: the caller gets a stream right away, fed once the file is open
    const output = new PassThrough({ highWaterMark });
    if (encoding) {
      output.setEncoding(encoding);
    }
    let source: Readable | undefined;
    output.once('close', () => source?.destroy());
    this.withSftp(async (sftp) => {
      if (output.destroyed) {
        return;
      }
      source = sftp.createReadStream(full, defined({ start, end, highWaterMark })) as Readable;
      source.on('error', async (error) => output.destroy((await this.readFailure(sftp, error, full)) as Error));
      source.pipe(output);
    }).catch((error) => output.destroy(error));
    return output;
  }

  /** `finish` is only emitted once the file is fully written and closed on the server. */
  createWriteStream(filePath: string, options?: StorageCreateWriteStreamOptions): Writable {
    const full = this.sftpPath(filePath);
    const flags = options?.flags ?? 'w';
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const driver = this;
    let target: Writable | undefined;
    let sftp: Sftp;
    let finished = false;

    const writable = new Writable({
      highWaterMark: options?.highWaterMark,
      defaultEncoding: options?.encoding,
      construct(callback) {
        driver.connection().then((connection) => {
          sftp = connection;
          target = sftp.createWriteStream(full, defined({ flags, mode: options?.mode }));
          target!.on('error', async (error) =>
            writable.destroy((await driver.writeFailure(sftp, error, full, flags)) as Error),
          );
          callback();
        }, callback);
      },
      write(chunk, encoding, callback) {
        target!.write(chunk, encoding, callback);
      },
      final(callback) {
        target!.once('close', () => {
          finished = true;
          callback();
        });
        target!.end();
      },
      destroy(error, callback) {
        if (!target) {
          return callback(error);
        }
        target.destroy();
        if (finished || flags.startsWith('a')) {
          return callback(error);
        }
        // Like the S3 backend, an aborted upload leaves no partial file behind
        driver.call(sftp, 'unlink', full).then(
          () => callback(error),
          () => callback(error),
        );
      },
    });
    return writable;
  }
}
