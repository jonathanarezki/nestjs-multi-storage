/**
 * Type-level check: the public API of the built `nestjs-multi-storage` must stay the same as the 0.8.0 declarations in
 * `baseline-0.8.0/` (a copy of the built `.d.ts` files of both packages, with the core import rewritten to `./core`).
 * Run with `npm run check:api` (after `npm run build`).
 *
 * Mutual assignability alone does not notice a removed optional key (`{ a?: 1 }` and `{ a?: 1; b?: 2 }` are assignable
 * to each other), so types are also compared for identity (`Identical`), which does.
 * To rebaseline for a release, replace `baseline-0.8.0/` with the new declarations and update the names here and in check.js.
 */
import * as current from 'nestjs-multi-storage';
import * as old from './baseline-0.8.0/nestjs';

/** The public members only (private members make classes nominal, so they are compared separately). */
type Pub<T> = Pick<T, keyof T>;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Strict type identity (also notices a missing or extra optional key). */
type Identical<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/** Compile error unless `T` is `true`. */
function assert<T extends true>(): T | void {
  return;
}

// Classes: instance members, constructor parameters, static members.
// `disk()` returns a `StorageDisk` declared in another file than the baseline one (nominal, because of its private
// member), so it is compared by its public members.
type ServiceRest<T> = Omit<Pub<T>, 'disk'>;
assert<Identical<ServiceRest<current.StorageService>, ServiceRest<old.StorageService>>>();
assert<Identical<Parameters<current.StorageService['disk']>, Parameters<old.StorageService['disk']>>>();
assert<Identical<Pub<ReturnType<current.StorageService['disk']>>, Pub<ReturnType<old.StorageService['disk']>>>>();
assert<
  Mutual<ConstructorParameters<typeof current.StorageService>, ConstructorParameters<typeof old.StorageService>>
>();
assert<Mutual<Pub<current.StorageDisk>, Pub<old.StorageDisk>>>();
assert<Mutual<keyof current.StorageDisk, keyof old.StorageDisk>>();
// (the StorageDisk constructor is internal: disks are created by the library)
assert<Mutual<typeof current.StorageModule.forRoot, typeof old.StorageModule.forRoot>>();
assert<Mutual<typeof current.StorageModule.forRootAsync, typeof old.StorageModule.forRootAsync>>();
assert<Mutual<Pub<typeof current.StorageModule>, Pub<typeof old.StorageModule>>>();
assert<Mutual<Pub<current.StorageModule>, Pub<old.StorageModule>>>();

// A current instance is usable wherever the old type is expected, and the other way round
const toOldService = (service: current.StorageService): Pub<old.StorageDisk> => service;
const toNewDisk = (disk: old.StorageDisk): Pub<current.StorageDisk> => disk;
void toOldService;
void toNewDisk;

// Functions and decorators
assert<Mutual<typeof current.getStorageToken, typeof old.getStorageToken>>();
assert<Mutual<typeof current.InjectStorage, typeof old.InjectStorage>>();
assert<Identical<typeof current.createFsError, typeof old.createFsError>>();
assert<Identical<typeof current.createRmDirectoryError, typeof old.createRmDirectoryError>>();
assert<Identical<typeof current.createStats, typeof old.createStats>>();
assert<Mutual<typeof current.isStorageError, typeof old.isStorageError>>();

// Options and errors
assert<Identical<current.StorageModuleOptions, old.StorageModuleOptions>>();
assert<Identical<current.StorageDiskOptions, old.StorageDiskOptions>>();
assert<Identical<current.StorageMultiDiskOptions, old.StorageMultiDiskOptions>>();
assert<Identical<current.StorageConfig, old.StorageConfig>>();
assert<Identical<current.StorageStats, old.StorageStats>>();
assert<Identical<current.StorageCustomDiskOptions, old.StorageCustomDiskOptions>>();
assert<Identical<current.StorageDriver, old.StorageDriver>>();
assert<Identical<current.DriverMkdirOptions, old.DriverMkdirOptions>>();
assert<Identical<current.DriverReaddirOptions, old.DriverReaddirOptions>>();
assert<Identical<current.DriverReadFileOptions, old.DriverReadFileOptions>>();
assert<Identical<current.DriverReadStreamOptions, old.DriverReadStreamOptions>>();
assert<Identical<current.DriverRmdirOptions, old.DriverRmdirOptions>>();
assert<Identical<current.DriverRmOptions, old.DriverRmOptions>>();
assert<Identical<current.DriverSignedPutUrlOptions, old.DriverSignedPutUrlOptions>>();
assert<Identical<current.DriverSignedUrlOptions, old.DriverSignedUrlOptions>>();
assert<Identical<current.DriverWriteFileOptions, old.DriverWriteFileOptions>>();
assert<Identical<current.StorageReadFileOptions, old.StorageReadFileOptions>>();
assert<Identical<current.StorageWriteFileOptions, old.StorageWriteFileOptions>>();
assert<Identical<current.StorageReaddirOptions, old.StorageReaddirOptions>>();
assert<Identical<current.StorageMkdirOptions, old.StorageMkdirOptions>>();
assert<Identical<current.StorageRmdirOptions, old.StorageRmdirOptions>>();
assert<Identical<current.StorageRmOptions, old.StorageRmOptions>>();
assert<Identical<current.StorageCreateReadStreamOptions, old.StorageCreateReadStreamOptions>>();
assert<Identical<current.StorageCreateWriteStreamOptions, old.StorageCreateWriteStreamOptions>>();
assert<Identical<current.StorageError, old.StorageError>>();
assert<Identical<current.StorageErrorCode, old.StorageErrorCode>>();

// Every baseline export must exist (a missing one fails to compile above); the set of names is the same:
type OldNames = keyof typeof old;
type NewNames = keyof typeof current;
assert<Mutual<OldNames, NewNames>>();
