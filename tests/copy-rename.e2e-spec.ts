import * as fs from 'fs';
import { HeadObjectCommand } from '@aws-sdk/client-s3';
import { randomBytes } from 'crypto';
import {
  Ctx,
  createCtx,
  describeBackends,
  describeS3,
  expectFsError,
  S3_BACKEND,
  rawKeys,
  S3_BUCKET,
  useCtx,
} from './support/harness';

const read = async (h: { ctx: { service: any } }, p: string) => (await h.ctx.service.readFile(p)).toString();

describeBackends('copyFile', (backend) => {
  const h = useCtx(backend, 'copy');

  it('copies a file and keeps the source', async () => {
    const { service } = h.ctx;
    await service.writeFile('c1.txt', 'one');
    await service.copyFile('c1.txt', 'c3.txt');
    expect(await read(h, 'c3.txt')).toBe('one');
    expect(await read(h, 'c1.txt')).toBe('one');
  });

  it('overwrites an existing destination', async () => {
    const { service } = h.ctx;
    await service.writeFile('c1.txt', 'one');
    await service.writeFile('c2.txt', 'two');
    await service.copyFile('c1.txt', 'c2.txt');
    expect(await read(h, 'c2.txt')).toBe('one');
  });

  it('COPYFILE_EXCL: EEXIST onto an existing file, fine onto a new one', async () => {
    const { service, errPath } = h.ctx;
    await service.writeFile('c1.txt', 'one');
    await service.writeFile('c2.txt', 'two');
    await expectFsError(service.copyFile('c1.txt', 'c2.txt', fs.constants.COPYFILE_EXCL), {
      code: 'EEXIST',
      errno: -17,
      syscall: 'copyfile',
      path: errPath('c1.txt'),
    });
    expect(await read(h, 'c2.txt')).toBe('two');
    await service.copyFile('c1.txt', 'c4.txt', fs.constants.COPYFILE_EXCL);
    expect(await read(h, 'c4.txt')).toBe('one');
  });

  it('missing source: ENOENT', async () => {
    const { service, errPath } = h.ctx;
    await expectFsError(service.copyFile('nope.txt', 'x.txt'), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'copyfile',
      path: errPath('nope.txt'),
      dest: errPath('x.txt'),
    });
  });

  it('folder source: EISDIR', async () => {
    const { service } = h.ctx;
    await service.mkdir('t');
    await service.writeFile('t/a.txt', 'a');
    await expectFsError(service.copyFile('t', 'x.txt'), { code: 'EISDIR', errno: -21, syscall: 'copyfile' });
  });

  it('destination is an existing folder: EISDIR', async () => {
    const { service, errPath } = h.ctx;
    await service.writeFile('c1.txt', 'one');
    await service.mkdir('dir');
    await service.writeFile('dir/keep.txt', 'k');
    await expectFsError(service.copyFile('c1.txt', 'dir'), {
      code: 'EISDIR',
      errno: -21,
      syscall: 'copyfile',
      path: errPath('c1.txt'),
      dest: errPath('dir'),
    });
    expect(await read(h, 'dir/keep.txt')).toBe('k');
    expect(await service.readdir('dir')).toEqual(['keep.txt']);
  });

  it('copy onto itself leaves the file intact', async () => {
    const { service } = h.ctx;
    await service.writeFile('c1.txt', 'one');
    await service.copyFile('c1.txt', 'c1.txt');
    expect(await read(h, 'c1.txt')).toBe('one');
  });

  it('handles unicode and space keys', async () => {
    const { service } = h.ctx;
    await service.mkdir('a b');
    await service.writeFile('a b/ü.txt', 'üü');
    await service.copyFile('a b/ü.txt', 'a b/ö copy+1 (2).txt');
    expect(await read(h, 'a b/ö copy+1 (2).txt')).toBe('üü');
    expect((await service.readdir('a b')).sort()).toEqual(['ö copy+1 (2).txt', 'ü.txt'].sort());
  });
});

describeBackends('rename', (backend) => {
  const h = useCtx(backend, 'rename');

  it('renames a file', async () => {
    const { service } = h.ctx;
    await service.writeFile('r1.txt', 'r1');
    await service.rename('r1.txt', 'r2.txt');
    expect(await service.exists('r1.txt')).toBe(false);
    expect(await read(h, 'r2.txt')).toBe('r1');
  });

  it('moves a file into a folder and overwrites an existing file', async () => {
    const { service } = h.ctx;
    await service.mkdir('rd');
    await service.writeFile('r2.txt', 'r2');
    await service.rename('r2.txt', 'rd/r2.txt');
    expect(await service.readdir('rd')).toEqual(['r2.txt']);
    await service.writeFile('r5.txt', 'new');
    await service.rename('r5.txt', 'rd/r2.txt');
    expect(await read(h, 'rd/r2.txt')).toBe('new');
    expect(await service.exists('r5.txt')).toBe(false);
  });

  it('renaming onto itself is a no-op', async () => {
    const { service } = h.ctx;
    await service.writeFile('c1.txt', 'one');
    await service.rename('c1.txt', 'c1.txt');
    expect(await read(h, 'c1.txt')).toBe('one');
  });

  it('file onto a folder: EISDIR', async () => {
    const { service, errPath } = h.ctx;
    await service.writeFile('c1.txt', 'one');
    await service.mkdir('rd');
    await expectFsError(service.rename('c1.txt', 'rd'), {
      code: 'EISDIR',
      errno: -21,
      syscall: 'rename',
      path: errPath('c1.txt'),
      dest: errPath('rd'),
    });
    expect(await read(h, 'c1.txt')).toBe('one');
  });

  it('handles unicode and space keys', async () => {
    const { service } = h.ctx;
    await service.mkdir('a b');
    await service.writeFile('a b/ü.txt', 'üü');
    await service.rename('a b/ü.txt', 'a b/ß ü.txt');
    expect(await service.readdir('a b')).toEqual(['ß ü.txt']);
    expect(await read(h, 'a b/ß ü.txt')).toBe('üü');
  });

  describe('folders', () => {
    beforeEach(async () => {
      const { service } = h.ctx;
      await service.mkdir('fo/sub');
      await service.writeFile('fo/sub/x.txt', 'x');
      await service.writeFile('fo/y.txt', 'y');
      await service.mkdir('par');
    });

    it('moves a folder with nested content', async () => {
      const { service } = h.ctx;
      await service.rename('fo', 'par/fo2');
      expect((await service.readdir('par', { recursive: true })).sort()).toEqual(
        ['fo2', 'fo2/sub', 'fo2/sub/x.txt', 'fo2/y.txt'].sort(),
      );
      expect(await read(h, 'par/fo2/sub/x.txt')).toBe('x');
      expect(await service.exists('fo')).toBe(false);
      await expectFsError(service.stat('fo'), { code: 'ENOENT', syscall: 'stat' });
    });

    it('into itself: EINVAL', async () => {
      const { service, errPath } = h.ctx;
      await service.rename('fo', 'par/fo2');
      await expectFsError(service.rename('par', 'par/fo2/inner'), {
        code: 'EINVAL',
        errno: -22,
        syscall: 'rename',
        path: errPath('par'),
        dest: errPath('par/fo2/inner'),
      });
      expect(await read(h, 'par/fo2/y.txt')).toBe('y');
    });

    it('onto a non-empty folder: ENOTEMPTY', async () => {
      const { service, errPath } = h.ctx;
      await service.mkdir('ne/k');
      await service.writeFile('ne/k/z.txt', 'z');
      await expectFsError(service.rename('fo', 'ne'), {
        code: 'ENOTEMPTY',
        errno: -39,
        syscall: 'rename',
        path: errPath('fo'),
        dest: errPath('ne'),
      });
      expect(await read(h, 'fo/y.txt')).toBe('y');
    });

    it('onto a file: ENOTDIR', async () => {
      const { service, errPath } = h.ctx;
      await service.writeFile('c1.txt', 'one');
      await expectFsError(service.rename('fo', 'c1.txt'), {
        code: 'ENOTDIR',
        errno: -20,
        syscall: 'rename',
        path: errPath('fo'),
        dest: errPath('c1.txt'),
      });
    });

    it('onto an empty folder', async () => {
      const { service } = h.ctx;
      await service.mkdir('emp');
      await service.rename('fo', 'emp');
      expect((await service.readdir('emp', { recursive: true })).sort()).toEqual(['sub', 'sub/x.txt', 'y.txt']);
      expect(await service.exists('fo')).toBe(false);
    });
  });

  it('missing source: ENOENT', async () => {
    const { service, errPath } = h.ctx;
    await expectFsError(service.rename('nope', 'nope2'), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'rename',
      path: errPath('nope'),
      dest: errPath('nope2'),
    });
  });
});

describeBackends('missing parent folder', (backend) => {
  const h = useCtx(backend, 'noparent');

  if (backend.isS3) {
    // Folders are implicit on S3, so there is nothing that could be missing
    it('writeFile, copyFile and rename succeed on S3 (by design)', async () => {
      const { service } = h.ctx;
      await service.writeFile('no/parent/a.txt', 'a');
      expect(await service.readFile('no/parent/a.txt').then(String)).toBe('a');
      await service.copyFile('no/parent/a.txt', 'other/parent/b.txt');
      await service.rename('other/parent/b.txt', 'third/c.txt');
      expect(await service.readFile('third/c.txt').then(String)).toBe('a');
      expect((await service.stat('no')).isDirectory()).toBe(true);
    });
  } else {
    it('writeFile, copyFile and rename are ENOENT on the filesystem', async () => {
      const { service, errPath } = h.ctx;
      await service.writeFile('a.txt', 'a');
      await expectFsError(service.writeFile('no/parent/a.txt', 'a'), { code: 'ENOENT', syscall: 'open' });
      await expectFsError(service.copyFile('a.txt', 'no/b.txt'), {
        code: 'ENOENT',
        syscall: 'copyfile',
        path: errPath('a.txt'),
      });
      await expectFsError(service.rename('a.txt', 'no/b.txt'), {
        code: 'ENOENT',
        syscall: 'rename',
        path: errPath('a.txt'),
      });
    });
  }
});

describeS3('multipart copy (S3)', () => {
  it('copies and renames a 12 MiB file in 5 MiB parts, keeping bytes and ContentType', async () => {
    const ctx = await createCtx(S3_BACKEND, 'multipart');
    try {
      const { service } = ctx;
      (service as any).copyThreshold = 5 * 1024 * 1024;
      (service as any).copyPartSize = 5 * 1024 * 1024;
      const parts: string[] = [];
      service.s3client!.middlewareStack.add(
        (next, context) => async (args) => {
          if (context.commandName === 'UploadPartCopyCommand') parts.push(String((args.input as any).CopySourceRange));
          return next(args);
        },
        { step: 'initialize', name: 'recordParts' },
      );

      const big = randomBytes(12 * 1024 * 1024);
      await service.writeFile('big.bin', big, { contentType: 'application/x-custom' });

      const contentType = async (key: string) =>
        (await service.s3client!.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: `${ctx.prefix}/${key}` })))
          .ContentType;

      await service.copyFile('big.bin', 'big2.bin');
      expect(parts).toEqual(['bytes=0-5242879', 'bytes=5242880-10485759', 'bytes=10485760-12582911']);
      expect((await service.readFile('big2.bin')).equals(big)).toBe(true);
      expect(await contentType('big2.bin')).toBe('application/x-custom');
      expect((await service.stat('big2.bin')).size).toBe(big.length);

      await expectFsError(service.copyFile('big.bin', 'big2.bin', fs.constants.COPYFILE_EXCL), {
        code: 'EEXIST',
        syscall: 'copyfile',
      });

      await service.rename('big2.bin', 'big3.bin');
      expect((await service.readFile('big3.bin')).equals(big)).toBe(true);
      expect(await contentType('big3.bin')).toBe('application/x-custom');
      expect(await service.exists('big2.bin')).toBe(false);
      expect(await service.exists('big.bin')).toBe(true);
    } finally {
      await ctx.close();
    }
  });
});

describeS3('failed folder rename rolls back (S3)', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await createCtx(S3_BACKEND, 'rollback');
  });
  afterEach(async () => {
    await ctx.close();
  });

  const files = Array.from({ length: 12 }, (_, i) => `src/f${String(i).padStart(2, '0')}.txt`);
  const keys = (names: string[]) => names.map((n) => `${ctx.prefix}/${n}`);

  /** Fails the Nth CopyObject (1-based) and, when `failDeletes`, every DeleteObjects; `remove()` lifts the fault. */
  function injectFault(nth: number, failDeletes = false) {
    let copies = 0;
    ctx.service.s3client!.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === 'CopyObjectCommand' && ++copies === nth) {
          throw Object.assign(new Error('injected copy failure'), { code: 'EINJECTED' });
        }
        if (failDeletes && context.commandName === 'DeleteObjectsCommand') {
          throw new Error('injected delete failure');
        }
        return next(args);
      },
      { step: 'initialize', name: 'fault' },
    );
    return () => ctx.service.s3client!.middlewareStack.remove('fault');
  }

  const seed = async (withMarker = false) => {
    if (withMarker) await ctx.service.mkdir('src');
    for (const f of files) await ctx.service.writeFile(f, f);
  };

  it('leaves the destination empty and the source intact, rethrows the original error, retry succeeds', async () => {
    const { service } = ctx;
    await seed(true);
    const before = await rawKeys(service, `${ctx.prefix}/`);
    const remove = injectFault(6);

    const error: any = await service.rename('src', 'dst').then(
      () => undefined,
      (e) => e,
    );
    expect(error?.message).toBe('injected copy failure');
    expect(error.code).toBe('EINJECTED');
    expect(error.cleanupError).toBeUndefined();

    expect(await rawKeys(service, `${ctx.prefix}/`)).toEqual(before);
    expect(await rawKeys(service, `${ctx.prefix}/dst`)).toEqual([]);
    expect(await service.exists('dst')).toBe(false);
    expect((await service.readdir('src')).length).toBe(files.length);

    remove();
    await service.rename('src', 'dst');
    expect(await service.exists('src')).toBe(false);
    expect((await service.readdir('dst')).length).toBe(files.length);
    expect(await read({ ctx }, 'dst/f03.txt')).toBe('src/f03.txt');
  });

  it('keeps a pre-existing empty destination folder (its marker) and nothing else', async () => {
    const { service } = ctx;
    await seed(true);
    await service.mkdir('dst');
    const before = await rawKeys(service, `${ctx.prefix}/`);
    expect(before).toContain(`${ctx.prefix}/dst/`);
    const remove = injectFault(4);

    await expect(service.rename('src', 'dst')).rejects.toThrow('injected copy failure');
    expect(await rawKeys(service, `${ctx.prefix}/`)).toEqual(before);
    expect(await service.readdir('dst')).toEqual([]);

    remove();
    await service.rename('src', 'dst');
    expect((await service.readdir('dst')).length).toBe(files.length);
    expect(await service.exists('src')).toBe(false);
  });

  it('never deletes keys it did not write: unrelated objects next to the destination survive', async () => {
    const { service } = ctx;
    await seed();
    await service.writeFile('dst2/keep.txt', 'keep');
    await service.writeFile('dst-sibling.txt', 'keep');
    const remove = injectFault(3);

    await expect(service.rename('src', 'dst')).rejects.toThrow('injected copy failure');
    expect(await rawKeys(service, `${ctx.prefix}/dst`)).toEqual(keys(['dst-sibling.txt', 'dst2/keep.txt']));
    remove();
  });

  it('a failing cleanup still rethrows the original error and attaches cleanupError', async () => {
    const { service } = ctx;
    await seed();
    injectFault(6, true);

    const error: any = await service.rename('src', 'dst').then(
      () => undefined,
      (e) => e,
    );
    expect(error?.message).toBe('injected copy failure');
    expect(error.cleanupError).toBeInstanceOf(Error);
    expect(error.cleanupError.message).toBe('injected delete failure');
    // The source is untouched either way
    expect((await service.readdir('src')).length).toBe(files.length);
  });

  it('rolls back in batches of up to 1000 keys', async () => {
    const { service } = ctx;
    const many = Array.from({ length: 1100 }, (_, i) => `big/f${String(i).padStart(4, '0')}.txt`);
    for (let i = 0; i < many.length; i += 100) {
      await Promise.all(many.slice(i, i + 100).map((f) => service.writeFile(f, 'x')));
    }
    const batches: number[] = [];
    service.s3client!.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === 'DeleteObjectsCommand') batches.push((args.input as any).Delete.Objects.length);
        return next(args);
      },
      { step: 'initialize', name: 'batches' },
    );
    injectFault(1100);

    await expect(service.rename('big', 'big2')).rejects.toThrow('injected copy failure');
    expect(batches).toEqual([1000, 100]);
    expect(await rawKeys(service, `${ctx.prefix}/big2`)).toEqual([]);
    expect((await service.readdir('big')).length).toBe(1100);
  }, 120_000);

  it('single file: a failed copy changes nothing', async () => {
    const { service } = ctx;
    await service.writeFile('one.txt', 'one');
    const remove = injectFault(1);
    await expect(service.rename('one.txt', 'two.txt')).rejects.toThrow('injected copy failure');
    expect(await rawKeys(service, `${ctx.prefix}/`)).toEqual(keys(['one.txt']));
    remove();
    await service.rename('one.txt', 'two.txt');
    expect(await rawKeys(service, `${ctx.prefix}/`)).toEqual(keys(['two.txt']));
  });
});

describeS3('rename request count (S3), as documented in the README', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await createCtx(S3_BACKEND, 'rename-count');
  });
  afterEach(async () => {
    await ctx.close();
  });

  const count = async (action: () => Promise<unknown>) => {
    const commands: string[] = [];
    ctx.service.s3client!.middlewareStack.add(
      (next, context) => async (args) => {
        commands.push(context.commandName!);
        return next(args);
      },
      { step: 'initialize', name: 'count' },
    );
    await action();
    ctx.service.s3client!.middlewareStack.remove('count');
    return commands;
  };

  it('file: 4 requests, to a new name and over an existing file', async () => {
    const { service } = ctx;
    await service.writeFile('a.txt', 'a');
    const expected = ['ListObjectsV2Command', 'ListObjectsV2Command', 'CopyObjectCommand', 'DeleteObjectCommand'];
    expect(await count(() => service.rename('a.txt', 'b.txt'))).toEqual(expected);
    await service.writeFile('c.txt', 'c');
    expect(await count(() => service.rename('c.txt', 'b.txt'))).toEqual(expected);
  });

  it('folder with n objects: n + 2 * ceil(n / 1000) + 6, with or without a marker', async () => {
    const { service } = ctx;
    await service.mkdir('m');
    for (let i = 0; i < 12; i++) await service.writeFile(`m/${i}.txt`, 'x');
    // n = 13 objects (12 files and the marker)
    expect(await count(() => service.rename('m', 'm2'))).toHaveLength(13 + 2 + 6);

    for (let i = 0; i < 12; i++) await service.writeFile(`i/${i}.txt`, 'x');
    // implicit folder (no marker): n = 12
    expect(await count(() => service.rename('i', 'i2'))).toHaveLength(12 + 2 + 6);
  });
});
