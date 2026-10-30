import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MODULE_OPTIONS_TOKEN } from './storage.module-definition';
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
} from './interfaces';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CompletedPart,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  HeadObjectCommandOutput,
  ListObjectsV2Command,
  ListObjectsV2CommandInput,
  PutObjectCommand,
  S3Client,
  UploadPartCopyCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';
import { PassThrough, Readable, Writable } from 'stream';
import * as mime from 'mime-types';

const FS_ERRORS = {
  ENOENT: [-2, 'no such file or directory'],
  EEXIST: [-17, 'file already exists'],
  ENOTDIR: [-20, 'not a directory'],
  EISDIR: [-21, 'illegal operation on a directory'],
  EINVAL: [-22, 'invalid argument'],
  ENOTEMPTY: [-39, 'directory not empty'],
} as const;

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private s3Client: S3Client | undefined;

  /** Filesystem code path: the real disk (`fileSystem`) or an in-memory volume (`memory`) */
  private readonly fsBacked: boolean = false;
  private readonly isMemory: boolean = false;
  /** Node's `fs` for `fileSystem`; the `fs` of a private memfs volume for `memory` */
  private readonly fs: typeof fs = fs;
  private readonly prefix: string;
  private readonly endpoint?: string;
  private readonly endpointCDN?: string;
  private readonly region?: string;
  private readonly forcePathStyle?: boolean;
  private readonly bucket?: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;

  // Largest object copied with a single CopyObject (S3 limit: 5 GiB), and the part size used above that
  private readonly copyThreshold = 5 * 1024 ** 3;
  private readonly copyPartSize = 512 * 1024 ** 2;
  private readonly copyConcurrency = 8;

  constructor(@Inject(MODULE_OPTIONS_TOKEN) private options: StorageModuleOptions) {
    switch (options.type) {
      case 's3':
        this.endpoint = options.endpoint;
        this.endpointCDN = options.endpointCDN;
        this.region = options.region;
        this.forcePathStyle = options.forcePathStyle;
        this.bucket = options.bucket;
        this.accessKeyId = options.accessKeyId;
        this.secretAccessKey = options.secretAccessKey;
        break;
      case 'memory': {
        this.fsBacked = true;
        this.isMemory = true;
        // memfs is an optional peer dependency: only loaded when the memory backend is used
        let memfs: typeof import('memfs');
        try {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          memfs = require('memfs');
        } catch (error: any) {
          if (error?.code !== 'MODULE_NOT_FOUND') throw error;
          throw Object.assign(
            new Error(`type 'memory' requires the optional peer dependency "memfs": npm install memfs`),
            { cause: error },
          );
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
        return;
      }
      case 'fileSystem':
      default:
        this.fsBacked = true;
        break;
    }

    this.prefix = options.prefix ?? '';
  }

  get s3client() {
    return this.s3Client;
  }

  async onModuleInit() {
    if (!this.fsBacked) {
      // Without explicit options the SDK falls back to its defaults (AWS_REGION, IAM roles, ~/.aws, ...)
      this.s3Client = new S3Client({
        endpoint: this.endpoint,
        region: this.region,
        forcePathStyle: this.forcePathStyle ?? undefined,
        requestChecksumCalculation: this.options.requestChecksumCalculation,
        responseChecksumValidation: this.options.responseChecksumValidation,
        credentials:
          this.accessKeyId && this.secretAccessKey
            ? { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey }
            : undefined,
      });
    }
  }

  async onModuleDestroy() {
    return this.s3Client?.destroy();
  }

  private fsPath(p: string) {
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

  private s3Bucket(bucket?: string): string {
    const resolved = bucket ?? this.bucket;
    if (!resolved) {
      throw new Error('No bucket configured: pass a bucket or set the bucket option');
    }
    return resolved;
  }

  /** Drops `undefined` values, so that fs applies its own defaults instead of receiving an explicit `undefined`. */
  private defined<T extends object>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
  }

  /** Backslashes become slashes and leading slashes are dropped: S3 keys are relative to the bucket (or prefix) root. */
  private stripLeadingSlashes(key: string) {
    return key.replace(/\\+/g, '/').replace(/^\/+/, '');
  }

  /**
   * Key relative to the bucket, with the prefix applied. Leading slashes are stripped before the escape check, so
   * `'/../x'` is judged like `'../x'` (path.normalize would otherwise clamp it to `'/x'` and hide the escape).
   */
  private withPrefix(key: string) {
    const relative = this.stripLeadingSlashes(key);
    const prefix = this.prefix.replace(/^[\\/]+|[\\/]+$/g, '');
    if (!prefix) {
      const normalized = path.normalize(relative);
      if (normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`Path "${key}" escapes the bucket root`);
      }
      return relative;
    }
    const joined = path.join(prefix, relative);
    const root = path.normalize(prefix).replace(/\\+/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
    const normalized = joined.replace(/\\+/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
    if (normalized !== root && !normalized.startsWith(`${root}/`)) {
      throw new Error(`Path "${key}" escapes the storage prefix "${prefix}"`);
    }
    return joined;
  }

  /**
   * Folder key with a trailing slash. Without a prefix the bucket root ('', '/', '.', 'a/..') is the empty key, which
   * addresses the whole bucket; with a prefix the root is `<prefix>/`.
   */
  private normalizeDirKey(key: string) {
    const dirKey = `${path.normalize(this.withPrefix(key))}/`.replace(/\\+/g, '/').replace(/\/+/g, '/');
    return dirKey === './' ? '' : dirKey;
  }

  private normalizeKey(key: string) {
    const normalized = path
      .normalize(this.withPrefix(key))
      .replace(/\\+/g, '/')
      .replace(/\/+/g, '/')
      .replace(/\/+$/, '');
    return normalized === '.' ? '' : normalized;
  }

  /** Unlike `fs.promises.mkdir`, `recursive` defaults to `true`. */
  async mkdir(folderPath: string, options?: StorageMkdirOptions): Promise<string | undefined> {
    const recursive = options?.recursive ?? true;

    if (this.fsBacked) {
      if (this.isMemory) {
        return this.memMkdir(this.fsPath(folderPath), recursive, options?.mode);
      }
      return this.fs.promises.mkdir(this.fsPath(folderPath), this.defined({ recursive, mode: options?.mode }));
    }

    const bucket = this.s3Bucket(options?.bucket);

    const entry = await this.s3Entry(bucket, folderPath);
    if (entry && 'file' in entry) {
      throw this.fsError('EEXIST', 'mkdir', folderPath);
    }
    if (entry) {
      if (recursive) {
        return undefined;
      }
      throw this.fsError('EEXIST', 'mkdir', folderPath);
    }

    if (!recursive) {
      const parent = await this.s3Entry(bucket, path.dirname(folderPath));
      if (!parent) {
        throw this.fsError('ENOENT', 'mkdir', folderPath);
      }
      if ('file' in parent) {
        throw this.fsError('ENOTDIR', 'mkdir', folderPath);
      }
    }

    await this.s3Client!.send(
      new PutObjectCommand({ Bucket: bucket, Key: this.normalizeDirKey(folderPath), Body: '', ContentLength: 0 }),
    );
    return undefined;
  }

  async readdir(folderPath: string, options?: BufferEncoding | StorageReaddirOptions): Promise<string[]> {
    const opts: StorageReaddirOptions = typeof options === 'string' ? { encoding: options } : options ?? {};

    if (this.fsBacked) {
      if (this.isMemory && opts.recursive) {
        return this.memReaddirRecursive(this.fsPath(folderPath), opts.encoding);
      }
      if (opts.recursive !== undefined || opts.encoding !== undefined) {
        return this.fs.promises.readdir(
          this.fsPath(folderPath),
          this.defined({ recursive: opts.recursive, encoding: opts.encoding }) as { encoding: BufferEncoding },
        );
      }
      return this.fs.promises.readdir(this.fsPath(folderPath));
    }

    const bucket = this.s3Bucket(opts.bucket);

    const prefix = this.normalizeDirKey(folderPath);
    const entry = await this.s3Entry(bucket, folderPath);
    if (!entry) {
      throw this.fsError('ENOENT', 'scandir', folderPath);
    }
    if ('file' in entry) {
      throw this.fsError('ENOTDIR', 'scandir', folderPath);
    }

    const list = new Set<string>();
    const toName = (key?: string) => key?.slice(prefix.length).replace(/\/+$/, '') ?? '';
    // Names are UTF-8 strings; another encoding re-encodes them like fs does
    const encode = (name: string) =>
      opts.encoding && !/^utf-?8$/i.test(opts.encoding) ? Buffer.from(name).toString(opts.encoding) : name;

    if (opts.recursive) {
      for await (const output of this.listObjects({ Bucket: bucket, Prefix: prefix })) {
        for (const content of output.Contents ?? []) {
          const name = toName(content.Key);
          if (!name.length) {
            continue;
          }
          // Folders are implicit: add every ancestor of the entry as well, like Node's recursive readdir
          const parts = name.split('/');
          for (let i = 1; i <= parts.length; i++) {
            list.add(parts.slice(0, i).join('/'));
          }
        }
      }

      return [...list].sort().map(encode);
    }

    for await (const output of this.listObjects({ Bucket: bucket, Delimiter: '/', Prefix: prefix })) {
      for (const key of [
        ...(output.Contents ?? []).map((content) => toName(content.Key)),
        ...(output.CommonPrefixes ?? []).map((commonPrefix) => toName(commonPrefix.Prefix)),
      ]) {
        if (key.length) {
          list.add(key);
        }
      }
    }

    return [...list].sort().map(encode);
  }

  /** Unlike `fs.promises.rmdir`, `recursive` defaults to `true` (like `fs.promises.rm(path, { recursive: true })`). */
  async rmdir(folderPath: string, options?: StorageRmdirOptions): Promise<void> {
    const recursive = options?.recursive ?? true;

    if (this.fsBacked) {
      if (recursive) {
        return this.fs.promises.rm(this.fsPath(folderPath), { recursive: true });
      }
      return this.fs.promises.rmdir(this.fsPath(folderPath));
    }

    const bucket = this.s3Bucket(options?.bucket);

    const entry = await this.s3Entry(bucket, folderPath);
    if (!entry) {
      throw this.fsError('ENOENT', recursive ? 'lstat' : 'rmdir', folderPath);
    }

    if ('file' in entry) {
      if (!recursive) {
        throw this.fsError('ENOTDIR', 'rmdir', folderPath);
      }
      // fs.rm(path, { recursive: true }) removes a file as well
      await this.s3Client!.send(new DeleteObjectCommand({ Bucket: bucket, Key: this.normalizeKey(folderPath) }));
      return;
    }

    if (recursive) {
      return this.deleteTree(bucket, this.normalizeDirKey(folderPath));
    }

    const dirKey = this.normalizeDirKey(folderPath);
    if (!(await this.isEmptyDir(bucket, dirKey))) {
      throw this.fsError('ENOTEMPTY', 'rmdir', folderPath);
    }
    // The bucket root has no marker object
    if (dirKey) {
      await this.s3Client!.send(new DeleteObjectCommand({ Bucket: bucket, Key: dirKey }));
    }
  }

  /** Deletes every object below the folder key, marker included. Nothing to delete is not an error. */
  private async deleteTree(bucket: string, dirKey: string): Promise<void> {
    // A page holds at most 1000 keys, which is also the DeleteObjects limit
    for await (const output of this.listObjects({ Bucket: bucket, Prefix: dirKey })) {
      const keys = (output.Contents ?? []).flatMap((content) => (content.Key ? [content.Key] : []));
      if (!keys.length) {
        continue;
      }

      const result = await this.s3Client!.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: keys.map((key) => ({ Key: key })), Quiet: true },
        }),
      );

      if (result.Errors?.length) {
        const [error] = result.Errors;
        throw new Error(
          `Failed to delete ${result.Errors.length} object(s), e.g. "${error.Key}": ${error.Code} ${error.Message}`,
        );
      }
    }
  }

  /** A folder that only consists of its marker (or of nothing) is empty. */
  private async isEmptyDir(bucket: string, dirKey: string): Promise<boolean> {
    for await (const output of this.listObjects({ Bucket: bucket, Prefix: dirKey, MaxKeys: 2 })) {
      return !(output.Contents ?? []).some((content) => content.Key !== dirKey);
    }
    return true;
  }

  private async *listObjects(input: ListObjectsV2CommandInput) {
    let ContinuationToken: string | undefined;
    do {
      const output = await this.s3Client!.send(new ListObjectsV2Command({ ...input, ContinuationToken }));
      yield output;
      ContinuationToken = output.IsTruncated ? output.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }

  private fsError(code: keyof typeof FS_ERRORS, syscall: string, p?: string, dest?: string) {
    const [errno, description] = FS_ERRORS[code];
    const error: NodeJS.ErrnoException = new Error(
      `${code}: ${description}, ${syscall}${p === undefined ? '' : ` '${p}'`}${
        dest === undefined ? '' : ` -> '${dest}'`
      }`,
    );
    error.code = code;
    error.errno = errno;
    error.syscall = syscall;
    if (p !== undefined) {
      error.path = p;
    }
    if (dest !== undefined) {
      (error as any).dest = dest;
    }
    return error;
  }

  // ---- memory backend shims -------------------------------------------------------------------------------------
  // memfs does not behave exactly like Node's fs in a few places. These helpers are only used when `isMemory`, and
  // make the memory backend match what Node's fs does (verified against the real fs in the parity tests).

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
    const options = this.defined({ recursive, mode });
    if (!recursive) {
      return this.fs.promises.mkdir(full, options).catch((e) => {
        throw this.withErrorPath(e, full);
      });
    }
    const existing = this.memStat(full);
    if (existing && !existing.isDirectory()) {
      throw this.fsError('EEXIST', 'mkdir', full);
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
    if (!encoding || encoding === 'utf8' || encoding === 'utf-8') return names;
    return names.map((name) =>
      encoding === 'buffer' ? Buffer.from(name) : Buffer.from(name).toString(encoding as BufferEncoding),
    );
  }

  /** memfs does not check these rename cases and silently replaces or moves into itself. */
  private memRenameChecks(src: string, dest: string) {
    const source = this.memStat(src);
    if (!source || path.resolve(src) === path.resolve(dest)) return;
    if (source.isDirectory() && path.resolve(dest).startsWith(path.resolve(src) + path.sep)) {
      throw this.fsError('EINVAL', 'rename', src, dest);
    }
    const target = this.memStat(dest);
    if (!target) return;
    if (source.isDirectory() && !target.isDirectory()) throw this.fsError('ENOTDIR', 'rename', src, dest);
    if (!source.isDirectory() && target.isDirectory()) throw this.fsError('EISDIR', 'rename', src, dest);
    if (source.isDirectory() && this.fs.readdirSync(dest).length > 0) {
      throw this.fsError('ENOTEMPTY', 'rename', src, dest);
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
      process.nextTick(() => failing.destroy(this.fsError('EISDIR', 'read')));
      return failing;
    }
    const fixed = typeof end === 'number' && start === undefined ? { ...options, start: 0 } : options;
    return this.fs.createReadStream(full, fixed) as Readable;
  }

  private isNotFound(e: any) {
    return e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound';
  }

  /** GetObject on a missing key (NoSuchKey), without mistaking a missing bucket for it */
  private isMissingKey(e: any) {
    return e?.name === 'NoSuchKey' || (this.isNotFound(e) && e?.name !== 'NoSuchBucket');
  }

  /** What reading `p` fails with after GetObject found no such key: EISDIR for a folder (like Node), else ENOENT. */
  private async missingFileError(bucket: string, p: string, withPath = true) {
    const entry = await this.s3Entry(bucket, p);
    if (entry && 'dir' in entry) {
      return this.fsError('EISDIR', 'read', withPath ? p : undefined);
    }
    return this.fsError('ENOENT', 'open', p);
  }

  /** Object key for writing; the bucket root and the empty key are folders, never objects. */
  private writeKey(p: string, syscall: string, dest?: string) {
    const key = this.normalizeKey(dest ?? p);
    if (!key || this.normalizeDirKey(dest ?? p) === this.normalizeDirKey('')) {
      throw this.fsError('EISDIR', syscall, p, dest);
    }
    return key;
  }

  private async headObject(bucket: string | undefined, key: string): Promise<HeadObjectCommandOutput | undefined> {
    try {
      return await this.s3Client!.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    } catch (e: any) {
      if (this.isNotFound(e)) {
        return undefined;
      }
      throw e;
    }
  }

  /** Resolves what lives at `p`: a file (object), a folder (marker and/or objects under the prefix) or nothing. */
  private async s3Entry(
    bucket: string | undefined,
    p: string,
  ): Promise<{ file: HeadObjectCommandOutput } | { dir: { mtime?: Date } } | undefined> {
    const dirKey = this.normalizeDirKey(p);
    if (dirKey === this.normalizeDirKey('')) {
      // The root always exists, but a missing bucket must not look like an empty one
      await this.listObjects({ Bucket: bucket, Prefix: dirKey, MaxKeys: 1 }).next();
      return { dir: {} };
    }

    // The bucket root normalizes to the empty key, which is no object (a HEAD on it would hit the bucket itself)
    const fileKey = this.normalizeKey(p);
    const file = fileKey ? await this.headObject(bucket, fileKey) : undefined;
    if (file) {
      return { file };
    }

    const marker = await this.headObject(bucket, dirKey);
    if (marker) {
      return { dir: { mtime: marker.LastModified } };
    }

    for await (const output of this.listObjects({ Bucket: bucket, Prefix: dirKey, MaxKeys: 1 })) {
      return output.Contents?.length ? { dir: {} } : undefined;
    }
    return undefined;
  }

  private buildStats(isDirectory: boolean, size: number, mtime: Date, extra?: Partial<StorageStats>): StorageStats {
    const ms = mtime.getTime();
    return {
      isFile: () => !isDirectory,
      isDirectory: () => isDirectory,
      isSymbolicLink: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      dev: 0,
      ino: 0,
      mode: (isDirectory ? fs.constants.S_IFDIR | 0o755 : fs.constants.S_IFREG | 0o644) as number,
      nlink: 1,
      uid: 0,
      gid: 0,
      rdev: 0,
      size,
      blksize: 4096,
      blocks: Math.ceil(size / 512),
      atimeMs: ms,
      mtimeMs: ms,
      ctimeMs: ms,
      birthtimeMs: ms,
      atime: mtime,
      mtime,
      ctime: mtime,
      birthtime: mtime,
      ...extra,
    };
  }

  async stat(p: string, options?: { bucket?: string }): Promise<StorageStats> {
    if (this.fsBacked) {
      return this.fs.promises.stat(this.fsPath(p));
    }

    const bucket = this.s3Bucket(options?.bucket);

    const entry = await this.s3Entry(bucket, p);
    if (!entry) {
      throw this.fsError('ENOENT', 'stat', p);
    }

    if ('file' in entry) {
      const { ContentLength, LastModified, ContentType, ETag } = entry.file;
      return this.buildStats(false, ContentLength ?? 0, LastModified ?? new Date(0), {
        contentType: ContentType,
        etag: ETag?.replace(/^"|"$/g, ''),
      });
    }
    return this.buildStats(true, 0, entry.dir.mtime ?? new Date(0));
  }

  /**
   * Unlike `fs.existsSync`, errors other than "not found" (403, network, ...) are thrown, not turned into `false`.
   */
  async exists(p: string, bucket?: string): Promise<boolean> {
    if (this.fsBacked) {
      return this.fs.existsSync(this.fsPath(p));
    }

    return !!(await this.s3Entry(this.s3Bucket(bucket), p));
  }

  async readFile(
    filePath: string,
    options: BufferEncoding | (StorageReadFileOptions & { encoding: BufferEncoding }),
  ): Promise<string>;
  async readFile(filePath: string, options?: (StorageReadFileOptions & { encoding?: null }) | null): Promise<Buffer>;
  async readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer>;
  async readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer> {
    const { bucket: optionsBucket, ...fsOptions }: StorageReadFileOptions =
      typeof options === 'string' ? { encoding: options } : options ?? {};

    if (this.fsBacked) {
      const full = this.fsPath(filePath);
      return this.fs.promises.readFile(full, this.defined(fsOptions) as { encoding: BufferEncoding }).catch((e) => {
        // memfs leaves the path out of the EISDIR error (memory shim)
        if (this.isMemory && e?.code === 'EISDIR' && !e.path) throw this.fsError('EISDIR', 'read', full);
        throw e;
      });
    }

    const bucket = this.s3Bucket(optionsBucket);
    const key = this.normalizeKey(filePath);

    const streamToBuffer: (_stream: stream) => Promise<Buffer> = (_stream) => {
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        _stream.on('data', (chunk) => chunks.push(chunk));
        _stream.on('error', reject);
        _stream.on('end', () => resolve(Buffer.concat(chunks)));
      });
    };

    if (!key) {
      // The bucket root is no object key: nothing to GET
      throw await this.missingFileError(bucket, filePath);
    }

    let buffer: Buffer;
    if (this.endpoint && this.endpointCDN) {
      const result = await getSignedUrl(
        this.s3Client as any,
        new GetObjectCommand({ Bucket: bucket, Key: key }) as any,
        {
          expiresIn: 60,
        },
      );
      const response = await fetch(
        result.replace(this.endpoint.replace(/(^\w+:|^)\/\//, ''), this.endpointCDN.replace(/(^\w+:|^)\/\//, '')),
      );
      if (response.status === 404) {
        throw await this.missingFileError(bucket, filePath);
      }
      if (!response.ok) {
        throw new Error(`Failed to read "${filePath}" from CDN: ${response.status} ${response.statusText}`);
      }
      buffer = Buffer.from(await response.arrayBuffer());
    } else {
      try {
        const data = await this.s3Client!.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        buffer = await streamToBuffer(data.Body as Readable);
      } catch (e: any) {
        throw this.isMissingKey(e) ? await this.missingFileError(bucket, filePath) : e;
      }
    }

    return fsOptions.encoding ? buffer.toString(fsOptions.encoding) : buffer;
  }

  async writeFile(
    filePath: string,
    data: string | Buffer | Uint8Array,
    options?: BufferEncoding | StorageWriteFileOptions,
  ): Promise<void> {
    const {
      encoding,
      mode,
      flag,
      bucket: optionsBucket,
      contentType,
    }: StorageWriteFileOptions = typeof options === 'string' ? { encoding: options } : options ?? {};

    if (this.fsBacked) {
      return this.fs.promises.writeFile(this.fsPath(filePath), data, this.defined({ encoding, mode, flag }));
    }

    const bucket = this.s3Bucket(optionsBucket);
    const key = this.writeKey(filePath, 'open');

    await this.s3Client!.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: typeof data === 'string' ? Buffer.from(data, encoding) : data,
        ContentType: contentType || mime.lookup(filePath) || undefined,
      }),
    );
  }

  public async getSignedUrl(
    filePath: string,
    opts?: { bucket?: string; expiresIn?: number; responseContentDisposition?: string; responseContentType?: string },
  ): Promise<string> {
    if (this.fsBacked) {
      throw new Error(`Signed URLs are not supported for ${this.isMemory ? 'memory' : 'filesystem'} storage.`);
    }

    const bucket = this.s3Bucket(opts?.bucket);
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: this.normalizeKey(filePath),
      ResponseContentDisposition: opts?.responseContentDisposition,
      ResponseContentType: opts?.responseContentType,
    });

    const url = await getSignedUrl(this.s3Client!, command, { expiresIn: opts?.expiresIn ?? 60 });

    if (this.endpointCDN && this.endpoint) {
      return url.replace(this.endpoint.replace(/(^\w+:|^)\/\//, ''), this.endpointCDN.replace(/(^\w+:|^)\/\//, ''));
    }
    return url;
  }

  public async getSignedPutUrl(
    filePath: string,
    opts?: { bucket?: string; expiresIn?: number; contentType?: string },
  ): Promise<string> {
    if (this.fsBacked) {
      throw new Error(`Signed URLs are not supported for ${this.isMemory ? 'memory' : 'filesystem'} storage.`);
    }

    const bucket = this.s3Bucket(opts?.bucket);
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: this.normalizeKey(filePath),
      ContentType: opts?.contentType,
    });

    const url = await getSignedUrl(this.s3Client!, command, { expiresIn: opts?.expiresIn ?? 60 });

    if (this.endpointCDN && this.endpoint) {
      return url.replace(this.endpoint.replace(/(^\w+:|^)\/\//, ''), this.endpointCDN.replace(/(^\w+:|^)\/\//, ''));
    }
    return url;
  }

  async rm(filePath: string, options?: StorageRmOptions): Promise<void> {
    if (this.fsBacked) {
      return this.fs.promises.rm(
        this.fsPath(filePath),
        this.defined({ force: options?.force, recursive: options?.recursive }),
      );
    }

    const bucket = this.s3Bucket(options?.bucket);

    const entry = await this.s3Entry(bucket, filePath);
    if (!entry) {
      if (options?.force) {
        return;
      }
      throw this.fsError('ENOENT', 'lstat', filePath);
    }

    if ('dir' in entry) {
      if (!options?.recursive) {
        // What Node throws for fs.rm on a directory
        const error: NodeJS.ErrnoException = new Error(
          `Path is a directory: rm returned EISDIR (is a directory) ${filePath}`,
        );
        error.code = 'ERR_FS_EISDIR';
        error.errno = 21;
        error.syscall = 'rm';
        error.path = filePath;
        throw error;
      }
      return this.deleteTree(bucket, this.normalizeDirKey(filePath));
    }

    await this.s3Client!.send(new DeleteObjectCommand({ Bucket: bucket, Key: this.normalizeKey(filePath) }));
  }

  async copyFile(src: string, dest: string, mode?: number, bucket?: string): Promise<void> {
    if (this.fsBacked) {
      return this.fs.promises.copyFile(this.fsPath(src), this.fsPath(dest), mode);
    }

    bucket = this.s3Bucket(bucket);

    const entry = await this.s3Entry(bucket, src);
    if (!entry) {
      throw this.fsError('ENOENT', 'copyfile', src, dest);
    }
    if ('dir' in entry) {
      throw this.fsError('EISDIR', 'copyfile', src, dest);
    }

    const srcKey = this.normalizeKey(src);
    const destKey = this.writeKey(src, 'copyfile', dest);
    const exclusive = !!((mode ?? 0) & fs.constants.COPYFILE_EXCL);
    if (srcKey === destKey) {
      if (exclusive) {
        throw this.fsError('EEXIST', 'copyfile', src, dest);
      }
      return;
    }

    const target = await this.s3Entry(bucket, dest);
    if (target && 'dir' in target) {
      throw this.fsError('EISDIR', 'copyfile', src, dest);
    }

    // Not atomic on its own. Some S3-compatible servers ignore IfNoneMatch on copies (or mishandle a failed
    // conditional multipart completion), so check up front as well; IfNoneMatch still guards against races on AWS.
    if (exclusive && (await this.headObject(bucket, destKey))) {
      throw this.fsError('EEXIST', 'copyfile', src, dest);
    }

    try {
      await this.copyObject(srcKey, destKey, entry.file.ContentLength ?? 0, bucket, { exclusive });
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 412) {
        throw this.fsError('EEXIST', 'copyfile', src, dest);
      }
      throw e;
    }
  }

  async rename(oldPath: string, newPath: string, bucket?: string): Promise<void> {
    if (this.fsBacked) {
      const [src, dest] = [this.fsPath(oldPath), this.fsPath(newPath)];
      if (this.isMemory) this.memRenameChecks(src, dest);
      return this.fs.promises.rename(src, dest);
    }

    bucket = this.s3Bucket(bucket);

    const entry = await this.s3Entry(bucket, oldPath);
    if (!entry) {
      throw this.fsError('ENOENT', 'rename', oldPath, newPath);
    }

    if ('file' in entry) {
      const srcKey = this.normalizeKey(oldPath);
      const destKey = this.writeKey(oldPath, 'rename', newPath);
      if (srcKey === destKey) {
        return;
      }

      const target = await this.s3Entry(bucket, newPath);
      if (target && 'dir' in target) {
        throw this.fsError('EISDIR', 'rename', oldPath, newPath);
      }

      await this.copyObject(srcKey, destKey, entry.file.ContentLength ?? 0, bucket);
      await this.s3Client!.send(new DeleteObjectCommand({ Bucket: bucket, Key: srcKey }));
      return;
    }

    const srcDir = this.normalizeDirKey(oldPath);
    const destDir = this.normalizeDirKey(newPath);
    if (srcDir === destDir) {
      return;
    }
    if (destDir.startsWith(srcDir)) {
      throw this.fsError('EINVAL', 'rename', oldPath, newPath);
    }

    const target = await this.s3Entry(bucket, newPath);
    if (target && 'file' in target) {
      throw this.fsError('ENOTDIR', 'rename', oldPath, newPath);
    }
    if (target) {
      if (!(await this.isEmptyDir(bucket, destDir))) {
        throw this.fsError('ENOTEMPTY', 'rename', oldPath, newPath);
      }
    }

    // Copy everything first, delete the originals only once every copy has succeeded
    const copied: string[] = [];
    for await (const output of this.listObjects({ Bucket: bucket, Prefix: srcDir })) {
      const objects = (output.Contents ?? []).flatMap((content) =>
        content.Key ? [{ key: content.Key, size: content.Size ?? 0 }] : [],
      );

      let next = 0;
      let failed = false;
      const worker = async () => {
        while (!failed && next < objects.length) {
          const { key, size } = objects[next++];
          try {
            await this.copyObject(key, destDir + key.slice(srcDir.length), size, bucket);
          } catch (e) {
            failed = true;
            throw e;
          }
          copied.push(key);
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.copyConcurrency, objects.length) }, worker));
    }

    for (let i = 0; i < copied.length; i += 1000) {
      const result = await this.s3Client!.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: copied.slice(i, i + 1000).map((key) => ({ Key: key })), Quiet: true },
        }),
      );

      if (result.Errors?.length) {
        const [error] = result.Errors;
        throw new Error(
          `Failed to delete ${result.Errors.length} object(s), e.g. "${error.Key}": ${error.Code} ${error.Message}`,
        );
      }
    }
  }

  private async copyObject(
    srcKey: string,
    destKey: string,
    size: number,
    bucket: string | undefined,
    opts?: { exclusive?: boolean },
  ): Promise<void> {
    const CopySource = `${bucket}/${srcKey.split('/').map(encodeURIComponent).join('/')}`;
    // Fails with 412 when the destination exists. Without IfNoneMatch this check would not be atomic.
    const IfNoneMatch = opts?.exclusive ? '*' : undefined;

    if (size <= this.copyThreshold) {
      // ContentType and metadata are copied by default
      await this.s3Client!.send(new CopyObjectCommand({ Bucket: bucket, Key: destKey, CopySource, IfNoneMatch }));
      return;
    }

    const head = await this.s3Client!.send(new HeadObjectCommand({ Bucket: bucket, Key: srcKey }));
    const { UploadId } = await this.s3Client!.send(
      new CreateMultipartUploadCommand({
        Bucket: bucket,
        Key: destKey,
        ContentType: head.ContentType,
        ContentDisposition: head.ContentDisposition,
        CacheControl: head.CacheControl,
        ContentEncoding: head.ContentEncoding,
        Metadata: head.Metadata,
      }),
    );

    try {
      // S3 allows at most 10000 parts
      const partSize = Math.max(this.copyPartSize, Math.ceil(size / 10000));
      const parts: CompletedPart[] = [];
      for (let start = 0, partNumber = 1; start < size; start += partSize, partNumber++) {
        const end = Math.min(start + partSize, size) - 1;
        const part = await this.s3Client!.send(
          new UploadPartCopyCommand({
            Bucket: bucket,
            Key: destKey,
            UploadId,
            PartNumber: partNumber,
            CopySource,
            CopySourceRange: `bytes=${start}-${end}`,
          }),
        );
        parts.push({ PartNumber: partNumber, ETag: part.CopyPartResult?.ETag });
      }

      await this.s3Client!.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: destKey,
          UploadId,
          MultipartUpload: { Parts: parts },
          IfNoneMatch,
        }),
      );
    } catch (e) {
      await this.s3Client!.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: destKey, UploadId })).catch(
        () => undefined,
      );
      throw e;
    }
  }

  createReadStream(filePath: string, options?: StorageCreateReadStreamOptions): Readable {
    const { bucket: optionsBucket, ...fsOptions } = options ?? {};

    if (this.fsBacked) {
      if (this.isMemory) {
        return this.memReadStream(this.fsPath(filePath), fsOptions);
      }
      return this.fs.createReadStream(this.fsPath(filePath), fsOptions);
    }

    const bucket = this.s3Bucket(optionsBucket);
    const key = this.normalizeKey(filePath);

    const Range =
      typeof options?.start === 'number' || typeof options?.end === 'number'
        ? `bytes=${options?.start ?? 0}-${typeof options?.end === 'number' ? options.end : ''}`
        : undefined;

    const pass = new PassThrough({ highWaterMark: options?.highWaterMark });
    if (options?.encoding) {
      pass.setEncoding(options.encoding);
    }

    // The bucket root is no object key: nothing to GET
    const request = key
      ? this.s3Client!.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range }))
      : Promise.reject({ name: 'NoSuchKey' });
    request
      .then(({ Body }) => (Body as Readable).pipe(pass))
      .catch(async (err) => {
        try {
          // Node's stream error for a folder carries no path
          pass.destroy(this.isMissingKey(err) ? await this.missingFileError(bucket, filePath, false) : err);
        } catch (lookupError) {
          pass.destroy(lookupError as Error);
        }
      });

    return pass;
  }

  createWriteStream(filePath: string, options?: StorageCreateWriteStreamOptions): Writable {
    if (this.fsBacked) {
      return this.fs.createWriteStream(
        this.fsPath(filePath),
        this.defined({
          highWaterMark: options?.highWaterMark,
          encoding: options?.encoding,
          flags: options?.flags,
          mode: options?.mode,
        }),
      );
    }

    const bucket = this.s3Bucket(options?.bucket);
    const key = this.writeKey(filePath, 'open');

    const pass = new PassThrough({ highWaterMark: options?.highWaterMark });
    const upload = new Upload({
      client: this.s3Client!,
      params: {
        Bucket: bucket,
        Key: key,
        Body: pass,
        ContentType: options?.contentType || mime.lookup(filePath) || undefined,
      },
      queueSize: options?.queueSize ?? 4,
      partSize: Math.max(options?.partSize ?? 5 * 1024 * 1024, 5 * 1024 * 1024),
      leavePartsOnError: false,
    });

    let completed = false;
    const done = upload.done().then(() => {
      completed = true;
    });

    // 'finish' is only emitted once the upload has completed, like fs.WriteStream after the file is flushed
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
      destroy(err, callback) {
        if (!completed) {
          upload.abort().catch(() => undefined);
        }
        pass.destroy(err ?? undefined);
        callback(err);
      },
    });

    done.catch((err) => writable.destroy(err));

    return writable;
  }
}
