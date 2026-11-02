import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Storage, StorageConfig } from '@webbar/node-multi-storage';
import { MODULE_OPTIONS_TOKEN } from './storage.module-definition';

/**
 * The default disk (it has the whole file API itself) and the entry point to the other named disks.
 * A single-store configuration is one disk named `'default'`.
 */
@Injectable()
export class StorageService extends Storage implements OnModuleInit, OnModuleDestroy {
  constructor(@Inject(MODULE_OPTIONS_TOKEN) config: StorageConfig) {
    super(config);
  }

  async onModuleInit(): Promise<void> {
    await this.init();
  }

  async onModuleDestroy(): Promise<void | undefined> {
    await this.destroy();
  }
}
