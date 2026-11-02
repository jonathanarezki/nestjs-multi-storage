import { ListObjectsV2Command, NoSuchBucket } from '@aws-sdk/client-s3';
import { isStorageError, StorageError } from 'nestjs-multi-storage';
import { describeBackends, describeS3, S3_BACKEND, createCtx, useCtx } from './support/harness';

describeBackends('isStorageError', (backend) => {
  const h = useCtx(backend, 'storage-error');

  const failure = (promise: Promise<unknown>) =>
    promise.then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e,
    );

  it('recognizes ENOENT from readFile, with and without a code', async () => {
    const error = await failure(h.ctx.service.readFile('missing.txt'));
    expect(isStorageError(error)).toBe(true);
    expect(isStorageError(error, 'ENOENT')).toBe(true);
    expect(isStorageError(error, 'EEXIST')).toBe(false);
  });

  it('recognizes ENOENT from stat, with and without a code', async () => {
    const error = await failure(h.ctx.service.stat('missing.txt'));
    expect(isStorageError(error)).toBe(true);
    expect(isStorageError(error, 'ENOENT')).toBe(true);
    expect(isStorageError(error, 'ENOTDIR')).toBe(false);
  });

  it('narrows the type so that path, syscall and errno are usable', async () => {
    try {
      await h.ctx.service.readFile('missing.txt');
      throw new Error('expected a rejection');
    } catch (e) {
      if (isStorageError(e, 'ENOENT')) {
        const info: { code: string; path?: string; syscall?: string; errno?: number } = e;
        expect(info.path).toBe(h.ctx.errPath('missing.txt'));
        expect(info.syscall).toBe('open');
        return;
      }
      throw e;
    }
  });
});

describe('isStorageError (non-storage values)', () => {
  it('is false for a plain Error, null, undefined, strings and other primitives', () => {
    expect(isStorageError(new Error('plain'))).toBe(false);
    expect(isStorageError(null)).toBe(false);
    expect(isStorageError(undefined)).toBe(false);
    expect(isStorageError('ENOENT')).toBe(false);
    expect(isStorageError(42)).toBe(false);
    expect(isStorageError({ code: 'ENOENT' })).toBe(false);
    expect(isStorageError(new Error('x'), 'ENOENT')).toBe(false);
  });

  it('accepts a cross-realm style error (not instanceof Error) with a message and a string code', () => {
    const foreign = { message: 'ENOENT: no such file', code: 'ENOENT', path: '/x' };
    expect(isStorageError(foreign, 'ENOENT')).toBe(true);
    expect(isStorageError({ message: 'x', code: 12 })).toBe(false);
  });

  it('accepts any string for the code argument', () => {
    const error: StorageError = Object.assign(new Error('x'), { code: 'EACCES' });
    expect(isStorageError(error, 'EACCES')).toBe(true);
  });
});

describeS3('isStorageError (AWS SDK errors)', () => {
  it('is false for a real NoSuchBucket error from s3mock, and for the SDK class', async () => {
    const ctx = await createCtx(S3_BACKEND, 'nosuchbucket');
    try {
      const error: unknown = await ctx.service
        .s3client!.send(new ListObjectsV2Command({ Bucket: 'no-such-bucket-xyz' }))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(NoSuchBucket);
      expect((error as Error).name).toBe('NoSuchBucket');
      expect(isStorageError(error)).toBe(false);
      expect(isStorageError(error, 'NoSuchBucket')).toBe(false);

      const viaService: unknown = await ctx.service.readFile('a.txt', { bucket: 'no-such-bucket-xyz' }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(viaService).toBeInstanceOf(Error);
      expect(isStorageError(viaService)).toBe(false);
    } finally {
      await ctx.close();
    }
  });
});
