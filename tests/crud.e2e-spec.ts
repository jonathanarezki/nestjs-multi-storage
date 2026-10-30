import { describeBackends, expectFsError, useCtx } from './support/harness';

describeBackends('basic CRUD', (backend) => {
  const h = useCtx(backend, 'crud');

  it('writes and reads a string and a Buffer', async () => {
    const { service } = h.ctx;
    await service.writeFile('a.txt', 'hello');
    expect((await service.readFile('a.txt')).toString()).toBe('hello');

    const bytes = Buffer.from([0, 1, 2, 253, 254, 255]);
    await service.writeFile('b.bin', bytes);
    expect((await service.readFile('b.bin')).equals(bytes)).toBe(true);
  });

  it('overwrites an existing file', async () => {
    const { service } = h.ctx;
    await service.writeFile('a.txt', 'one');
    await service.writeFile('a.txt', 'two');
    expect((await service.readFile('a.txt')).toString()).toBe('two');
  });

  it('reads a missing file as ENOENT (open)', async () => {
    const { service, errPath } = h.ctx;
    await expectFsError(service.readFile('missing.txt'), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'open',
      path: errPath('missing.txt'),
    });
  });

  it('exists: file, folder and missing path', async () => {
    const { service } = h.ctx;
    await service.mkdir('d');
    await service.writeFile('d/f.txt', 'x');
    expect(await service.exists('d/f.txt')).toBe(true);
    expect(await service.exists('d')).toBe(true);
    expect(await service.exists('nope')).toBe(false);
    expect(await service.exists('d/nope.txt')).toBe(false);
  });

  it('rm removes a file', async () => {
    const { service } = h.ctx;
    await service.writeFile('a.txt', 'x');
    await service.rm('a.txt');
    expect(await service.exists('a.txt')).toBe(false);
  });

  it('rm of a missing file is ENOENT (lstat) unless force is set', async () => {
    const { service, errPath } = h.ctx;
    await expectFsError(service.rm('missing.txt'), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'lstat',
      path: errPath('missing.txt'),
    });
    await expect(service.rm('missing.txt', { force: true })).resolves.toBeUndefined();
  });

  it('mkdir creates (nested) folders and rmdir removes them with their content', async () => {
    const { service } = h.ctx;
    await service.mkdir('p/q');
    expect(await service.exists('p/q')).toBe(true);
    expect(await service.readdir('p/q')).toEqual([]);
    await service.writeFile('p/q/f.txt', 'x');
    await service.writeFile('p/g.txt', 'y');

    await service.rmdir('p');
    expect(await service.exists('p')).toBe(false);
    expect(await service.exists('p/q/f.txt')).toBe(false);
  });

  it('mkdir on an existing folder is fine', async () => {
    const { service } = h.ctx;
    await service.mkdir('d');
    await service.mkdir('d');
    expect(await service.exists('d')).toBe(true);
  });

  it('rmdir of an empty folder works', async () => {
    const { service } = h.ctx;
    await service.mkdir('empty');
    await service.rmdir('empty');
    expect(await service.exists('empty')).toBe(false);
  });

  it('does not touch siblings with a common name prefix', async () => {
    const { service } = h.ctx;
    await service.mkdir('d');
    await service.mkdir('d2');
    await service.writeFile('d/a.txt', 'x');
    await service.writeFile('d2/a.txt', 'y');
    await service.rmdir('d');
    expect((await service.readFile('d2/a.txt')).toString()).toBe('y');
  });

  it('error shape of a missing stat target', async () => {
    const { service, errPath } = h.ctx;
    const error = await expectFsError(service.stat('missing/q.txt'), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'stat',
      path: errPath('missing/q.txt'),
    });
    expect(error.message).toBe(`ENOENT: no such file or directory, stat '${errPath('missing/q.txt')}'`);
  });
});
