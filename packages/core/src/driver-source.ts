import { StorageDriver } from './interfaces/storage-driver.interface';

/** The methods every driver must implement (the others of `StorageDriver` are optional). */
const REQUIRED_METHODS = [
  'mkdir',
  'readdir',
  'rmdir',
  'stat',
  'exists',
  'readFile',
  'writeFile',
  'rm',
  'copyFile',
  'rename',
] as const;

/** Throws an error naming the required methods that `driver` lacks (`label` names the disk, a single store has none). */
export function checkDriver(driver: unknown, label?: string): asserts driver is StorageDriver {
  const isObject = typeof driver === 'object' && driver !== null;
  const missing = isObject
    ? REQUIRED_METHODS.filter((method) => typeof (driver as StorageDriver)[method] !== 'function')
    : REQUIRED_METHODS;
  if (missing.length > 0) {
    throw new Error(
      `${label === undefined ? '' : `Storage disk "${label}": `}the driver ${
        isObject ? 'is missing' : 'must be an object implementing'
      } the required method${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`,
    );
  }
}

/**
 * Where a disk gets its driver from: created on first use (a factory and/or a `wrap` function are only called then),
 * at most once. The "inner" driver is the built-in one (S3, ...) or the custom one; a `wrap` function puts a wrapper
 * on it. `builtin` is kept for `StorageDisk.s3client`.
 * @internal
 */
export class DriverSource {
  private inner?: StorageDriver;
  private driver?: StorageDriver;

  /** `label` names the disk in error messages (a single store has none). */
  constructor(
    private readonly createInner: () => StorageDriver,
    private readonly wrap?: (inner: StorageDriver) => StorageDriver,
    readonly builtin?: StorageDriver,
    private readonly label?: string,
  ) {
    this.inner = builtin;
  }

  get(): StorageDriver {
    if (!this.driver) {
      if (!this.inner) {
        const inner = this.createInner();
        checkDriver(inner, this.label);
        this.inner = inner;
      }
      const driver = this.wrap ? this.wrap(this.inner) : this.inner;
      checkDriver(driver, this.label);
      this.driver = driver;
    }
    return this.driver;
  }

  /** Creates the driver (and its wrapper) and initializes it: the wrapper's `init`, else the one of the inner driver. */
  async init(): Promise<void> {
    const driver = this.get();
    await (driver.init ? driver.init() : this.inner?.init?.());
  }

  /**
   * Closes the driver: the wrapper's `destroy`, else the one of the inner driver (a wrapper that does not forward it
   * must not leak the built-in connections). Never creates a driver or a wrapper.
   */
  async destroy(): Promise<void> {
    await (this.driver?.destroy ? this.driver.destroy() : this.inner?.destroy?.());
  }
}
