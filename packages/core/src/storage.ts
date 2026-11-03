import { StorageConfig, StorageDiskOptions, StorageModuleOptions, StorageMultiDiskOptions } from './interfaces';
import { FileSystemDriver } from './drivers/file-system.driver';
import { FtpDriver } from './drivers/ftp.driver';
import { MemoryDriver } from './drivers/memory.driver';
import { S3Driver } from './drivers/s3.driver';
import { SftpDriver } from './drivers/sftp.driver';
import { StorageDriver } from './interfaces/storage-driver.interface';
import { checkDriver, DriverSource } from './driver-source';
import { StorageDisk } from './storage-disk';

const DEFAULT_DISK = 'default';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkFunction(value: unknown, what: string) {
  if (value !== undefined && typeof value !== 'function') {
    throw new Error(`${what} must be a function`);
  }
}

function createBuiltinDriver(options: StorageModuleOptions): StorageDriver {
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

/**
 * Validates the options of one disk. A built-in driver is built at once (so that bad options fail early); the
 * `wrap` function and the factory of a custom driver only run when the driver is first used.
 */
function createSource(options: StorageDiskOptions, label?: string): DriverSource {
  const { wrap } = options;
  checkFunction(wrap, '"wrap"');
  if (options.type === 'custom') {
    const { driver } = options;
    if (!(typeof driver === 'function' || isObject(driver))) {
      throw new Error(`type 'custom' needs "driver": a StorageDriver object or a factory function returning one`);
    }
    if (typeof driver !== 'function') checkDriver(driver); // an instance fails fast, a factory is checked when called
    return new DriverSource(typeof driver === 'function' ? driver : () => driver, wrap, undefined, label);
  }
  const builtin = createBuiltinDriver(options);
  return new DriverSource(() => builtin, wrap, builtin, label);
}

/** Validates the config and builds one driver source per disk (a single store becomes the disk named 'default'). */
function createSources(config: StorageConfig): { sources: Map<string, DriverSource>; defaultName: string } {
  if (!isObject(config) || !('disks' in config)) {
    return {
      sources: new Map([[DEFAULT_DISK, createSource(config as StorageDiskOptions)]]),
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
  const sources = new Map<string, DriverSource>();
  for (const [name, options] of Object.entries(disks)) {
    if (name === '') {
      throw new Error('Storage disk names must not be empty');
    }
    if (!isObject(options)) {
      throw new Error(`Storage disk "${name}" must be a configuration object`);
    }
    try {
      sources.set(name, createSource(options as unknown as StorageDiskOptions, name));
    } catch (error) {
      if (error instanceof Error) {
        error.message = `Storage disk "${name}": ${error.message}`;
      }
      throw error;
    }
  }
  return { sources, defaultName };
}

/**
 * The default disk (it has the whole file API itself) and the entry point to the other named disks.
 * A single-store configuration is one disk named `'default'`.
 */
export class Storage extends StorageDisk {
  private readonly sources: Map<string, DriverSource>;
  private readonly disks = new Map<string, StorageDisk>();

  constructor(config: StorageConfig) {
    const { sources, defaultName } = createSources(config);
    super(sources.get(defaultName)!);
    this.sources = sources;
  }

  /** The names of all configured disks. */
  get diskNames(): string[] {
    return [...this.sources.keys()];
  }

  /**
   * The disk configured under `name` (the default disk too: it shares its storage with this instance).
   * Throws for an unknown name.
   */
  disk(name: string): StorageDisk {
    let disk = this.disks.get(name);
    if (!disk) {
      const source = this.sources.get(name);
      if (!source) {
        throw new Error(`Unknown storage disk "${name}". Configured disks: ${this.diskNames.join(', ')}`);
      }
      disk = new StorageDisk(source);
      this.disks.set(name, disk);
    }
    return disk;
  }

  /**
   * Optional eager warm-up of all disks (e.g. creates the S3 clients). Every disk also initializes itself on first
   * use, so calling this is not required; nestjs-multi-storage calls it on module init.
   */
  async init(): Promise<void> {
    await Promise.all([...this.sources.values()].map((source) => source.init()));
  }

  /**
   * Closes the connections and clients of all disks. Recommended on shutdown; in serverless environments it is
   * optional. The disks stay usable: S3, FTP and SFTP reconnect on the next operation.
   */
  async destroy(): Promise<void | undefined> {
    const results = await Promise.allSettled([...this.sources.values()].map((source) => source.destroy()));
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
