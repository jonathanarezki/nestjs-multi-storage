import 'reflect-metadata';
import { Inject, Injectable, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StorageModule, StorageModuleOptions, StorageService } from 'nestjs-multi-storage';
import { describeS3, s3Options } from './support/harness';

@Injectable()
class TestConfig {
  constructor(public readonly options: StorageModuleOptions) {}
}

function configModule(options: StorageModuleOptions) {
  @Module({ providers: [{ provide: TestConfig, useValue: new TestConfig(options) }], exports: [TestConfig] })
  class TestConfigModule {}
  return TestConfigModule;
}

@Injectable()
class Consumer {
  constructor(@Inject(StorageService) public readonly storage: StorageService) {}
}

@Module({ providers: [Consumer], exports: [Consumer] })
class ConsumerModule {}

describe('StorageModule wiring', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nestjs-multi-storage-module-'));
  });
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('forRoot (fileSystem): provides a working StorageService without an S3 client', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot({ type: 'fileSystem', prefix: tmp })],
    }).compile();
    await moduleRef.init();
    const service = moduleRef.get(StorageService);
    expect(service.s3client).toBeUndefined();
    await service.writeFile('a.txt', 'hello');
    expect(fs.readFileSync(path.join(tmp, 'a.txt'), 'utf8')).toBe('hello');
    await moduleRef.close();
  });

  it('forRoot (memory): provides a working StorageService without an S3 client or any disk access', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot({ type: 'memory', prefix: path.join(tmp, 'never-created') })],
    }).compile();
    await moduleRef.init();
    const service = moduleRef.get(StorageService);
    expect(service.s3client).toBeUndefined();
    await service.writeFile('a.txt', 'hello');
    expect(await service.readFile('a.txt', 'utf8')).toBe('hello');
    expect(fs.readdirSync(tmp)).toEqual([]);
    await moduleRef.close();
  });

  it('forRootAsync (useFactory with injection): resolves options lazily', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRootAsync({
          useFactory: (config: TestConfig) => config.options,
          inject: [TestConfig],
          imports: [configModule({ type: 'fileSystem', prefix: tmp })],
        }),
      ],
    }).compile();
    await moduleRef.init();
    const service = moduleRef.get(StorageService);
    await service.mkdir('d');
    expect(fs.statSync(path.join(tmp, 'd')).isDirectory()).toBe(true);
    await moduleRef.close();
  });

  it('is only visible to importing modules unless isGlobal is set', async () => {
    await expect(
      Test.createTestingModule({
        imports: [StorageModule.forRoot({ type: 'fileSystem', prefix: tmp }), ConsumerModule],
      }).compile(),
    ).rejects.toThrow(/StorageService/);

    const global = await Test.createTestingModule({
      imports: [StorageModule.forRoot({ type: 'fileSystem', prefix: tmp, isGlobal: true }), ConsumerModule],
    }).compile();
    await global.init();
    expect(global.get(Consumer).storage).toBe(global.get(StorageService));
    await global.close();
  });
});

describeS3('StorageModule lifecycle (S3)', () => {
  it('forRoot: creates the client on init and destroys it on close', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot(s3Options('e2e/module-forroot'))],
    }).compile();
    const service = moduleRef.get(StorageService);
    expect(service.s3client).toBeUndefined();

    await moduleRef.init();
    const client = service.s3client!;
    expect(client).toBeDefined();
    const destroy = jest.spyOn(client, 'destroy');

    await service.writeFile('lifecycle.txt', 'x');
    expect(destroy).not.toHaveBeenCalled();
    await service.rmdir('');
    await moduleRef.close();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('forRootAsync (useFactory, async, with injected provider): same lifecycle and works end to end', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        StorageModule.forRootAsync({
          useFactory: async (config: TestConfig) => {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return config.options;
          },
          inject: [TestConfig],
          imports: [configModule(s3Options('e2e/module-async'))],
        }),
      ],
    }).compile();
    await moduleRef.init();
    const service = moduleRef.get(StorageService);
    expect(service.s3client).toBeDefined();
    const destroy = jest.spyOn(service.s3client!, 'destroy');

    await service.writeFile('a/b.txt', 'async');
    expect(await service.readdir('a')).toEqual(['b.txt']);
    expect((await service.readFile('a/b.txt')).toString()).toBe('async');
    await service.rmdir('');

    await moduleRef.close();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
