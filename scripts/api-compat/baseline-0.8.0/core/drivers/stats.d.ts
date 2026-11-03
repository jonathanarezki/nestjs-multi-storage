import { StorageStats } from '../interfaces';
export declare function defaultMode(isDirectory: boolean): number;
export declare function createStats(entry: {
  mode: number;
  size: number;
  mtime: Date;
  atime?: Date;
  uid?: number;
  gid?: number;
}): StorageStats;
