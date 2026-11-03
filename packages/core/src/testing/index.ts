import { createStorage } from '../storage';
import { StorageDriver } from '../interfaces/storage-driver.interface';
import { GROUP_NAMES, GROUPS } from './groups';

/**
 * The test functions of the framework that runs the suite. `describe`, `it`, `beforeEach` and `afterEach` default to
 * the globals of Jest, Vitest (with `globals: true`) and Mocha; pass them explicitly for Vitest without globals or
 * `node:test`. The callbacks may return a promise.
 */
export interface StorageDriverTestFunctions {
  describe: (name: string, fn: () => void) => unknown;
  it: (name: string, fn: () => any) => unknown;
  beforeEach: (fn: () => any) => unknown;
  afterEach: (fn: () => any) => unknown;
}

/** @experimental May change in a minor release of 0.8.x. */
export interface DescribeStorageDriverOptions {
  /**
   * Returns the driver under test, on a fresh and EMPTY store. It is called before every test, so the tests do not
   * influence each other: use a new temporary folder, key prefix, database or in-memory instance each time.
   */
  create: () => StorageDriver | Promise<StorageDriver>;
  /** Called after every test with the driver `create` returned (delete the temporary folder, drop the database, ...). The disk is destroyed afterwards, which calls `driver.destroy()`. */
  cleanup?: (driver: StorageDriver) => Promise<void> | void;
  /** Groups of tests to leave out, by name (see `STORAGE_DRIVER_TEST_GROUPS`), e.g. `['streams', 'rename-folder']`. An unknown name throws. */
  skip?: string[];
  /** The test functions to use instead of the globals. */
  test?: Partial<StorageDriverTestFunctions>;
}

/** The names of the test groups, the values `skip` accepts. */
export const STORAGE_DRIVER_TEST_GROUPS: readonly string[] = GROUP_NAMES;

function testFunctions(given: Partial<StorageDriverTestFunctions> = {}): StorageDriverTestFunctions {
  const globals = globalThis as unknown as Partial<StorageDriverTestFunctions>;
  const resolved = {} as Record<string, unknown>;
  for (const name of ['describe', 'it', 'beforeEach', 'afterEach'] as const) {
    const fn = given[name] ?? globals[name];
    if (typeof fn !== 'function') {
      throw new Error(
        `describeStorageDriver: "${name}" is not a global of your test runner; pass it as options.test.${name}`,
      );
    }
    resolved[name] = fn;
  }
  return resolved as unknown as StorageDriverTestFunctions;
}

/**
 * Runs the fs-behaviour suite of this library against your `StorageDriver`: the Node-style results and errors
 * (`ENOENT`, `EEXIST`, `EISDIR`, `ENOTDIR`, `ENOTEMPTY`, `ERR_FS_EISDIR`, ...) that the built-in backends all share.
 * Call it at the top level of a test file, like `describe`. Every test gets a new driver from `options.create` and
 * reaches it through a disk, `createStorage({ type: 'custom', driver })`, so the argument normalization and the
 * stream fallbacks are tested as well. The assertions use `node:assert/strict`.
 *
 * @experimental May change in a minor release of 0.8.x.
 */
export function describeStorageDriver(name: string, options: DescribeStorageDriverOptions): void {
  const { create, cleanup, skip = [] } = options;
  const unknown = skip.filter((group) => !GROUP_NAMES.includes(group));
  if (unknown.length > 0) {
    throw new Error(
      `describeStorageDriver: unknown group${unknown.length > 1 ? 's' : ''} in "skip": ${unknown.join(
        ', ',
      )} (known: ${GROUP_NAMES.join(', ')})`,
    );
  }
  const framework = testFunctions(options.test);
  framework.describe(name, () => {
    let current: { driver: StorageDriver; disk: ReturnType<typeof createStorage> } | undefined;
    framework.beforeEach(async () => {
      current = undefined;
      const driver = await create();
      current = { driver, disk: createStorage({ type: 'custom', driver }) };
    });
    framework.afterEach(async () => {
      const used = current;
      current = undefined;
      if (!used) return;
      try {
        await cleanup?.(used.driver);
      } finally {
        await used.disk.destroy();
      }
    });
    for (const group of GROUPS) {
      if (skip.includes(group.name)) continue;
      framework.describe(group.name, () =>
        group.define((title, fn) =>
          framework.it(title, async () => {
            await fn(current!.disk);
          }),
        ),
      );
    }
  });
}
