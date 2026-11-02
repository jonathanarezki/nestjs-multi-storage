import { DynamicModule } from '@nestjs/common';
import { ASYNC_OPTIONS_TYPE, ConfigurableModuleClass, OPTIONS_TYPE } from './storage.module-definition';
export declare class StorageModule extends ConfigurableModuleClass {
    static forRoot(options: typeof OPTIONS_TYPE): DynamicModule;
    static forRootAsync(options: typeof ASYNC_OPTIONS_TYPE & {
        disks?: string[];
    }): DynamicModule;
}
