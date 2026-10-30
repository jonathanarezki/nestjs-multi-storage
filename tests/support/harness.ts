import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as util from 'util';
import { StorageModule, StorageModuleOptions, StorageService } from '../../lib';

export type BackendName = 'fileSystem' | 's3' | 'memory';

export const S3_ENDPOINT = process.env.S3_TEST_RESOLVED_ENDPOINT || '';
export const S3_BUCKET = 'test';

export interface Backend {
  name: BackendName;
  isS3: boolean;
  enabled: boolean;
}

export const FS_BACKEND: Backend = { name: 'fileSystem', isS3: false, enabled: true };
/** In-memory (memfs) backend: needs no Docker or credentials, so it always runs */
export const MEMORY_BACKEND: Backend = { name: 'memory', isS3: false, enabled: true };

export const S3_BACKEND: Backend = { name: 's3', isS3: true, enabled: !!S3_ENDPOINT };

/** Runs `define` once per backend (describe.each). S3 is registered as skipped when no S3 endpoint is available. */
export function describeBackends(title: string, define: (backend: Backend) => void) {
  describe.each([FS_BACKEND, MEMORY_BACKEND, ...(S3_BACKEND.enabled ? [S3_BACKEND] : [])])(
    `${title} [$name]`,
    (backend) => define(backend),
  );
  if (!S3_BACKEND.enabled) {
    describe.skip(`${title} [s3] (no S3 endpoint, see global setup)`, () => it('skipped', () => undefined));
  }
}

/** Defines S3-only suites; skipped when no S3 endpoint is available. */
export const describeS3 = S3_BACKEND.enabled ? describe : describe.skip;

export function s3Options(prefix: string, overrides: Partial<StorageModuleOptions> = {}): StorageModuleOptions {
  return {
    type: 's3',
    endpoint: S3_ENDPOINT,
    region: 'us-east-1',
    forcePathStyle: true,
    bucket: S3_BUCKET,
    accessKeyId: 'test',
    secretAccessKey: 'test',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    prefix,
    ...overrides,
  };
}

export interface Ctx {
  backend: Backend;
  service: StorageService;
  moduleRef: TestingModule;
  /** Prefix of this test: the tmp dir (fileSystem), the in-memory root (memory) or the S3 key prefix */
  prefix: string;
  /** The `path` Node-style errors carry for the given relative path */
  errPath(p: string): string;
  close(): Promise<void>;
}

/**
 * Creates an isolated StorageService through a real Nest testing module: a fresh tmp dir for the filesystem,
 * a unique key prefix for S3.
 */
export async function createCtx(
  backend: Backend,
  label: string,
  opts: { overrides?: Partial<StorageModuleOptions>; async?: boolean } = {},
): Promise<Ctx> {
  const slug = label.replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
  const memory = backend.name === 'memory';
  const prefix = backend.isS3
    ? `e2e/${slug}-${randomUUID().slice(0, 8)}`
    : memory
    ? `/e2e/${slug}-${randomUUID().slice(0, 8)}`
    : fs.mkdtempSync(path.join(os.tmpdir(), 'nestjs-multi-storage-e2e-'));
  const options: StorageModuleOptions = backend.isS3
    ? s3Options(prefix, opts.overrides)
    : { type: memory ? 'memory' : 'fileSystem', prefix, ...opts.overrides };

  const moduleRef = await Test.createTestingModule({
    imports: [
      opts.async ? StorageModule.forRootAsync({ useFactory: async () => options }) : StorageModule.forRoot(options),
    ],
  }).compile();
  await moduleRef.init();
  const service = moduleRef.get(StorageService);

  return {
    backend,
    service,
    moduleRef,
    prefix,
    errPath: (p) => (backend.isS3 ? p : path.join(prefix, p)),
    async close() {
      if (backend.isS3) {
        await service.rmdir('').catch(() => undefined);
      }
      await moduleRef.close();
      if (backend.name === 'fileSystem') {
        fs.rmSync(prefix, { recursive: true, force: true });
      }
    },
  };
}

/** Registers beforeEach/afterEach that hand every test its own Ctx. */
export function useCtx(backend: Backend, label: string, opts: Parameters<typeof createCtx>[2] = {}) {
  const holder = {} as { ctx: Ctx };
  beforeEach(async () => {
    holder.ctx = await createCtx(backend, `${label}-${expect.getState().currentTestName ?? ''}`, opts);
  });
  afterEach(async () => {
    await holder.ctx.close();
  });
  return holder;
}

export async function expectFsError(
  promise: Promise<unknown>,
  expected: { code: string; errno?: number; syscall: string; path?: string; dest?: string },
) {
  const error: any = await promise.then(
    () => undefined,
    (e) => e,
  );
  expect(util.types.isNativeError(error)).toBe(true);
  expect(error.code).toBe(expected.code);
  expect(error.syscall).toBe(expected.syscall);
  if (expected.errno !== undefined) expect(error.errno).toBe(expected.errno);
  if (expected.path !== undefined) expect(error.path).toBe(expected.path);
  if (expected.dest !== undefined) expect(error.dest).toBe(expected.dest);
  if (!expected.code.startsWith('ERR_')) expect(error.message).toContain(expected.code);
  return error;
}

export async function collect(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

/** Raw S3 keys below `Prefix` (all pages), bypassing the service. */
export async function rawKeys(service: StorageService, Prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let ContinuationToken: string | undefined;
  do {
    const out = await service.s3client!.send(
      new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix, ContinuationToken }),
    );
    keys.push(...(out.Contents ?? []).map((c) => c.Key!));
    ContinuationToken = out.NextContinuationToken;
  } while (ContinuationToken);
  return keys.sort();
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
