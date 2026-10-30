import * as util from 'util';
import { describeBackends, describeS3, S3_BACKEND, createCtx, expectFsError, useCtx } from './support/harness';

describeBackends('stat', (backend) => {
  const h = useCtx(backend, 'stat');

  it('stats a file', async () => {
    const { service } = h.ctx;
    await service.writeFile('d.txt', 'hello');
    const st = await service.stat('d.txt');
    expect(st.isFile()).toBe(true);
    expect(st.isDirectory()).toBe(false);
    expect(st.isSymbolicLink()).toBe(false);
    expect(st.size).toBe(5);
    expect(util.types.isDate(st.mtime)).toBe(true);
    expect(Math.abs(st.mtimeMs - Date.now())).toBeLessThan(5 * 60 * 1000);
  });

  it('stats a folder (explicit and with content)', async () => {
    const { service } = h.ctx;
    await service.mkdir('mk/sub');
    await service.writeFile('mk/sub/f.txt', 'x');
    for (const p of ['mk', 'mk/sub']) {
      const st = await service.stat(p);
      expect(st.isDirectory()).toBe(true);
      expect(st.isFile()).toBe(false);
    }
  });

  it("stats the prefix root ('' and '.')", async () => {
    const { service } = h.ctx;
    for (const p of ['', '.']) {
      const st = await service.stat(p);
      expect(st.isDirectory()).toBe(true);
    }
  });

  it('rejects with a full ENOENT error for a missing path', async () => {
    const { service, errPath } = h.ctx;
    await expectFsError(service.stat('nope/zzz'), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'stat',
      path: errPath('nope/zzz'),
    });
  });

  it('exposes every fs.Stats key', async () => {
    const { service } = h.ctx;
    await service.writeFile('d.txt', 'hello');
    const st = await service.stat('d.txt');
    for (const key of [
      'dev',
      'ino',
      'mode',
      'nlink',
      'uid',
      'gid',
      'rdev',
      'size',
      'blksize',
      'blocks',
      'atimeMs',
      'mtimeMs',
      'ctimeMs',
      'birthtimeMs',
      'atime',
      'mtime',
      'ctime',
      'birthtime',
    ]) {
      expect(st).toHaveProperty(key);
    }
  });
});

describeS3('stat (S3 specifics)', () => {
  it('reports contentType and etag for files, and an implicit folder as directory', async () => {
    const ctx = await createCtx(S3_BACKEND, 'stat-s3');
    try {
      const { service } = ctx;
      await service.writeFile('d/a.txt', 'hello');
      await service.writeFile('d/b.bin', 'xx', { contentType: 'application/x-custom' });
      await service.writeFile('implicit/deep/f.txt', 'x');

      const a = await service.stat('d/a.txt');
      expect(a.contentType).toBe('text/plain');
      expect(a.etag).toMatch(/^[0-9a-f]{32}$/);
      expect(a.blocks).toBe(1);

      expect((await service.stat('d/b.bin')).contentType).toBe('application/x-custom');

      // no marker object exists for these folders
      expect((await service.stat('implicit')).isDirectory()).toBe(true);
      expect((await service.stat('implicit/deep')).isDirectory()).toBe(true);
      expect((await service.stat('implicit')).contentType).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });
});
