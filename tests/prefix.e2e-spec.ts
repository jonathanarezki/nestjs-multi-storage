import { randomUUID } from 'crypto';
import { createCtx, describeBackends, expectFsError, describeS3, rawKeys, S3_BACKEND, useCtx } from './support/harness';

const ESCAPES = /escapes the storage prefix/;

describeBackends('prefix', (backend) => {
  const h = useCtx(backend, 'prefix');

  describe.each(['../x', 'a/../../x', '..'])('path %p escapes the prefix', (p) => {
    it('rejects every promise-based method', async () => {
      const { service } = h.ctx;
      await service.writeFile('ok.txt', 'ok');
      await expect(service.writeFile(p, 'x')).rejects.toThrow(ESCAPES);
      await expect(service.readFile(p)).rejects.toThrow(ESCAPES);
      await expect(service.readdir(p)).rejects.toThrow(ESCAPES);
      await expect(service.readdir(p, { recursive: true })).rejects.toThrow(ESCAPES);
      await expect(service.rmdir(p)).rejects.toThrow(ESCAPES);
      await expect(service.mkdir(p)).rejects.toThrow(ESCAPES);
      await expect(service.exists(p)).rejects.toThrow(ESCAPES);
      await expect(service.rm(p)).rejects.toThrow(ESCAPES);
      await expect(service.stat(p)).rejects.toThrow(ESCAPES);
      await expect(service.copyFile(p, 'ok.txt')).rejects.toThrow(ESCAPES);
      await expect(service.copyFile('ok.txt', p)).rejects.toThrow(ESCAPES);
      await expect(service.rename(p, 'ok.txt')).rejects.toThrow(ESCAPES);
      await expect(service.rename('ok.txt', p)).rejects.toThrow(ESCAPES);
    });

    it('throws synchronously from createReadStream and createWriteStream', () => {
      const { service } = h.ctx;
      expect(() => service.createReadStream(p)).toThrow(ESCAPES);
      expect(() => service.createWriteStream(p)).toThrow(ESCAPES);
    });
  });

  it('does not write anything outside the prefix when a path escapes', async () => {
    const { service } = h.ctx;
    await expect(service.writeFile('../escaped.txt', 'x')).rejects.toThrow(ESCAPES);
    await expect(service.readdir('')).resolves.toEqual([]);
  });

  it('allows paths that stay inside the prefix', async () => {
    const { service } = h.ctx;
    expect(await service.readdir('')).toEqual([]);
    expect(await service.readdir('.')).toEqual([]);

    await service.mkdir('d');
    await service.writeFile('a/../b.txt', '1');
    await service.writeFile('/a.txt', '2');
    await service.writeFile('d/c.txt', '3');
    expect((await service.readdir('')).sort()).toEqual(['a.txt', 'b.txt', 'd']);
    expect(await service.readdir('d')).toEqual(['c.txt']);
    expect(await service.exists('b.txt')).toBe(true);
    expect(await service.exists('/a.txt')).toBe(true);
    expect((await service.readFile('./d/../d/c.txt')).toString()).toBe('3');
  });

  it('does not treat a sibling that merely shares the prefix string as inside', async () => {
    const { service, prefix } = h.ctx;
    const sibling = `../${prefix.split('/').pop()}2/x`;
    await expect(service.writeFile(sibling, 'x')).rejects.toThrow(ESCAPES);
  });
});

describeS3('prefix normalisation (S3)', () => {
  it("'/pfx/', 'pfx', 'pfx/' and '\\pfx' produce identical keys", async () => {
    const root = `e2e/prefix-${randomUUID().slice(0, 8)}`;
    const variants = [`/${root}/`, root, `${root}/`, `\\${root.replace(/\//g, '/')}`];
    const contexts = [];
    try {
      for (const [i, prefix] of variants.entries()) {
        const ctx = await createCtx(S3_BACKEND, `pfx-${i}`, { overrides: { prefix } });
        contexts.push(ctx);
        await ctx.service.writeFile('file.txt', 'x');
        await ctx.service.writeFile('/o.txt', 'x');
        await ctx.service.mkdir('dir');
      }
      expect(await rawKeys(contexts[0].service, root)).toEqual([`${root}/dir/`, `${root}/file.txt`, `${root}/o.txt`]);
      // every variant sees the same objects
      for (const ctx of contexts) {
        expect(await ctx.service.readdir('')).toEqual(['dir', 'file.txt', 'o.txt']);
      }
    } finally {
      for (const ctx of contexts) await ctx.service.rmdir('').catch(() => undefined);
      await Promise.all(contexts.map((ctx) => ctx.moduleRef.close()));
    }
  });

  it("a leading '/' maps to the same raw key under the prefix", async () => {
    const ctx = await createCtx(S3_BACKEND, 'prefix-slash');
    try {
      await ctx.service.writeFile('/a.txt', 'slash');
      expect(await ctx.service.readFile('a.txt', 'utf8')).toBe('slash');
      await ctx.service.writeFile('a.txt', 'plain');
      await ctx.service.writeFile('//b.txt', 'b');
      await ctx.service.mkdir('/d');
      expect(await rawKeys(ctx.service, ctx.prefix)).toEqual([
        `${ctx.prefix}/a.txt`,
        `${ctx.prefix}/b.txt`,
        `${ctx.prefix}/d/`,
      ]);
      expect(await ctx.service.readdir('/')).toEqual(await ctx.service.readdir(''));
      expect((await ctx.service.stat('/')).isDirectory()).toBe(true);
      await expectFsError(ctx.service.writeFile('/', 'x'), { code: 'EISDIR', syscall: 'open' });
      await expectFsError(ctx.service.writeFile('', 'x'), { code: 'EISDIR', syscall: 'open' });
      expect(await rawKeys(ctx.service, ctx.prefix)).toHaveLength(3);
    } finally {
      await ctx.close();
    }
  });

  it("'/../x' escapes the prefix like '../x'", async () => {
    const ctx = await createCtx(S3_BACKEND, 'prefix-slash-escape');
    try {
      for (const p of ['/../x', '//../x', '/a/../../x', '/..']) {
        await expect(ctx.service.writeFile(p, 'x')).rejects.toThrow(ESCAPES);
        await expect(ctx.service.readFile(p)).rejects.toThrow(ESCAPES);
        await expect(ctx.service.readdir(p)).rejects.toThrow(ESCAPES);
        await expect(ctx.service.getSignedUrl(p)).rejects.toThrow(ESCAPES);
        expect(() => ctx.service.createReadStream(p)).toThrow(ESCAPES);
      }
    } finally {
      await ctx.close();
    }
  });

  it('keeps data under the prefix and never above it', async () => {
    const ctx = await createCtx(S3_BACKEND, 'prefix-keys');
    try {
      await ctx.service.writeFile('a/hello.txt', 'hi');
      expect(await rawKeys(ctx.service, ctx.prefix)).toEqual([`${ctx.prefix}/a/hello.txt`]);
    } finally {
      await ctx.close();
    }
  });
});
