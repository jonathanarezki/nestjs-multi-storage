import type { S3Client } from '@aws-sdk/client-s3';
import { Readable, Writable } from 'stream';
import {
  StorageCreateReadStreamOptions,
  StorageCreateWriteStreamOptions,
  StorageMkdirOptions,
  StorageReaddirOptions,
  StorageReadFileOptions,
  StorageRmdirOptions,
  StorageRmOptions,
  StorageStats,
  StorageWriteFileOptions,
} from './interfaces';
import { S3Driver } from './drivers/s3.driver';
import { notSupportedError } from './drivers/fs-error';
import { DriverSource } from './driver-source';
import { readStreamFallback, writeStreamFallback } from './fallback-streams';

/** A string is shorthand for `{ encoding }`; `null` and `undefined` are no options. */
function withEncoding<T extends { encoding?: BufferEncoding | null }>(options?: BufferEncoding | T | null): T {
  return typeof options === 'string' ? ({ encoding: options } as T) : options ?? ({} as T);
}

/** Like Node's `fs`, an unknown encoding is rejected before anything else happens. */
function checkEncoding(encoding?: string | null) {
  if (encoding && encoding !== 'buffer' && !Buffer.isEncoding(encoding)) {
    throw Object.assign(new TypeError(`The argument 'encoding' is invalid encoding. Received '${encoding}'`), {
      code: 'ERR_INVALID_ARG_VALUE',
    });
  }
}

/** Re-encodes UTF-8 names like `fs.readdir` does for `encoding` ('buffer' gives Buffers); utf8 or none leaves them. */
function encodeNames(names: string[], encoding?: string | null): any[] {
  if (!encoding || encoding === 'utf8' || encoding === 'utf-8') return names;
  return names.map((name) =>
    encoding === 'buffer' ? Buffer.from(name) : Buffer.from(name).toString(encoding as BufferEncoding),
  );
}

/**
 * One named storage (filesystem, memory, S3, FTP or SFTP) with the fs-compatible file API.
 * Created by the library: get it with `storage.disk(name)` (nestjs-multi-storage also injects it with `@InjectStorage(name)`).
 * It normalizes the arguments (shorthands, defaults, encodings, validation) and hands the driver plain bytes and options.
 */
export class StorageDisk {
  /** @internal */
  /** The driver is created on first use (a custom driver factory or a `wrap` function runs then, once). */
  constructor(private readonly source: DriverSource) {}

  /** The AWS SDK client of an S3 disk (also when its driver is wrapped), `undefined` for the other types. */
  get s3client(): S3Client | undefined {
    return this.source.builtin instanceof S3Driver ? this.source.builtin.client : undefined;
  }

  /** Unlike `fs.promises.mkdir`, `recursive` defaults to `true`. */
  async mkdir(folderPath: string, options?: StorageMkdirOptions): Promise<string | undefined> {
    return this.source.get().mkdir(folderPath, { recursive: options?.recursive ?? true, mode: options?.mode });
  }

  async readdir(folderPath: string, options?: BufferEncoding | StorageReaddirOptions): Promise<string[]> {
    const { recursive, encoding } = withEncoding<StorageReaddirOptions>(options);
    checkEncoding(encoding);
    const names = await this.source.get().readdir(folderPath, { recursive: recursive ?? false });
    // Drivers may list in any order: the disk guarantees plain code-unit order of the UTF-8 names (before encoding)
    return encodeNames([...names].sort(), encoding);
  }

  /** Unlike `fs.promises.rmdir`, `recursive` defaults to `true` (like `fs.promises.rm(path, { recursive: true })`). */
  async rmdir(folderPath: string, options?: StorageRmdirOptions): Promise<void> {
    return this.source.get().rmdir(folderPath, { recursive: options?.recursive ?? true });
  }

  async stat(p: string): Promise<StorageStats> {
    return this.source.get().stat(p);
  }

  /**
   * Unlike `fs.existsSync`, errors other than "not found" (403, network, ...) are thrown, not turned into `false`.
   */
  async exists(p: string): Promise<boolean> {
    return this.source.get().exists(p);
  }

  async readFile(
    filePath: string,
    options: BufferEncoding | (StorageReadFileOptions & { encoding: BufferEncoding }),
  ): Promise<string>;
  async readFile(filePath: string, options?: (StorageReadFileOptions & { encoding?: null }) | null): Promise<Buffer>;
  async readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer>;
  async readFile(filePath: string, options?: BufferEncoding | StorageReadFileOptions | null): Promise<string | Buffer> {
    const { encoding, flag } = withEncoding<StorageReadFileOptions>(options);
    checkEncoding(encoding);
    const data = await this.source.get().readFile(filePath, { flag });
    return encoding ? data.toString(encoding) : data;
  }

  async writeFile(
    filePath: string,
    data: string | Buffer | Uint8Array,
    options?: BufferEncoding | StorageWriteFileOptions,
  ): Promise<void> {
    const { encoding, mode, flag, contentType } = withEncoding<StorageWriteFileOptions>(options);
    checkEncoding(encoding);
    let bytes: Buffer;
    if (typeof data === 'string') {
      bytes = Buffer.from(data, encoding);
    } else if (Buffer.isBuffer(data)) {
      bytes = data;
    } else {
      bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    return this.source.get().writeFile(filePath, bytes, { mode, flag, contentType });
  }

  public async getSignedUrl(
    filePath: string,
    opts?: { expiresIn?: number; responseContentDisposition?: string; responseContentType?: string },
  ): Promise<string> {
    const driver = this.source.get();
    if (!driver.getSignedUrl) throw notSupportedError('getSignedUrl');
    return driver.getSignedUrl(filePath, opts ?? {});
  }

  public async getSignedPutUrl(filePath: string, opts?: { expiresIn?: number; contentType?: string }): Promise<string> {
    const driver = this.source.get();
    if (!driver.getSignedPutUrl) throw notSupportedError('getSignedPutUrl');
    return driver.getSignedPutUrl(filePath, opts ?? {});
  }

  async rm(filePath: string, options?: StorageRmOptions): Promise<void> {
    return this.source.get().rm(filePath, { force: options?.force ?? false, recursive: options?.recursive ?? false });
  }

  async copyFile(src: string, dest: string, mode?: number): Promise<void> {
    return this.source.get().copyFile(src, dest, mode ?? 0);
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    return this.source.get().rename(oldPath, newPath);
  }

  createReadStream(filePath: string, options?: StorageCreateReadStreamOptions): Readable {
    const { start, end, highWaterMark, encoding } = options ?? {};
    checkEncoding(encoding);
    if (typeof start === 'number' && typeof end === 'number' && start > end) {
      throw Object.assign(
        new RangeError(`The value of "start" is out of range. It must be <= "end" (here: ${end}). Received ${start}`),
        { code: 'ERR_OUT_OF_RANGE' },
      );
    }
    const driver = this.source.get();
    const driverOptions = { start, end, highWaterMark };
    const stream = driver.createReadStream
      ? driver.createReadStream(filePath, driverOptions)
      : readStreamFallback(driver, filePath, driverOptions);
    if (encoding) stream.setEncoding(encoding);
    return stream;
  }

  createWriteStream(filePath: string, options?: StorageCreateWriteStreamOptions): Writable {
    const driver = this.source.get();
    return driver.createWriteStream
      ? driver.createWriteStream(filePath, options ?? {})
      : writeStreamFallback(driver, filePath, options ?? {});
  }
}
