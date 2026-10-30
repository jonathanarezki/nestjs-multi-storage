export interface StorageModuleOptions {
  /** `memory` keeps everything in a private in-memory volume (needs the optional peer dependency `memfs`) */
  type: 'fileSystem' | 's3' | 'memory';
  endpoint?: string;
  endpointCDN?: string;
  region?: string;
  forcePathStyle?: boolean;
  /** Set to 'WHEN_REQUIRED' for S3-compatible providers that reject the SDK's default checksums */
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
