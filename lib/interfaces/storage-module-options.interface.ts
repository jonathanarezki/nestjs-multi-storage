export interface StorageModuleOptions {
  type: 'fileSystem' | 's3';
  endpoint?: string;
  region?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  prefix?: string;
}
