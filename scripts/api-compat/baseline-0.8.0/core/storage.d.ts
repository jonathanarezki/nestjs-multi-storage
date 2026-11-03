import { StorageConfig } from './interfaces';
import { StorageDisk } from './storage-disk';
export declare class Storage extends StorageDisk {
  private readonly sources;
  private readonly disks;
  constructor(config: StorageConfig);
  get diskNames(): string[];
  disk(name: string): StorageDisk;
  init(): Promise<void>;
  destroy(): Promise<void | undefined>;
}
export declare function createStorage(config: StorageConfig): Storage;
