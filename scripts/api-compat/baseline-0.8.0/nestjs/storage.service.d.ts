import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Storage, StorageConfig } from '../core';
export declare class StorageService extends Storage implements OnModuleInit, OnModuleDestroy {
  constructor(config: StorageConfig);
  onModuleInit(): Promise<void>;
  onModuleDestroy(): Promise<void | undefined>;
}
