import * as fs from 'fs';
import * as path from 'path';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import { createStorage } from '@webbar/node-multi-storage';
import { StorageDisk, StorageModule, StorageService } from 'nestjs-multi-storage';
import {
  collect,
  createCtx,
  describeBackends,
  describeS3,
  expectFsError,
  S3_BACKEND,
  S3_BUCKET,
  s3Internals,
  s3Options,
  useCtx,
} from './support/harness';

/** writeFile that creates the parent folder first, as fs requires */
async function put(service: StorageDisk, p: string, data: Parameters<StorageService['writeFile']>[1], options?: any) {
  await service.mkdir(path.dirname(p));
  await service.writeFile(p, data, options);
}

describeBackends('readFile / writeFile encodings', (backend) => {
  const h = useCtx(backend, 'encodings');

  it('readFile returns a string for an encoding (as string or option) and a Buffer otherwise', async () => {
    const { service } = h.ctx;
    await put(service, 'a.txt', 'héllo');
    expect(await service.readFile('a.txt', 'utf8')).toBe('héllo');
    expect(await service.readFile('a.txt', { encoding: 'utf8' })).toBe('héllo');
    expect(await service.readFile('a.txt', { encoding: 'base64' })).toBe(Buffer.from('héllo').toString('base64'));
    expect(await service.readFile('a.txt', { encoding: 'hex' })).toBe(Buffer.from('héllo').toString('hex'));
    expect(Buffer.isBuffer(await service.readFile('a.txt'))).toBe(true);
    expect(Buffer.isBuffer(await service.readFile('a.txt', { encoding: null }))).toBe(true);
    expect(Buffer.isBuffer(await service.readFile('a.txt', {}))).toBe(true);
  });

  it('writeFile honours the encoding of a string (as string or option) and accepts Uint8Array', async () => {
    const { service } = h.ctx;
    await put(service, 'b64.txt', 'aGk=', 'base64');
    expect(await service.readFile('b64.txt', 'utf8')).toBe('hi');
    await put(service, 'hex.txt', '6869', { encoding: 'hex' });
    expect(await service.readFile('hex.txt', 'utf8')).toBe('hi');
    await put(service, 'u8.bin', new Uint8Array([1, 2, 3]));
    expect([...(await service.readFile('u8.bin'))]).toEqual([1, 2, 3]);
  });

  it('writeFile with the append flag (fs flag option)', async () => {
    const { service } = h.ctx;
    await put(service, 'x.txt', 'a');
    if (backend.isS3) return; // flags are a filesystem concept
    await put(service, 'x.txt', 'b', { flag: 'a' });
    expect(await service.readFile('x.txt', 'utf8')).toBe('ab');
  });

  it('readdir treats a string as an encoding', async () => {
    const { service } = h.ctx;
    await put(service, 'd/f.txt', 'x');
    expect(await service.readdir('d', 'utf8')).toEqual(['f.txt']);
    expect(await service.readdir('d', { encoding: 'utf8' })).toEqual(['f.txt']);
    expect(await service.readdir('d', 'hex')).toEqual([Buffer.from('f.txt').toString('hex')]);
  });

  it('createReadStream honours the encoding', async () => {
    const { service } = h.ctx;
    await put(service, 's.txt', 'stream');
    const chunks: unknown[] = [];
    for await (const chunk of service.createReadStream('s.txt', { encoding: 'utf8' })) chunks.push(chunk);
    expect(chunks.every((c) => typeof c === 'string')).toBe(true);
    expect(chunks.join('')).toBe('stream');
    expect((await collect(service.createReadStream('s.txt', { start: 1, end: 2 }))).toString()).toBe('tr');
  });

  it('createWriteStream accepts fs options', async () => {
    const { service } = h.ctx;
    await new Promise<void>((resolve, reject) => {
      const ws = service.createWriteStream('w.txt', { highWaterMark: 1024, encoding: 'utf8' });
      ws.on('error', reject).on('finish', () => resolve());
      ws.end('written');
    });
    expect(await service.readFile('w.txt', 'utf8')).toBe('written');
  });
});

describeBackends('readdir errors', (backend) => {
  const h = useCtx(backend, 'readdir-errors');

  it('missing folder: ENOENT (scandir), also recursive', async () => {
    const { service, errPath } = h.ctx;
    const expected = { code: 'ENOENT', errno: -2, syscall: 'scandir', path: errPath('nope') };
    await expectFsError(service.readdir('nope'), expected);
    await expectFsError(service.readdir('nope', { recursive: true }), expected);
  });

  it('a file: ENOTDIR (scandir)', async () => {
    const { service, errPath } = h.ctx;
    await put(service, 'f.txt', 'x');
    await expectFsError(service.readdir('f.txt'), {
      code: 'ENOTDIR',
      errno: -20,
      syscall: 'scandir',
      path: errPath('f.txt'),
    });
  });

  it('an existing empty folder and the prefix root give []', async () => {
    const { service } = h.ctx;
    expect(await service.readdir('')).toEqual([]);
    await service.mkdir('empty');
    expect(await service.readdir('empty')).toEqual([]);
  });
});

describeBackends('rm', (backend) => {
  const h = useCtx(backend, 'rm');

  async function seed() {
    const { service } = h.ctx;
    await service.mkdir('fo/sub');
    await put(service, 'fo/sub/x.txt', 'x');
    await put(service, 'fo/y.txt', 'y');
    await put(service, 'fo2/keep.txt', 'k');
    await put(service, 'implicit/deep/z.txt', 'z');
  }

  it('a folder without recursive: ERR_FS_EISDIR, nothing is deleted', async () => {
    await seed();
    const { service, errPath } = h.ctx;
    for (const p of ['fo', 'implicit']) {
      const error = await expectFsError(service.rm(p), { code: 'ERR_FS_EISDIR', syscall: 'rm', path: errPath(p) });
      expect(error.errno).toBe(21);
      expect(error.message).toContain('Path is a directory');
    }
    expect(await service.exists('fo/y.txt')).toBe(true);
  });

  it('a folder with recursive deletes everything below it, but not siblings', async () => {
    await seed();
    const { service } = h.ctx;
    await service.rm('fo', { recursive: true });
    await service.rm('implicit', { recursive: true });
    expect(await service.exists('fo')).toBe(false);
    expect(await service.exists('fo/sub/x.txt')).toBe(false);
    expect(await service.exists('implicit')).toBe(false);
    expect(await service.exists('fo2/keep.txt')).toBe(true);
  });

  it('a file with recursive, and a missing path with force', async () => {
    const { service } = h.ctx;
    await put(service, 'a.txt', 'x');
    await service.rm('a.txt', { recursive: true });
    expect(await service.exists('a.txt')).toBe(false);
    await expect(service.rm('a.txt', { force: true })).resolves.toBeUndefined();
    await expect(service.rm('a.txt', { force: true, recursive: true })).resolves.toBeUndefined();
    await expectFsError(service.rm('a.txt', { recursive: true }), { code: 'ENOENT', syscall: 'lstat' });
  });
});

describeBackends('rmdir', (backend) => {
  const h = useCtx(backend, 'rmdir');

  it('a missing path: ENOENT (lstat, like fs.rm recursive)', async () => {
    const { service, errPath } = h.ctx;
    await expectFsError(service.rmdir('nope'), { code: 'ENOENT', errno: -2, syscall: 'lstat', path: errPath('nope') });
  });

  it('a missing path with recursive: false: ENOENT (rmdir)', async () => {
    const { service, errPath } = h.ctx;
    await expectFsError(service.rmdir('nope', { recursive: false }), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'rmdir',
      path: errPath('nope'),
    });
  });

  it('recursive: false on a non-empty folder: ENOTEMPTY; on a file: ENOTDIR; on an empty folder: removes it', async () => {
    const { service, errPath } = h.ctx;
    await put(service, 'd/f.txt', 'x');
    await service.mkdir('e');
    await expectFsError(service.rmdir('d', { recursive: false }), {
      code: 'ENOTEMPTY',
      errno: -39,
      syscall: 'rmdir',
      path: errPath('d'),
    });
    await expectFsError(service.rmdir('d/f.txt', { recursive: false }), {
      code: 'ENOTDIR',
      errno: -20,
      syscall: 'rmdir',
      path: errPath('d/f.txt'),
    });
    expect(await service.exists('d/f.txt')).toBe(true);

    await service.rmdir('e', { recursive: false });
    expect(await service.exists('e')).toBe(false);
  });

  it('recursive: false on a folder whose content was removed', async () => {
    const { service } = h.ctx;
    await service.mkdir('d');
    await put(service, 'd/f.txt', 'x');
    await service.rm('d/f.txt');
    await service.rmdir('d', { recursive: false });
    expect(await service.exists('d')).toBe(false);
  });

  it('removes a file by default, like fs.rm(path, { recursive: true })', async () => {
    const { service } = h.ctx;
    await put(service, 'f.txt', 'x');
    await service.rmdir('f.txt');
    expect(await service.exists('f.txt')).toBe(false);
  });
});

describeBackends('mkdir', (backend) => {
  const h = useCtx(backend, 'mkdir');

  it('a file at that path: EEXIST, with and without recursive', async () => {
    const { service, errPath } = h.ctx;
    await put(service, 'f.txt', 'x');
    const expected = { code: 'EEXIST', errno: -17, syscall: 'mkdir', path: errPath('f.txt') };
    await expectFsError(service.mkdir('f.txt'), expected);
    await expectFsError(service.mkdir('f.txt', { recursive: false }), expected);
    expect(await service.readFile('f.txt', 'utf8')).toBe('x');
  });

  it('recursive: false on an existing folder: EEXIST (explicit, implicit and nested content)', async () => {
    const { service, errPath } = h.ctx;
    await service.mkdir('d');
    await put(service, 'implicit/f.txt', 'x');
    for (const p of ['d', 'implicit']) {
      await expectFsError(service.mkdir(p, { recursive: false }), {
        code: 'EEXIST',
        errno: -17,
        syscall: 'mkdir',
        path: errPath(p),
      });
    }
  });

  it('recursive: false with a missing parent: ENOENT; with an existing parent or the root: creates it', async () => {
    const { service, errPath } = h.ctx;
    await expectFsError(service.mkdir('a/b', { recursive: false }), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'mkdir',
      path: errPath('a/b'),
    });
    expect(await service.exists('a')).toBe(false);
    await service.mkdir('a', { recursive: false });
    await service.mkdir('a/b', { recursive: false });
    expect(await service.exists('a/b')).toBe(true);
  });

  it('is recursive by default; an existing folder is fine', async () => {
    const { service } = h.ctx;
    await service.mkdir('x/y/z');
    await service.mkdir('x/y/z', { recursive: true });
    await service.mkdir('x/y/z', { mode: 0o755 });
    expect(await service.exists('x/y/z')).toBe(true);
  });
});

describeBackends('writing below a file', (backend) => {
  const h = useCtx(backend, 'write-below-file');

  const writeThroughStream = (service: StorageDisk, p: string) =>
    new Promise<void>((resolve, reject) => {
      const ws = service.createWriteStream(p);
      ws.on('error', reject).on('finish', () => resolve());
      ws.end('child');
    });

  it('writeFile and createWriteStream below a file: ENOTDIR (open), except on S3 where folders are implicit', async () => {
    const { service, errPath } = h.ctx;
    await put(service, 'f', 'x');
    if (backend.isS3) {
      // Both keys `f` and `f/child` can exist: the file simply gets a child
      await service.writeFile('f/child', 'a');
      await writeThroughStream(service, 'f/child2');
      expect(await service.readFile('f/child', 'utf8')).toBe('a');
      expect(await service.readFile('f/child2', 'utf8')).toBe('child');
      return;
    }
    await expectFsError(service.writeFile('f/child', 'y'), {
      code: 'ENOTDIR',
      errno: -20,
      syscall: 'open',
      path: errPath('f/child'),
    });
    await expectFsError(writeThroughStream(service, 'f/child'), {
      code: 'ENOTDIR',
      errno: -20,
      syscall: 'open',
      path: errPath('f/child'),
    });
    await expectFsError(service.writeFile('f/deeper/child', 'y'), { code: 'ENOTDIR', syscall: 'open' });
    expect(await service.readFile('f', 'utf8')).toBe('x');
  });
});

describeBackends('exists and copyFile edge cases', (backend) => {
  const h = useCtx(backend, 'exists');

  it('exists is true for an implicit folder (objects below it, no marker)', async () => {
    const { service } = h.ctx;
    await put(service, 'imp/deep/f.txt', 'x');
    expect(await service.exists('imp')).toBe(true);
    expect(await service.exists('imp/deep')).toBe(true);
    expect(await service.exists('imp/de')).toBe(false);
    expect(await service.exists('')).toBe(true);
  });

  it('copyFile with COPYFILE_EXCL and src === dest: EEXIST; without EXCL it is a no-op', async () => {
    const { service, errPath } = h.ctx;
    await put(service, 'a.txt', 'x');
    await expectFsError(service.copyFile('a.txt', 'a.txt', fs.constants.COPYFILE_EXCL), {
      code: 'EEXIST',
      errno: -17,
      syscall: 'copyfile',
      path: errPath('a.txt'),
      dest: errPath('a.txt'),
    });
    await expect(service.copyFile('a.txt', 'a.txt')).resolves.toBeUndefined();
    expect(await service.readFile('a.txt', 'utf8')).toBe('x');
  });

  it('createReadStream on a missing file emits ENOENT (open)', async () => {
    const { service, errPath } = h.ctx;
    await expectFsError(collect(service.createReadStream('missing.txt')), {
      code: 'ENOENT',
      errno: -2,
      syscall: 'open',
      path: errPath('missing.txt'),
    });
  });
});

describeS3('the bucket of the disk (S3)', () => {
  it('every method addresses the configured bucket', async () => {
    const ctx = await createCtx(S3_BACKEND, 'bucket-own', { overrides: { bucket: S3_BUCKET } });
    try {
      const { service } = ctx;
      await service.writeFile('d/a.txt', 'hello', { contentType: 'text/x-own' });
      await service.mkdir('m');
      await expect(service.mkdir('m2/n', { recursive: false })).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await service.readFile('d/a.txt', { encoding: 'utf8' })).toBe('hello');
      expect(await service.readdir('d')).toEqual(['a.txt']);
      expect(await service.readdir('', { recursive: true })).toContain('d/a.txt');
      expect((await service.stat('d/a.txt')).contentType).toBe('text/x-own');
      expect(await service.exists('d/a.txt')).toBe(true);
      expect((await collect(service.createReadStream('d/a.txt', { start: 1, end: 2 }))).toString()).toBe('el');
      await new Promise<void>((resolve, reject) => {
        const ws = service.createWriteStream('d/w.txt');
        ws.on('error', reject).on('finish', () => resolve());
        ws.end('w');
      });
      await service.copyFile('d/w.txt', 'd/w2.txt');
      await service.rename('d/w2.txt', 'd/w3.txt');
      await service.rm('d/w3.txt');
      await service.rmdir('m');
      await service.rm('d', { recursive: true });
      expect(await service.exists('d')).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it('a disk with a nonexistent bucket rejects', async () => {
    const ctx = await createCtx(S3_BACKEND, 'bucket-bad', { overrides: { bucket: 'no-such-bucket' } });
    try {
      const { service } = ctx;
      await expect(put(service, 'a.txt', 'x')).rejects.toThrow();
      await expect(service.readFile('a.txt')).rejects.toThrow();
      await expect(collect(service.createReadStream('a.txt'))).rejects.toThrow();
      await expect(service.readdir('d')).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it('a string in an options position is an encoding', async () => {
    const ctx = await createCtx(S3_BACKEND, 'bucket-string');
    try {
      await ctx.service.writeFile('a.txt', 'hi');
      expect(await ctx.service.readFile('a.txt', 'utf8')).toBe('hi');
      expect(await ctx.service.readdir('', 'utf8')).toEqual(['a.txt']);
    } finally {
      await ctx.close();
    }
  });

  it('a disk without a bucket is rejected when it is created', async () => {
    expect(() => createStorage(s3Options('x', { bucket: undefined }))).toThrow(`type 's3' requires "bucket"`);
    expect(() => createStorage({ default: 'a', disks: { a: s3Options('x', { bucket: undefined }) } })).toThrow(
      `Storage disk "a": type 's3' requires "bucket"`,
    );
  });
});

describeS3('S3 specifics of the fs-compatible API', () => {
  it('the prefix root with nothing below it is a no-op', async () => {
    const ctx = await createCtx(S3_BACKEND, 'rmdir-root');
    try {
      await expect(ctx.service.rmdir('')).resolves.toBeUndefined();
      await expect(ctx.service.rmdir('', { recursive: false })).resolves.toBeUndefined();
    } finally {
      await ctx.close();
    }
  });

  it('writeFile contentType overrides the lookup from the file name', async () => {
    const ctx = await createCtx(S3_BACKEND, 'content-type');
    try {
      const { service } = ctx;
      await put(service, 'a.json', '{}');
      await put(service, 'b.json', '{}', { contentType: 'application/x-custom' });
      await put(service, 'c.json', '{}', 'utf8');
      expect((await service.stat('a.json')).contentType).toBe('application/json');
      expect((await service.stat('b.json')).contentType).toBe('application/x-custom');
      expect((await service.stat('c.json')).contentType).toBe('application/json');
    } finally {
      await ctx.close();
    }
  });

  it('the filesystem-only options of writeFile and createWriteStream are accepted and ignored', async () => {
    const ctx = await createCtx(S3_BACKEND, 'fs-only-options');
    try {
      const { service } = ctx;
      await put(service, 'a.txt', 'x', { mode: 0o600, flag: 'w' });
      await new Promise<void>((resolve, reject) => {
        const ws = service.createWriteStream('b.txt', { flags: 'w', mode: 0o600 });
        ws.on('error', reject).on('finish', () => resolve());
        ws.end('y');
      });
      expect(await service.readFile('a.txt', 'utf8')).toBe('x');
      expect(await service.readFile('b.txt', 'utf8')).toBe('y');
    } finally {
      await ctx.close();
    }
  });

  it('endpointCDN without endpoint reads directly from S3', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot(s3Options('e2e/cdn-guard-' + randomUUID().slice(0, 8)))],
    }).compile();
    await moduleRef.init();
    const service = moduleRef.get(StorageService);
    // The client keeps its endpoint; the service sees only endpointCDN
    s3Internals(service).endpoint = undefined;
    s3Internals(service).endpointCDN = 'http://127.0.0.1:1';
    const originalFetch = globalThis.fetch;
    const fetchSpy = jest.fn(originalFetch);
    globalThis.fetch = fetchSpy as typeof fetch;
    try {
      await put(service, 'a.txt', 'direct');
      expect(await service.readFile('a.txt', 'utf8')).toBe('direct');
      await expectFsError(service.readFile('missing.txt'), { code: 'ENOENT', syscall: 'open' });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      await service.rm('', { recursive: true }).catch(() => undefined);
      await moduleRef.close();
    }
  });

  it('exists does not swallow errors other than not-found', async () => {
    const ctx = await createCtx(S3_BACKEND, 'exists-throws');
    try {
      const { service } = ctx;
      const forbidden = Object.assign(new Error('Forbidden'), {
        name: 'Forbidden',
        $metadata: { httpStatusCode: 403 },
      });
      const send = jest.spyOn(service.s3client as any, 'send').mockImplementation(async () => {
        throw forbidden;
      });
      await expect(service.exists('a.txt')).rejects.toThrow('Forbidden');
      send.mockRestore();
    } finally {
      await ctx.close();
    }
  });

  it('mkdir recursive: false under a file parent: ENOTDIR', async () => {
    const ctx = await createCtx(S3_BACKEND, 'mkdir-parent-file');
    try {
      const { service } = ctx;
      await put(service, 'f', 'x');
      await expectFsError(service.mkdir('f/child', { recursive: false }), { code: 'ENOTDIR', syscall: 'mkdir' });
    } finally {
      await ctx.close();
    }
  });

  const noPrefix = async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot(s3Options('', { prefix: undefined }))],
    }).compile();
    await moduleRef.init();
    return { moduleRef, service: moduleRef.get(StorageService) };
  };

  it.each(['../x', 'a/../../x', '..', '..\\x'])('without a prefix, %p escapes the bucket root', async (p) => {
    const { moduleRef, service } = await noPrefix();
    try {
      await expect(put(service, p, 'x')).rejects.toThrow(/escapes the bucket root/);
      await expect(service.readFile(p)).rejects.toThrow(/escapes the bucket root/);
      await expect(service.readdir(p)).rejects.toThrow(/escapes the bucket root/);
      await expect(service.rm(p)).rejects.toThrow(/escapes the bucket root/);
      expect(() => service.createReadStream(p)).toThrow(/escapes the bucket root/);
      expect(() => service.createWriteStream(p)).toThrow(/escapes the bucket root/);
    } finally {
      await moduleRef.close();
    }
  });

  it('without a prefix, paths that stay inside the bucket (also with a leading slash) keep working', async () => {
    const { moduleRef, service } = await noPrefix();
    const dir = `noprefix-${randomUUID().slice(0, 8)}`;
    try {
      await service.writeFile(`${dir}/a/../b.txt`, 'x');
      await service.writeFile(`/${dir}-abs.txt`, 'y');
      expect(await service.readFile(`${dir}/b.txt`, 'utf8')).toBe('x');
      expect(await service.exists(`/${dir}-abs.txt`)).toBe(true);
    } finally {
      await service.rm(`${dir}/b.txt`, { force: true });
      await service.rm(`/${dir}-abs.txt`, { force: true });
      await moduleRef.close();
    }
  });
});
