import { StorageConfig, StorageDiskOptions, StorageMultiDiskOptions } from './interfaces';
import { FileSystemDriver } from './drivers/file-system.driver';
import { FtpDriver } from './drivers/ftp.driver';
import { MemoryDriver } from './drivers/memory.driver';
import { S3Driver } from './drivers/s3.driver';
import { SftpDriver } from './drivers/sftp.driver';
import { StorageDriver } from './interfaces/storage-driver.interface';
import { StorageDisk } from './storage-disk';

const DEFAULT_DISK = 'default';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function createDriver(options: StorageDiskOptions): StorageDriver {
  switch (options.type) {
    case 's3':
      return new S3Driver(options);
    case 'memory':
      return new MemoryDriver(options);
    case 'ftp':
      return new FtpDriver(options);
    case 'sftp':
      return new SftpDriver(options);
    case 'fileSystem':
    default:
      return new FileSystemDriver(options);
  }
}

/** Validates the config and builds one driver per disk (a single store becomes the disk named 'default'). */
function createDrivers(config: StorageConfig): { drivers: Map<string, StorageDriver>; defaultName: string } {
  if (!isObject(config) || !('disks' in config)) {
    return {
      drivers: new Map([[DEFAULT_DISK, createDriver(config as StorageDiskOptions)]]),
      defaultName: DEFAULT_DISK,
    };
  }
  const { default: defaultName, disks } = config as StorageMultiDiskOptions;
  if (!isObject(disks) || Object.keys(disks).length === 0) {
    throw new Error('Storage "disks" must be a non-empty object of named disk configurations');
  }
  if (typeof defaultName !== 'string' || !Object.prototype.hasOwnProperty.call(disks, defaultName)) {
    throw new Error(
      `Storage "default" must be the name of a configured disk (${Object.keys(disks).join(', ')}), got ${JSON.stringify(
        defaultName,
      )}`,
    );
  }
  const drivers = new Map<string, StorageDriver>();
  for (const [name, options] of Object.entries(disks)) {
    if (name === '') {
      throw new Error('Storage disk names must not be empty');
    }
    if (!isObject(options)) {
      throw new Error(`Storage disk "${name}" must be a configuration object`);
    }
    try {
      drivers.set(name, createDriver(options as unknown as StorageDiskOptions));
    } catch (error) {
      if (error instanceof Error) {
        error.message = `Storage disk "${name}": ${error.message}`;
      }
      throw error;
    }
  }
  return { drivers, defaultName };
}

/**
 * The default disk (it has the whole file API itself) and the entry point to the other named disks.
 * A single-store configuration is one disk named `'default'`.
 */
export class Storage extends StorageDisk {
  private readonly drivers: Map<string, StorageDriver>;
  private readonly disks = new Map<string, StorageDisk>();

  constructor(config: StorageConfig) {
    const { drivers, defaultName } = createDrivers(config);
    super(drivers.get(defaultName)!);
    this.drivers = drivers;
  }

  /** The names of all configured disks. */
  get diskNames(): string[] {
    return [...this.drivers.keys()];
  }

  /**
   * The disk configured under `name` (the default disk too: it shares its storage with this instance).
   * Throws for an unknown name.
   */
  disk(name: string): StorageDisk {
    let disk = this.disks.get(name);
    if (!disk) {
      const driver = this.drivers.get(name);
      if (!driver) {
        throw new Error(`Unknown storage disk "${name}". Configured disks: ${this.diskNames.join(', ')}`);
      }
      disk = new StorageDisk(driver);
      this.disks.set(name, disk);
    }
    return disk;
  }

  /**
   * Optional eager warm-up of all disks (e.g. creates the S3 clients). Every disk also initializes itself on first
   * use, so calling this is not required; nestjs-multi-storage calls it on module init.
   */
  async init(): Promise<void> {
    await Promise.all([...this.drivers.values()].map((driver) => driver.init()));
  }

  /**
   * Closes the connections and clients of all disks. Recommended on shutdown; in serverless environments it is
   * optional. The disks stay usable: S3, FTP and SFTP reconnect on the next operation.
   */
  async destroy(): Promise<void | undefined> {
    const results = await Promise.allSettled([...this.drivers.values()].map((driver) => driver.destroy()));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) {
      throw failed.reason;
    }
  }
}

/**
 * Creates the storage from a single-store or multi-disk configuration, without any framework.
 * No `init()` is needed: connections and clients are created on first use.
 */
export function createStorage(config: StorageConfig): Storage {
  return new Storage(config);
}
