export interface StorageModuleOptions {
  type: 'fileSystem' | 's3';
  endpoint?: string;
  endpointCDN?: string;
  region?: string;
  forcePathStyle?: boolean;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  prefix?: string;
}
