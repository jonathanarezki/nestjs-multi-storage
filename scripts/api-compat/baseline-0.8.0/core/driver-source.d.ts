import { StorageDriver } from './interfaces/storage-driver.interface';
export declare function checkDriver(driver: unknown, label?: string): asserts driver is StorageDriver;
export declare class DriverSource {
  private readonly createInner;
  private readonly wrap?;
  readonly builtin?: StorageDriver | undefined;
  private readonly label?;
  private inner?;
  private driver?;
  constructor(
    createInner: () => StorageDriver,
    wrap?: ((inner: StorageDriver) => StorageDriver) | undefined,
    builtin?: StorageDriver | undefined,
    label?: string | undefined,
  );
  get(): StorageDriver;
  init(): Promise<void>;
  destroy(): Promise<void>;
}
