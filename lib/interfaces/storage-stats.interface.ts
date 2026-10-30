import * as fs from 'fs';

/**
 * Result of `StorageService.stat`. A real `fs.Stats` (filesystem) is assignable to it.
 * `contentType` and `etag` are only set for S3 files.
 */
export interface StorageStats extends fs.StatsBase<number> {
  contentType?: string;
  etag?: string;
}
