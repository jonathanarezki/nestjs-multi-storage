import { Inject } from '@nestjs/common';

/** The injection token of the disk `name` (what `@InjectStorage(name)` injects). */
export function getStorageToken(name: string): string {
  return `nestjs-multi-storage:disk:${name}`;
}

/** Injects the `StorageDisk` configured under `name`. */
export const InjectStorage = (name: string) => Inject(getStorageToken(name));
