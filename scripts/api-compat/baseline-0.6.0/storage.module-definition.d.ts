import { StorageConfig } from './interfaces';
export declare const ConfigurableModuleClass: import("@nestjs/common").ConfigurableModuleCls<StorageConfig, "forRoot", "create", {
    isGlobal: boolean;
}>, MODULE_OPTIONS_TOKEN: string | symbol, OPTIONS_TYPE: StorageConfig & Partial<{
    isGlobal: boolean;
}>, ASYNC_OPTIONS_TYPE: import("@nestjs/common").ConfigurableModuleAsyncOptions<StorageConfig, "create"> & Partial<{
    isGlobal: boolean;
}>;
