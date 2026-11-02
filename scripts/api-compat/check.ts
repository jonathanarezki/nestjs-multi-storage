/**
 * Type-level check: the public API of the built `nestjs-multi-storage` must stay assignable in both directions to the
 * 0.6.0 declarations (baseline-0.6.0). Run with `npm run check:api` (after `npm run build`).
 */
import * as current from 'nestjs-multi-storage';
import * as old from './baseline-0.6.0';

/** The public members only (private members make classes nominal, so they are compared separately). */
type Pub<T> = Pick<T, keyof T>;
type Mutual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** Compile error unless `T` is `true`. */
function assert<T extends true>(): T | void {
  return;
}

// Classes: instance members, constructor parameters, static members
// StorageService is now built on the core `Storage`, so it additionally exposes the public `init()` / `destroy()`
// (the only allowed additions: everything else must be identical). `disk()` returns a `StorageDisk` declared in
// another package than the baseline one, so (nominal, because of its private member) it is compared by its public members.
type ServiceRest<T> = Omit<Pub<T>, 'init' | 'destroy' | 'disk'>;
assert<Mutual<ServiceRest<current.StorageService>, ServiceRest<old.StorageService>>>();
assert<Mutual<Parameters<current.StorageService['disk']>, Parameters<old.StorageService['disk']>>>();
assert<Mutual<Pub<ReturnType<current.StorageService['disk']>>, Pub<ReturnType<old.StorageService['disk']>>>>();
assert<
  Mutual<ConstructorParameters<typeof current.StorageService>, ConstructorParameters<typeof old.StorageService>>
>();
assert<Mutual<Pub<current.StorageDisk>, Pub<old.StorageDisk>>>();
assert<Mutual<ConstructorParameters<typeof current.StorageDisk>, ConstructorParameters<typeof old.StorageDisk>>>();
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
assert<Mutual<typeof current.isStorageError, typeof old.isStorageError>>();

// Options and errors
assert<Mutual<current.StorageModuleOptions, old.StorageModuleOptions>>();
assert<Mutual<current.StorageDiskOptions, old.StorageDiskOptions>>();
assert<Mutual<current.StorageMultiDiskOptions, old.StorageMultiDiskOptions>>();
assert<Mutual<current.StorageConfig, old.StorageConfig>>();
assert<Mutual<current.StorageStats, old.StorageStats>>();
assert<Mutual<current.StorageBucketOptions, old.StorageBucketOptions>>();
assert<Mutual<current.StorageReadFileOptions, old.StorageReadFileOptions>>();
assert<Mutual<current.StorageWriteFileOptions, old.StorageWriteFileOptions>>();
assert<Mutual<current.StorageReaddirOptions, old.StorageReaddirOptions>>();
assert<Mutual<current.StorageMkdirOptions, old.StorageMkdirOptions>>();
assert<Mutual<current.StorageRmdirOptions, old.StorageRmdirOptions>>();
assert<Mutual<current.StorageRmOptions, old.StorageRmOptions>>();
assert<Mutual<current.StorageCreateReadStreamOptions, old.StorageCreateReadStreamOptions>>();
assert<Mutual<current.StorageCreateWriteStreamOptions, old.StorageCreateWriteStreamOptions>>();
assert<Mutual<current.StorageError, old.StorageError>>();
assert<Mutual<current.StorageErrorCode, old.StorageErrorCode>>();

// Every 0.6.0 type export must exist (a missing one fails to compile above); the set of names is the same:
type OldNames = keyof typeof old;
type NewNames = keyof typeof current;
assert<Mutual<OldNames, NewNames>>();
