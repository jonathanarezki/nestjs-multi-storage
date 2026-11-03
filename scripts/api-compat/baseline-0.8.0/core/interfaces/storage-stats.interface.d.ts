import * as fs from 'fs';
export interface StorageStats extends fs.StatsBase<number> {
  contentType?: string;
  etag?: string;
}
