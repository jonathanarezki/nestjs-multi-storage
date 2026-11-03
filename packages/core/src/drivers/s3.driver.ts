import type {
  CompletedPart,
  HeadObjectCommandOutput,
  ListObjectsV2CommandInput,
  ObjectStorageClass,
  S3Client,
  StorageClass,
} from '@aws-sdk/client-s3';
import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';
import { PassThrough, Readable, Writable } from 'stream';
import * as mime from 'mime-types';
import { StorageCreateWriteStreamOptions, StorageModuleOptions, StorageStats } from '../interfaces';
import { StorageError } from '../storage-error';
import { createFsError, createRmDirectoryError } from './fs-error';
import {
  DriverMkdirOptions,
  DriverReaddirOptions,
  DriverReadStreamOptions,
  DriverRmdirOptions,
  DriverRmOptions,
  DriverSignedPutUrlOptions,
  DriverSignedUrlOptions,
  DriverWriteFileOptions,
  StorageDriver,
} from '../interfaces/storage-driver.interface';
import { createStats, defaultMode } from './stats';

// Largest object copied with a single CopyObject (S3 limit: 5 GiB), and the part size used above that
const COPY_THRESHOLD = 5 * 1024 ** 3;
const COPY_PART_SIZE = 512 * 1024 ** 2;
const COPY_CONCURRENCY = 8;

function isNotFound(e: any) {
  return e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound';
}

/** GetObject on a missing key (NoSuchKey), without mistaking a missing bucket for it */
function isMissingKey(e: any) {
  return e?.name === 'NoSuchKey' || (isNotFound(e) && e?.name !== 'NoSuchBucket');
}

/** The `s3` backend: keys below an optional prefix of the bucket, with fs-compatible semantics and errors. */
export class S3Driver implements StorageDriver {
  /** The lazily loaded AWS SDK modules (private: their types must not leak into the emitted .d.ts) */
  private readonly sdk: typeof import('@aws-sdk/client-s3');
  private readonly libStorage: typeof import('@aws-sdk/lib-storage');
  private readonly presigner: typeof import('@aws-sdk/s3-request-presigner');
  private s3Client: S3Client | undefined;

  private readonly prefix: string;
  private readonly endpoint?: string;
  private readonly endpointCDN?: string;
  private readonly region?: string;
  private readonly forcePathStyle?: boolean;
  private readonly bucket: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;

  // Tests lower these to exercise the multipart copy with small objects
  private copyThreshold = COPY_THRESHOLD;
  private copyPartSize = COPY_PART_SIZE;

  constructor(private options: StorageModuleOptions) {
    // The AWS SDK is an optional peer dependency: only loaded when an 's3' disk is created. All three packages are
    // loaded here, so that a missing one fails at startup and not mid-request.
    const missing: string[] = [];
    let cause: unknown;
    const load = (name: string) => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require(name);
      } catch (error: any) {
        if (error?.code !== 'MODULE_NOT_FOUND') throw error;
        missing.push(`"${name}"`);
        cause ??= error;
      }
    };
    this.sdk = load('@aws-sdk/client-s3');
    this.libStorage = load('@aws-sdk/lib-storage');
    this.presigner = load('@aws-sdk/s3-request-presigner');
    if (missing.length > 0) {
      const names = missing.length > 1 ? `${missing.slice(0, -1).join(', ')} and ${missing.at(-1)}` : missing[0];
      throw Object.assign(
        new Error(
          `type 's3' requires the optional peer ${missing.length > 1 ? 'dependencies' : 'dependency'} ${names}: ` +
            'npm install @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner',
        ),
        { cause },
      );
    }
    if (!options.bucket) {
      throw new Error(`type 's3' requires "bucket"`);
    }
    this.endpoint = options.endpoint;
    this.endpointCDN = options.endpointCDN;
    this.region = options.region;
    this.forcePathStyle = options.forcePathStyle;
    this.bucket = options.bucket;
    this.accessKeyId = options.accessKeyId;
    this.secretAccessKey = options.secretAccessKey;
    this.prefix = options.prefix ?? '';
  }

  /** Undefined until the client has been created (by `init` or the first operation), and after `destroy` */
  get client() {
    return this.s3Client;
  }

  /** Creates the client eagerly (optional: the first operation does it otherwise). */
  async init(): Promise<void> {
    this.getClient();
  }

  /** Closes the client; a later operation creates a new one. */
  async destroy(): Promise<void> {
    const client = this.s3Client;
    this.s3Client = undefined;
    return client?.destroy();
  }

  /** The client, created on first use (synchronously, so that concurrent first calls share the one instance). */
  private getClient(): S3Client {
    // Without explicit options the SDK falls back to its defaults (AWS_REGION, IAM roles, ~/.aws, ...)
    return (this.s3Client ??= new this.sdk.S3Client({
      endpoint: this.endpoint,
      region: this.region,
      forcePathStyle: this.forcePathStyle ?? undefined,
      // Custom endpoints (MinIO, R2, ...) often reject the SDK's default checksums: default to WHEN_REQUIRED there.
      // An explicit option always wins; on plain AWS the SDK defaults apply.
      requestChecksumCalculation:
        this.options.requestChecksumCalculation ?? (this.endpoint ? 'WHEN_REQUIRED' : undefined),
      responseChecksumValidation:
        this.options.responseChecksumValidation ?? (this.endpoint ? 'WHEN_REQUIRED' : undefined),
      credentials:
        this.accessKeyId && this.secretAccessKey
          ? { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey }
          : undefined,
    }));
  }

  async mkdir(folderPath: string, { recursive }: DriverMkdirOptions): Promise<string | undefined> {
    const entry = await this.s3Entry(folderPath);
    if (entry && 'file' in entry) {
      throw createFsError('EEXIST', 'mkdir', folderPath);
    }
    if (entry) {
      if (recursive) {
        return undefined;
      }
      throw createFsError('EEXIST', 'mkdir', folderPath);
    }

    if (!recursive) {
      const parent = await this.s3Entry(path.dirname(folderPath));
      if (!parent) {
        throw createFsError('ENOENT', 'mkdir', folderPath);
      }
      if ('file' in parent) {
        throw createFsError('ENOTDIR', 'mkdir', folderPath);
      }
    }

    await this.getClient().send(
      new this.sdk.PutObjectCommand({
        Bucket: this.bucket,
        Key: this.normalizeDirKey(folderPath),
        Body: '',
        ContentLength: 0,
      }),
    );
    return undefined;
  }

  async readdir(folderPath: string, { recursive }: DriverReaddirOptions): Promise<string[]> {
    const prefix = this.normalizeDirKey(folderPath);
    const entry = await this.s3Entry(folderPath);
    if (!entry) {
      throw createFsError('ENOENT', 'scandir', folderPath);
    }
    if ('file' in entry) {
      throw createFsError('ENOTDIR', 'scandir', folderPath);
    }

    const list = new Set<string>();
    const toName = (key?: string) => key?.slice(prefix.length).replace(/\/+$/, '') ?? '';

    if (recursive) {
      for await (const output of this.listObjects({ Bucket: this.bucket, Prefix: prefix })) {
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

      return [...list];
    }

    for await (const output of this.listObjects({ Bucket: this.bucket, Delimiter: '/', Prefix: prefix })) {
      for (const key of [
        ...(output.Contents ?? []).map((content) => toName(content.Key)),
        ...(output.CommonPrefixes ?? []).map((commonPrefix) => toName(commonPrefix.Prefix)),
      ]) {
        if (key.length) {
          list.add(key);
        }
      }
    }

    return [...list];
  }

  async rmdir(folderPath: string, { recursive }: DriverRmdirOptions): Promise<void> {
    const entry = await this.s3Entry(folderPath);
    if (!entry) {
      throw createFsError('ENOENT', recursive ? 'lstat' : 'rmdir', folderPath);
    }

    if ('file' in entry) {
      if (!recursive) {
        throw createFsError('ENOTDIR', 'rmdir', folderPath);
      }
      // fs.rm(path, { recursive: true }) removes a file as well
      await this.getClient().send(
        new this.sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: this.normalizeKey(folderPath) }),
      );
      return;
    }

    if (recursive) {
      return this.deleteTree(this.normalizeDirKey(folderPath));
    }

    const dirKey = this.normalizeDirKey(folderPath);
    if (!(await this.isEmptyDir(dirKey))) {
      throw createFsError('ENOTEMPTY', 'rmdir', folderPath);
    }
    // The bucket root has no marker object
    if (dirKey) {
      await this.getClient().send(new this.sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: dirKey }));
    }
  }

  async stat(p: string): Promise<StorageStats> {
    const entry = await this.s3Entry(p);
    if (!entry) {
      throw createFsError('ENOENT', 'stat', p);
    }

    if ('file' in entry) {
      const { ContentLength, LastModified, ContentType, ETag } = entry.file;
      return {
        ...createStats({ mode: defaultMode(false), size: ContentLength ?? 0, mtime: LastModified ?? new Date(0) }),
        contentType: ContentType,
        etag: ETag?.replace(/^"|"$/g, ''),
      };
    }
    return createStats({ mode: defaultMode(true), size: 0, mtime: entry.dir.mtime ?? new Date(0) });
  }

  async exists(p: string): Promise<boolean> {
    return !!(await this.s3Entry(p));
  }

  async readFile(filePath: string): Promise<Buffer> {
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
      throw await this.missingFileError(filePath);
    }

    if (this.endpoint && this.endpointCDN) {
      const result = await this.presigner.getSignedUrl(
        this.getClient() as any,
        new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: key }) as any,
        {
          expiresIn: 60,
        },
      );
      const response = await fetch(
        result.replace(this.endpoint.replace(/(^\w+:|^)\/\//, ''), this.endpointCDN.replace(/(^\w+:|^)\/\//, '')),
      );
      if (response.status === 404) {
        throw await this.missingFileError(filePath);
      }
      if (!response.ok) {
        throw new Error(`Failed to read "${filePath}" from CDN: ${response.status} ${response.statusText}`);
      }
      return Buffer.from(await response.arrayBuffer());
    } else {
      try {
        const data = await this.getClient().send(new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: key }));
        return await streamToBuffer(data.Body as Readable);
      } catch (e: any) {
        throw isMissingKey(e) ? await this.missingFileError(filePath) : e;
      }
    }
  }

  async writeFile(filePath: string, data: Buffer, { contentType }: DriverWriteFileOptions): Promise<void> {
    const key = this.writeKey(filePath, 'open');

    await this.getClient().send(
      new this.sdk.PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: data,
        ContentType: contentType || mime.lookup(filePath) || undefined,
      }),
    );
  }

  async getSignedUrl(filePath: string, opts: DriverSignedUrlOptions): Promise<string> {
    const command = new this.sdk.GetObjectCommand({
      Bucket: this.bucket,
      Key: this.normalizeKey(filePath),
      ResponseContentDisposition: opts.responseContentDisposition,
      ResponseContentType: opts.responseContentType,
    });

    const url = await this.presigner.getSignedUrl(this.getClient(), command, { expiresIn: opts.expiresIn ?? 60 });

    if (this.endpointCDN && this.endpoint) {
      return url.replace(this.endpoint.replace(/(^\w+:|^)\/\//, ''), this.endpointCDN.replace(/(^\w+:|^)\/\//, ''));
    }
    return url;
  }

  async getSignedPutUrl(filePath: string, opts: DriverSignedPutUrlOptions): Promise<string> {
    const command = new this.sdk.PutObjectCommand({
      Bucket: this.bucket,
      Key: this.normalizeKey(filePath),
      ContentType: opts.contentType,
    });

    const url = await this.presigner.getSignedUrl(this.getClient(), command, { expiresIn: opts.expiresIn ?? 60 });

    if (this.endpointCDN && this.endpoint) {
      return url.replace(this.endpoint.replace(/(^\w+:|^)\/\//, ''), this.endpointCDN.replace(/(^\w+:|^)\/\//, ''));
    }
    return url;
  }

  async rm(filePath: string, options: DriverRmOptions): Promise<void> {
    const entry = await this.s3Entry(filePath);
    if (!entry) {
      if (options.force) {
        return;
      }
      throw createFsError('ENOENT', 'lstat', filePath);
    }

    if ('dir' in entry) {
      if (!options.recursive) {
        throw createRmDirectoryError(filePath);
      }
      return this.deleteTree(this.normalizeDirKey(filePath));
    }

    await this.getClient().send(
      new this.sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: this.normalizeKey(filePath) }),
    );
  }

  async copyFile(src: string, dest: string, mode: number): Promise<void> {
    // The two lookups run in parallel. Their results are used in the order fs would report the errors.
    const destIsFolder = this.isFolder(dest);
    const entry = await this.s3Source(src);
    if (!entry) {
      throw createFsError('ENOENT', 'copyfile', src, dest);
    }
    if ('dir' in entry) {
      throw createFsError('EISDIR', 'copyfile', src, dest);
    }

    const srcKey = this.normalizeKey(src);
    const destKey = this.writeKey(src, 'copyfile', dest);
    const exclusive = !!(mode & fs.constants.COPYFILE_EXCL);
    if (srcKey === destKey) {
      if (exclusive) {
        throw createFsError('EEXIST', 'copyfile', src, dest);
      }
      return;
    }

    if (await destIsFolder) {
      throw createFsError('EISDIR', 'copyfile', src, dest);
    }

    // Not atomic on its own. Some S3-compatible servers ignore IfNoneMatch on copies (or mishandle a failed
    // conditional multipart completion), so check up front as well; IfNoneMatch still guards against races on AWS.
    if (exclusive && (await this.headObject(destKey))) {
      throw createFsError('EEXIST', 'copyfile', src, dest);
    }

    try {
      await this.copyObject(srcKey, destKey, entry.file.size, {
        exclusive,
        storageClass: entry.file.storageClass,
      });
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 412) {
        throw createFsError('EEXIST', 'copyfile', src, dest);
      }
      throw e;
    }
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    // The two lookups run in parallel. Their results are used in the order fs would report the errors.
    const destIsFolder = this.isFolder(newPath);
    const entry = await this.s3Source(oldPath);
    if (!entry) {
      throw createFsError('ENOENT', 'rename', oldPath, newPath);
    }

    if ('file' in entry) {
      const srcKey = this.normalizeKey(oldPath);
      const destKey = this.writeKey(oldPath, 'rename', newPath);
      if (srcKey === destKey) {
        return;
      }

      if (await destIsFolder) {
        throw createFsError('EISDIR', 'rename', oldPath, newPath);
      }

      await this.copyObject(srcKey, destKey, entry.file.size, {
        storageClass: entry.file.storageClass,
      });
      await this.getClient().send(new this.sdk.DeleteObjectCommand({ Bucket: this.bucket, Key: srcKey }));
      return;
    }

    const srcDir = this.normalizeDirKey(oldPath);
    const destDir = this.normalizeDirKey(newPath);
    if (srcDir === destDir) {
      return;
    }
    if (destDir.startsWith(srcDir)) {
      throw createFsError('EINVAL', 'rename', oldPath, newPath);
    }

    const target = await this.s3Entry(newPath);
    if (target && 'file' in target) {
      throw createFsError('ENOTDIR', 'rename', oldPath, newPath);
    }
    if (target) {
      if (!(await this.isEmptyDir(destDir))) {
        throw createFsError('ENOTEMPTY', 'rename', oldPath, newPath);
      }
    }

    const copied = await this.copyTree(srcDir, destDir, !!target);

    // Not atomic: a failure here leaves the folder at both places, and nothing is rolled back
    await this.deleteKeys(copied);
  }

  createReadStream(filePath: string, options: DriverReadStreamOptions): Readable {
    const key = this.normalizeKey(filePath);

    const Range =
      typeof options.start === 'number' || typeof options.end === 'number'
        ? `bytes=${options.start ?? 0}-${typeof options.end === 'number' ? options.end : ''}`
        : undefined;

    const pass = new PassThrough({ highWaterMark: options.highWaterMark });

    // The bucket root is no object key: nothing to GET
    const request = key
      ? this.getClient().send(new this.sdk.GetObjectCommand({ Bucket: this.bucket, Key: key, Range }))
      : Promise.reject({ name: 'NoSuchKey' });
    request
      .then(({ Body }) => (Body as Readable).pipe(pass))
      .catch(async (err) => {
        try {
          // Node's stream error for a folder carries no path
          pass.destroy(isMissingKey(err) ? await this.missingFileError(filePath, false) : err);
        } catch (lookupError) {
          pass.destroy(lookupError as Error);
        }
      });

    return pass;
  }

  createWriteStream(filePath: string, options: StorageCreateWriteStreamOptions): Writable {
    const key = this.writeKey(filePath, 'open');

    const pass = new PassThrough({ highWaterMark: options.highWaterMark });
    const upload = new this.libStorage.Upload({
      client: this.getClient(),
      params: {
        Bucket: this.bucket,
        Key: key,
        Body: pass,
        ContentType: options.contentType || mime.lookup(filePath) || undefined,
      },
      queueSize: options.queueSize ?? 4,
      partSize: Math.max(options.partSize ?? 5 * 1024 * 1024, 5 * 1024 * 1024),
      leavePartsOnError: false,
    });

    let completed = false;
    const done = upload.done().then(() => {
      completed = true;
    });

    // 'finish' is only emitted once the upload has completed, like fs.WriteStream after the file is flushed
    const writable = new Writable({
      highWaterMark: options.highWaterMark,
      defaultEncoding: options.encoding,
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

  // --- lookups ---

  /** Resolves what lives at `p`: a file (object), a folder (marker and/or objects under the prefix) or nothing. */
  private async s3Entry(p: string): Promise<{ file: HeadObjectCommandOutput } | { dir: { mtime?: Date } } | undefined> {
    const dirKey = this.normalizeDirKey(p);
    if (dirKey === this.normalizeDirKey('')) {
      // The root always exists, but a missing bucket must not look like an empty one
      await this.listObjects({ Bucket: this.bucket, Prefix: dirKey, MaxKeys: 1 }).next();
      return { dir: {} };
    }

    // The bucket root normalizes to the empty key, which is no object (a HEAD on it would hit the bucket itself)
    const fileKey = this.normalizeKey(p);
    const file = fileKey ? await this.headObject(fileKey) : undefined;
    if (file) {
      return { file };
    }

    // One LIST for marker and implicit folder: the marker key is the shortest key with this prefix, so it sorts first
    const first = await this.listFirst(dirKey);
    if (!first) {
      return undefined;
    }
    return { dir: first.Key === dirKey ? { mtime: first.LastModified } : {} };
  }

  /**
   * Whether `p` is a folder (marker or implicit): any key below it. A failure (an invalid path, ...) only surfaces when
   * the result is awaited, which is what lets callers start this lookup early and still report errors in fs order.
   */
  private isFolder(p: string): Promise<boolean> {
    const lookup = (async () => !!(await this.listFirst(this.normalizeDirKey(p))))();
    lookup.catch(() => undefined);
    return lookup;
  }

  /**
   * Like `s3Entry`, for the source of a copy or rename: a file is found with one LIST (the exact key is the shortest
   * key with that prefix, so it comes first) that also returns its size and storage class. Anything else (a folder,
   * a missing path, the bucket root) falls back to `s3Entry`.
   */
  private async s3Source(
    p: string,
  ): Promise<{ file: { size: number; storageClass?: string } } | { dir: { mtime?: Date } } | undefined> {
    const key = this.normalizeKey(p);
    if (key) {
      const first = await this.listFirst(key);
      if (first?.Key === key) {
        return { file: { size: first.Size ?? 0, storageClass: first.StorageClass } };
      }
    }
    const entry = await this.s3Entry(p);
    if (entry && 'file' in entry) {
      return { file: { size: entry.file.ContentLength ?? 0, storageClass: entry.file.StorageClass } };
    }
    return entry;
  }

  /** A folder that only consists of its marker (or of nothing) is empty. */
  private async isEmptyDir(dirKey: string): Promise<boolean> {
    for await (const output of this.listObjects({ Bucket: this.bucket, Prefix: dirKey, MaxKeys: 2 })) {
      return !(output.Contents ?? []).some((content) => content.Key !== dirKey);
    }
    return true;
  }

  /** What reading `p` fails with after GetObject found no such key: EISDIR for a folder (like Node), else ENOENT. */
  private async missingFileError(p: string, withPath = true) {
    const entry = await this.s3Entry(p);
    if (entry && 'dir' in entry) {
      return createFsError('EISDIR', 'read', withPath ? p : undefined);
    }
    return createFsError('ENOENT', 'open', p);
  }

  // --- keys ---

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

  /** Object key for writing; the bucket root and the empty key are folders, never objects. */
  private writeKey(p: string, syscall: string, dest?: string) {
    const key = this.normalizeKey(dest ?? p);
    if (!key || this.normalizeDirKey(dest ?? p) === this.normalizeDirKey('')) {
      throw createFsError('EISDIR', syscall, p, dest);
    }
    return key;
  }

  // --- list ---

  private async *listObjects(input: ListObjectsV2CommandInput) {
    let ContinuationToken: string | undefined;
    do {
      const output = await this.getClient().send(new this.sdk.ListObjectsV2Command({ ...input, ContinuationToken }));
      yield output;
      ContinuationToken = output.IsTruncated ? output.NextContinuationToken : undefined;
    } while (ContinuationToken);
  }

  private async headObject(key: string): Promise<HeadObjectCommandOutput | undefined> {
    try {
      return await this.getClient().send(new this.sdk.HeadObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (e: any) {
      if (isNotFound(e)) {
        return undefined;
      }
      throw e;
    }
  }

  /** The first object key (UTF-8 byte order) that starts with `prefix`, if any. */
  private async listFirst(prefix: string) {
    const output = await this.getClient().send(
      new this.sdk.ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, MaxKeys: 1 }),
    );
    return output.Contents?.[0];
  }

  // --- delete ---

  /** Deletes every object below the folder key, marker included. Nothing to delete is not an error. */
  private async deleteTree(dirKey: string): Promise<void> {
    // A page holds at most 1000 keys, which is also the DeleteObjects limit
    for await (const output of this.listObjects({ Bucket: this.bucket, Prefix: dirKey })) {
      const keys = (output.Contents ?? []).flatMap((content) => (content.Key ? [content.Key] : []));
      if (!keys.length) {
        continue;
      }

      const result = await this.getClient().send(
        new this.sdk.DeleteObjectsCommand({
          Bucket: this.bucket,
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

  // --- copy ---

  /**
   * Copies every object below `srcDir` to `destDir`, then returns the copied source keys (to be deleted by the caller).
   * Copy everything first, delete the originals only once every copy has succeeded. If a copy fails, the
   * destination keys written by this call are removed again. An existing (empty) destination folder keeps its
   * marker: it is not ours, and the copy of the source marker would only have rewritten it.
   */
  private async copyTree(srcDir: string, destDir: string, destExists: boolean): Promise<string[]> {
    const copied: string[] = [];
    const written: string[] = [];
    try {
      for await (const output of this.listObjects({ Bucket: this.bucket, Prefix: srcDir })) {
        const objects = (output.Contents ?? []).flatMap((content) =>
          content.Key ? [{ key: content.Key, size: content.Size ?? 0, storageClass: content.StorageClass }] : [],
        );

        let next = 0;
        let failed = false;
        const worker = async () => {
          while (!failed && next < objects.length) {
            const { key, size, storageClass } = objects[next++];
            const destKey = destDir + key.slice(srcDir.length);
            // Recorded before the request: a copy that looks failed on the client may still have landed
            if (!(destExists && destKey === destDir)) {
              written.push(destKey);
            }
            try {
              await this.copyObject(key, destKey, size, { storageClass });
            } catch (e) {
              failed = true;
              throw e;
            }
            copied.push(key);
          }
        };
        // Wait for every worker, so that no copy is still in flight when the rollback runs
        const results = await Promise.allSettled(
          Array.from({ length: Math.min(COPY_CONCURRENCY, objects.length) }, worker),
        );
        const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (rejected) {
          throw rejected.reason;
        }
      }
    } catch (error) {
      try {
        await this.deleteKeys(written, true);
      } catch (cleanupError) {
        // Keep the original error, but do not lose the failed cleanup
        if (typeof error === 'object' && error !== null) {
          (error as StorageError).cleanupError = cleanupError;
        }
      }
      throw error;
    }
    return copied;
  }

  /**
   * Deletes exactly these keys in DeleteObjects batches of 1000 and throws on the first failure. With `bestEffort`,
   * the remaining batches are still attempted before the first failure is thrown.
   */
  private async deleteKeys(keys: string[], bestEffort = false): Promise<void> {
    let failure: { error: unknown } | undefined;
    for (let i = 0; i < keys.length; i += 1000) {
      try {
        const result = await this.getClient().send(
          new this.sdk.DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.slice(i, i + 1000).map((key) => ({ Key: key })), Quiet: true },
          }),
        );
        if (result.Errors?.length) {
          const [error] = result.Errors;
          throw new Error(
            `Failed to delete ${result.Errors.length} object(s), e.g. "${error.Key}": ${error.Code} ${error.Message}`,
          );
        }
      } catch (e) {
        if (!bestEffort) {
          throw e;
        }
        failure ??= { error: e };
      }
    }
    if (failure) {
      throw failure.error;
    }
  }

  private async copyObject(
    srcKey: string,
    destKey: string,
    size: number,
    opts?: { exclusive?: boolean; storageClass?: string },
  ): Promise<void> {
    const CopySource = `${this.bucket}/${srcKey.split('/').map(encodeURIComponent).join('/')}`;
    // Fails with 412 when the destination exists. Without IfNoneMatch this check would not be atomic.
    const IfNoneMatch = opts?.exclusive ? '*' : undefined;

    // Without it the copy would be written as STANDARD. Fails with InvalidObjectState for GLACIER / DEEP_ARCHIVE.
    const keepClass = (storageClass?: string) =>
      storageClass && storageClass !== 'STANDARD' ? storageClass : undefined;

    if (size <= this.copyThreshold) {
      // ContentType, metadata and tags are copied by default
      await this.getClient().send(
        new this.sdk.CopyObjectCommand({
          Bucket: this.bucket,
          Key: destKey,
          CopySource,
          IfNoneMatch,
          StorageClass: keepClass(opts?.storageClass) as StorageClass | undefined,
        }),
      );
      return;
    }

    const head = await this.getClient().send(new this.sdk.HeadObjectCommand({ Bucket: this.bucket, Key: srcKey }));
    const Tagging = await this.getTagging(srcKey);
    const { UploadId } = await this.getClient().send(
      new this.sdk.CreateMultipartUploadCommand({
        Bucket: this.bucket,
        Key: destKey,
        ContentType: head.ContentType,
        ContentDisposition: head.ContentDisposition,
        CacheControl: head.CacheControl,
        ContentEncoding: head.ContentEncoding,
        Metadata: head.Metadata,
        // HEAD only reports the class of non-STANDARD objects
        StorageClass: keepClass(opts?.storageClass ?? head.StorageClass) as ObjectStorageClass | undefined,
        Tagging,
      }),
    );

    try {
      // S3 allows at most 10000 parts
      const partSize = Math.max(this.copyPartSize, Math.ceil(size / 10000));
      const parts: CompletedPart[] = [];
      for (let start = 0, partNumber = 1; start < size; start += partSize, partNumber++) {
        const end = Math.min(start + partSize, size) - 1;
        const part = await this.getClient().send(
          new this.sdk.UploadPartCopyCommand({
            Bucket: this.bucket,
            Key: destKey,
            UploadId,
            PartNumber: partNumber,
            CopySource,
            CopySourceRange: `bytes=${start}-${end}`,
          }),
        );
        parts.push({ PartNumber: partNumber, ETag: part.CopyPartResult?.ETag });
      }

      await this.getClient().send(
        new this.sdk.CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: destKey,
          UploadId,
          MultipartUpload: { Parts: parts },
          IfNoneMatch,
        }),
      );
    } catch (e) {
      await this.getClient()
        .send(new this.sdk.AbortMultipartUploadCommand({ Bucket: this.bucket, Key: destKey, UploadId }))
        .catch(() => undefined);
      throw e;
    }
  }

  /**
   * The tags of an object as a URL-encoded query string, for CreateMultipartUpload (UploadPartCopy cannot copy them).
   * Without `s3:GetObjectTagging`, or on a provider without tagging, the copy goes on without tags.
   */
  private async getTagging(key: string): Promise<string | undefined> {
    try {
      const { TagSet } = await this.getClient().send(
        new this.sdk.GetObjectTaggingCommand({ Bucket: this.bucket, Key: key }),
      );
      return (
        TagSet?.map(({ Key, Value }) => `${encodeURIComponent(Key ?? '')}=${encodeURIComponent(Value ?? '')}`).join(
          '&',
        ) || undefined
      );
    } catch (e: any) {
      const status = e?.$metadata?.httpStatusCode;
      if (['AccessDenied', 'NotImplemented', 'MethodNotAllowed', 'UnsupportedOperation'].includes(e?.name)) {
        return undefined;
      }
      if (status === 403 || status === 405 || status === 501) {
        return undefined;
      }
      throw e;
    }
  }
}
