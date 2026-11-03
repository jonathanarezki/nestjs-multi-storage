import { createStorage, StorageDriver } from '@webbar/node-multi-storage';
import { describeStorageDriver } from '@webbar/node-multi-storage/testing';
import { Backend, backendOptions, describeBackends } from './support/harness';
import { createMapDriver } from './support/map-driver';

/**
 * The conformance kit that custom-driver authors use (`@webbar/node-multi-storage/testing`), run against the five
 * built-in drivers and a minimal custom driver: what the kit asserts is what all of them share.
 */

/** The built-in driver of a fresh store of `backend`, and how to clean that store up. */
function builtinDriver(backend: Backend) {
  const closers = new Map<StorageDriver, () => Promise<void>>();
  return {
    async create(): Promise<StorageDriver> {
      const { options, prefix } = backendOptions(backend, 'conformance');
      // The storage is only used to reach its built-in driver and to clean up: the kit makes its own disk on it
      const storage = createStorage(options);
      const driver = (storage as any).source.builtin as StorageDriver;
      // A remote prefix, like a real folder, has to exist
      await storage.mkdir('');
      closers.set(driver, async () => {
        if (backend.name === 'fileSystem') {
          await storage.rm('', { recursive: true, force: true }).catch(() => undefined);
          await require('fs').promises.rm(prefix, { recursive: true, force: true });
        } else {
          await storage.rmdir('').catch(() => undefined);
        }
        await storage.destroy();
      });
      return driver;
    },
    async cleanup(driver: StorageDriver) {
      await closers.get(driver)?.();
      closers.delete(driver);
    },
  };
}

describeBackends('conformance kit', (backend) => {
  const { create, cleanup } = builtinDriver(backend);
  describeStorageDriver(`built-in ${backend.name} driver`, { create, cleanup });
});

describeStorageDriver('minimal custom driver on a Map', { create: () => createMapDriver() });
