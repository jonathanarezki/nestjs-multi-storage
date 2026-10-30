export interface StorageModuleOptions {
  /** `memory` keeps everything in a private in-memory volume (needs the optional peer dependency `memfs`) */
  type: 'fileSystem' | 's3' | 'memory';
  endpoint?: string;
  endpointCDN?: string;
  region?: string;
  forcePathStyle?: boolean;
  /** Defaults to 'WHEN_REQUIRED' when `endpoint` is set (S3-compatible providers often reject the SDK default checksums); explicit values win */
  requestChecksumCalculation?: 'WHEN_SUPPORTED' | 'WHEN_REQUIRED';
  responseChecksumValidation?: 'WHEN_SUPPORTED' | 'WHEN_REQUIRED';
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  prefix?: string;
  /**
   * Memory only: files to pre-populate the store with, keyed by path relative to the prefix
   * (e.g. `{ 'docs/a.txt': 'hello', 'img.png': Buffer.from(...) }`). Parent folders are created.
   */
  files?: Record<string, string | Buffer>;
}
