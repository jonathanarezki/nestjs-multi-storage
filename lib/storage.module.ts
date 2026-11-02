import { DynamicModule, Module, Provider } from '@nestjs/common';
import { StorageService } from './storage.service';
import { getStorageToken } from './inject-storage.decorator';
import { StorageConfig } from './interfaces';
import { ASYNC_OPTIONS_TYPE, ConfigurableModuleClass, OPTIONS_TYPE } from './storage.module-definition';

function diskProvider(name: string): Provider {
  return {
    provide: getStorageToken(name),
    useFactory: (storage: StorageService) => storage.disk(name),
    inject: [StorageService],
  };
}

function withDisks(module: DynamicModule, names: string[]): DynamicModule {
  const providers = names.map((name) => diskProvider(name));
  return {
    ...module,
    providers: [...(module.providers ?? []), ...providers],
    exports: [...(module.exports ?? []), ...providers.map((provider) => (provider as { provide: string }).provide)],
  };
}

function diskNamesOf(config: StorageConfig): string[] {
  const disks = (config as { disks?: unknown }).disks;
  return typeof disks === 'object' && disks !== null ? Object.keys(disks) : ['default'];
}

@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule extends ConfigurableModuleClass {
  /** Registers `StorageService` (the default disk) and an injectable `StorageDisk` per disk (`@InjectStorage(name)`). */
  static forRoot(options: typeof OPTIONS_TYPE): DynamicModule {
    return withDisks(super.forRoot(options), diskNamesOf(options));
  }

  /**
   * The disk names are only known once the factory has run, so the injectable disks are registered from `disks`:
   * list the names you want to inject with `@InjectStorage(name)` (a listed name missing from the factory result
   * fails the bootstrap with the unknown-disk error). Without `disks`, no disk token is registered at all (injecting
   * `@InjectStorage(name)` then fails at bootstrap); `StorageService` and `storage.disk(name)` always work.
   */
  static forRootAsync(options: typeof ASYNC_OPTIONS_TYPE & { disks?: string[] }): DynamicModule {
    const { disks, ...asyncOptions } = options;
    return withDisks(super.forRootAsync(asyncOptions), disks ?? []);
  }
}
