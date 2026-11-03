import { Readable, Writable } from 'stream';
import { StorageCreateWriteStreamOptions } from './interfaces';
import { DriverReadStreamOptions, StorageDriver } from './interfaces/storage-driver.interface';

/** The default `highWaterMark` of `fs.createReadStream`. */
const READ_CHUNK_SIZE = 64 * 1024;

/**
 * The read stream of a driver without `createReadStream`: reads the whole file with `readFile` (memory!) right away,
 * like `fs.createReadStream` opens the file, then emits the `start`..`end` range (inclusive) in `highWaterMark`
 * chunks. Failures of `readFile` (ENOENT, EISDIR, ...) are emitted as `'error'`.
 * @internal
 */
export function readStreamFallback(
  driver: StorageDriver,
  filePath: string,
  { start, end, highWaterMark }: DriverReadStreamOptions,
): Readable {
  const chunkSize = highWaterMark ?? READ_CHUNK_SIZE;
  let range: Buffer | undefined;
  let offset = 0;
  // deferred, so that `stream` exists when a failure is reported
  const loaded = Promise.resolve()
    .then(() => driver.readFile(filePath, {}))
    .then(
      (data) => {
        range = data.subarray(start ?? 0, end === undefined ? undefined : end + 1);
      },
      (error) => stream.destroy(error),
    );
  const stream: Readable = new Readable({
    highWaterMark: chunkSize,
    read() {
      void loaded.then(() => {
        if (!range) return;
        if (offset >= range.length) return void this.push(null);
        const chunk = range.subarray(offset, offset + chunkSize);
        offset += chunk.length;
        this.push(chunk);
      });
    },
  });
  return stream;
}

/**
 * The write stream of a driver without `createWriteStream`: buffers all the chunks in memory and calls `writeFile`
 * once the stream ends; `'finish'` is emitted when it has completed, a failure is emitted as `'error'`. A stream
 * destroyed before its end writes nothing.
 * @internal
 */
export function writeStreamFallback(
  driver: StorageDriver,
  filePath: string,
  options: StorageCreateWriteStreamOptions,
): Writable {
  const chunks: Buffer[] = [];
  return new Writable({
    highWaterMark: options.highWaterMark,
    defaultEncoding: options.encoding,
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
    final(callback) {
      driver
        .writeFile(filePath, Buffer.concat(chunks), {
          mode: options.mode,
          flag: options.flags,
          contentType: options.contentType,
        })
        .then(() => callback(), callback);
    },
  });
}
