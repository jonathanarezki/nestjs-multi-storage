import { describeBackends, describeS3, S3_BACKEND, createCtx } from './support/harness';
import { useCtx } from './support/harness';

describeBackends('readdir', (backend) => {
  const h = useCtx(backend, 'readdir');

  async function seed() {
    const { service } = h.ctx;
    await service.mkdir('t/a/b');
    await service.mkdir('t/c');
    await service.writeFile('t/a/b/1.txt', '1');
    await service.writeFile('t/a/2.txt', '2');
    await service.writeFile('t/3.txt', '3');
  }

  it('lists files and folders, non-recursive', async () => {
    await seed();
    expect((await h.ctx.service.readdir('t')).sort()).toEqual(['3.txt', 'a', 'c']);
    expect((await h.ctx.service.readdir('t/a')).sort()).toEqual(['2.txt', 'b']);
  });

  it('lists everything below a folder, recursive, folders included', async () => {
    await seed();
    const expected = ['3.txt', 'a', 'a/2.txt', 'a/b', 'a/b/1.txt', 'c'];
    expect((await h.ctx.service.readdir('t', { recursive: true })).sort()).toEqual(expected);
  });

  it('lists the prefix root', async () => {
    const { service } = h.ctx;
    expect(await service.readdir('')).toEqual([]);
    await service.writeFile('x.txt', 'x');
    expect(await service.readdir('')).toEqual(['x.txt']);
    expect(await service.readdir('.')).toEqual(['x.txt']);
  });

  if (backend.isS3) {
    it('returns S3 results sorted', async () => {
      const { service } = h.ctx;
      for (const name of ['b.txt', 'a.txt', 'C.txt', 'a2.txt', '_z.txt']) await service.writeFile(`s/${name}`, 'x');
      await service.writeFile('s/dir/inner.txt', 'x');
      const sorted = ['C.txt', '_z.txt', 'a.txt', 'a2.txt', 'b.txt', 'dir'].sort();
      expect(await service.readdir('s')).toEqual(sorted);
      const recursive = await service.readdir('s', { recursive: true });
      expect(recursive).toEqual([...recursive].sort());
      expect(recursive).toContain('dir/inner.txt');
    });
  }
});

describeS3('readdir / rmdir pagination (S3)', () => {
  it('handles more than 1000 entries (two pages) for readdir and rmdir', async () => {
    const ctx = await createCtx(S3_BACKEND, 'pagination');
    try {
      const { service } = ctx;
      const total = 1100;
      let next = 0;
      const worker = async () => {
        while (next < total) {
          const i = next++;
          await service.writeFile(`big/f${String(i).padStart(5, '0')}.txt`, 'x');
        }
      };
      await Promise.all(Array.from({ length: 50 }, worker));
      await service.writeFile('big/sub/inner.txt', 'x');
      await service.writeFile('big-sibling.txt', 'keep');

      const list = await service.readdir('big');
      expect(list).toHaveLength(total + 1);
      expect(list).toContain('sub');
      expect(list).toEqual([...list].sort());

      const recursive = await service.readdir('big', { recursive: true });
      expect(recursive).toHaveLength(total + 2);
      expect(recursive).toContain('sub/inner.txt');

      await service.rmdir('big');
      await expect(service.readdir('big')).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await service.exists('big/f00000.txt')).toBe(false);
      expect(await service.exists('big/f01099.txt')).toBe(false);
      expect(await service.exists('big-sibling.txt')).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  it('rm recursive deletes more than 1000 objects below a folder', async () => {
    const ctx = await createCtx(S3_BACKEND, 'pagination-rm');
    try {
      const { service } = ctx;
      let next = 0;
      const worker = async () => {
        while (next < 1100) await service.writeFile(`big/f${next++}.txt`, 'x');
      };
      await Promise.all(Array.from({ length: 50 }, worker));
      await service.rm('big', { recursive: true });
      expect(await service.exists('big')).toBe(false);
    } finally {
      await ctx.close();
    }
  });
});
