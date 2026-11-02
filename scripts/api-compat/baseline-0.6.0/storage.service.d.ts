import { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { StorageConfig } from './interfaces';
import { StorageDisk } from './storage-disk';
export declare class StorageService extends StorageDisk implements OnModuleInit, OnModuleDestroy {
    private readonly drivers;
    private readonly disks;
    constructor(config: StorageConfig);
    get diskNames(): string[];
    disk(name: string): StorageDisk;
    onModuleInit(): Promise<void>;
    onModuleDestroy(): Promise<void | undefined>;
}
