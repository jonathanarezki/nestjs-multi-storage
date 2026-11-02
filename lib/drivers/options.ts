import {
  StorageCreateReadStreamOptions,
  StorageReaddirOptions,
  StorageReadFileOptions,
  StorageWriteFileOptions,
} from '../interfaces';

/** Drops `undefined` values, so that fs applies its own defaults instead of receiving an explicit `undefined`. */
export function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** A string is shorthand for `{ encoding }`. */
export function readdirOptions(options?: BufferEncoding | StorageReaddirOptions): StorageReaddirOptions {
  return typeof options === 'string' ? { encoding: options } : options ?? {};
}

/** Splits the S3-only `bucket` from the options that are passed on to fs; a string is shorthand for `{ encoding }`. */
export function readFileOptions(options?: BufferEncoding | StorageReadFileOptions | null) {
  const { bucket, ...fsOptions }: StorageReadFileOptions =
    typeof options === 'string' ? { encoding: options } : options ?? {};
  return { bucket, fsOptions };
}

/** A string is shorthand for `{ encoding }`. */
export function writeFileOptions(options?: BufferEncoding | StorageWriteFileOptions): StorageWriteFileOptions {
  return typeof options === 'string' ? { encoding: options } : options ?? {};
}

/** Splits the S3-only `bucket` from the stream options that are passed on to fs. */
export function splitBucket(options?: StorageCreateReadStreamOptions) {
  const { bucket, ...fsOptions } = options ?? {};
  return { bucket, fsOptions };
}

/** Re-encodes UTF-8 names like `fs.readdir` does for `encoding` ('buffer' gives Buffers); utf8 or none leaves them. */
export function encodeNames(names: string[], encoding?: string | null): any[] {
  if (!encoding || encoding === 'utf8' || encoding === 'utf-8') return names;
  return names.map((name) =>
    encoding === 'buffer' ? Buffer.from(name) : Buffer.from(name).toString(encoding as BufferEncoding),
  );
}
