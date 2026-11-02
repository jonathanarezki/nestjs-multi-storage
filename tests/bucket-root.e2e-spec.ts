import { CreateBucketCommand, DeleteBucketCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { StorageModule, StorageService } from '../lib';
import {
  collect,
  createCtx,
  describeBackends,
  describeS3,
  expectFsError,
  S3_BACKEND,
  s3Options,
  useCtx,
} from './support/harness';
import { Test } from '@nestjs/testing';

describeS3('bucket root without a prefix (S3)', () => {
  let service: StorageService;
  let close: () => Promise<void>;
  let bucket: string;

  const keys = async () => {
    const out = await service.s3client!.send(new ListObjectsV2Command({ Bucket: bucket }));
    return (out.Contents ?? []).map((c) => c.Key!).sort();
  };

  beforeEach(async () => {
    bucket = `e2e-root-${randomUUID().slice(0, 12)}`;
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot(s3Options('', { prefix: undefined, bucket }))],
    }).compile();
    await moduleRef.init();
    service = moduleRef.get(StorageService);
    await service.s3client!.send(new CreateBucketCommand({ Bucket: bucket }));
    close = async () => {
      await service.rmdir('').catch(() => undefined);
      await service.s3client!.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
      await moduleRef.close();
    };
  });
  afterEach(async () => close());

  async function seed() {
    await service.writeFile('top.txt', 't');
    await service.writeFile('dir/a.txt', 'a');
  }

  it("readdir('') and readdir('.') list the bucket", async () => {
    expect(await service.readdir('')).toEqual([]);
    await seed();
    expect(await service.readdir('')).toEqual(['dir', 'top.txt']);
    expect(await service.readdir('.')).toEqual(['dir', 'top.txt']);
    expect(await service.readdir('dir/..')).toEqual(['dir', 'top.txt']);
  });

  it("readdir('', { recursive: true }) lists everything", async () => {
    await seed();
    expect(await service.readdir('', { recursive: true })).toEqual(['dir', 'dir/a.txt', 'top.txt']);
  });

  it("stat('') and exists('') describe a directory", async () => {
    for (const p of ['', '.']) {
      expect((await service.stat(p)).isDirectory()).toBe(true);
      expect(await service.exists(p)).toBe(true);
    }
  });

  it("mkdir('') is a no-op and writes no object", async () => {
    await seed();
    await expect(service.mkdir('')).resolves.toBeUndefined();
    await expect(service.mkdir('.')).resolves.toBeUndefined();
    await expectFsError(service.mkdir('', { recursive: false }), { code: 'EEXIST', syscall: 'mkdir' });
    expect(await keys()).toEqual(['dir/a.txt', 'top.txt']);
  });

  it("rmdir('') empties the bucket", async () => {
    await seed();
    await service.rmdir('');
    expect(await keys()).toEqual([]);
    expect(await service.readdir('')).toEqual([]);
    // an empty root has nothing to remove, with or without recursive
    await expect(service.rmdir('', { recursive: false })).resolves.toBeUndefined();
  });

  it("rmdir('', { recursive: false }) on a non-empty bucket is ENOTEMPTY", async () => {
    await seed();
    await expectFsError(service.rmdir('', { recursive: false }), { code: 'ENOTEMPTY', syscall: 'rmdir' });
    expect(await keys()).toEqual(['dir/a.txt', 'top.txt']);
  });

  it("rm('') needs recursive, then empties the bucket", async () => {
    await seed();
    await expectFsError(service.rm(''), { code: 'ERR_FS_EISDIR', syscall: 'rm' });
    await service.rm('.', { recursive: true });
    expect(await keys()).toEqual([]);
  });

  it('refuses to write the root as a file and never sends a request for an empty key', async () => {
    await seed();
    for (const p of ['', '.']) {
      await expectFsError(service.writeFile(p, 'x'), { code: 'EISDIR', syscall: 'open' });
      await expectFsError(service.copyFile('top.txt', p), { code: 'EISDIR', syscall: 'copyfile' });
      await expectFsError(service.rename('top.txt', p), { code: 'EISDIR', syscall: 'rename' });
      await expectFsError(service.readFile(p), { code: 'EISDIR', syscall: 'read' });
    }
    await expectFsError(service.writeFile('/', 'x'), { code: 'EISDIR', syscall: 'open' });
    expect(() => service.createWriteStream('')).toThrow(/EISDIR/);
    expect(await keys()).toEqual(['dir/a.txt', 'top.txt']);
  });

  it("a leading '/' is stripped: '/a.txt', 'a.txt' and '//a.txt' are the same object", async () => {
    await service.writeFile('/a.txt', 'slash');
    expect(await service.readFile('a.txt', 'utf8')).toBe('slash');
    expect(await service.readFile('/a.txt', 'utf8')).toBe('slash');
    expect(await service.readFile('//a.txt', 'utf8')).toBe('slash');
    expect(await service.readFile('\\a.txt', 'utf8')).toBe('slash');
    await service.writeFile('a.txt', 'plain');
    expect(await service.readFile('/a.txt', 'utf8')).toBe('plain');
    expect(await keys()).toEqual(['a.txt']);
    expect(await service.readdir('')).toEqual(['a.txt']);
  });

  it("'//x' maps to 'x' and '/dir/' to the folder 'dir/'", async () => {
    await service.writeFile('//x', '1');
    await service.writeFile('/dir/y.txt', '2');
    expect(await keys()).toEqual(['dir/y.txt', 'x']);
    expect(await service.readdir('/dir/')).toEqual(['y.txt']);
    expect(await service.readdir('dir')).toEqual(['y.txt']);
    expect(await service.exists('/dir')).toBe(true);
    expect((await service.stat('/dir/')).isDirectory()).toBe(true);
  });

  it("'/' is the bucket root, exactly like ''", async () => {
    await seed();
    for (const root of ['/', '//']) {
      expect(await service.readdir(root)).toEqual(await service.readdir(''));
      expect(await service.readdir(root)).toEqual(['dir', 'top.txt']);
      expect(await service.readdir(root, { recursive: true })).toEqual(['dir', 'dir/a.txt', 'top.txt']);
      expect((await service.stat(root)).isDirectory()).toBe(true);
      expect(await service.exists(root)).toBe(true);
      await expect(service.mkdir(root)).resolves.toBeUndefined();
      await expectFsError(service.mkdir(root, { recursive: false }), { code: 'EEXIST', syscall: 'mkdir' });
      await expectFsError(service.readFile(root), { code: 'EISDIR', syscall: 'read' });
      await expectFsError(service.writeFile(root, 'x'), { code: 'EISDIR', syscall: 'open' });
      await expectFsError(service.rm(root), { code: 'ERR_FS_EISDIR', syscall: 'rm' });
      expect(() => service.createWriteStream(root)).toThrow(/EISDIR/);
    }
    expect(await keys()).toEqual(['dir/a.txt', 'top.txt']);
    await service.rmdir('/');
    expect(await keys()).toEqual([]);
  });

  it("mkdir('/m') creates the marker 'm/'", async () => {
    await service.mkdir('/m');
    expect(await keys()).toEqual(['m/']);
    await service.mkdir('/n/o');
    expect(await keys()).toEqual(['m/', 'n/o/']);
  });

  it('copyFile, rename and signed URLs strip the leading slash too', async () => {
    await service.writeFile('/a.txt', 'a');
    await service.copyFile('/a.txt', '/b.txt');
    await service.rename('/b.txt', '//c.txt');
    expect(await keys()).toEqual(['a.txt', 'c.txt']);
    const get = new URL(await service.getSignedUrl('/a.txt'));
    expect(get.pathname).toBe(`/${bucket}/a.txt`);
    const put = new URL(await service.getSignedPutUrl('//up/x.txt'));
    expect(put.pathname).toBe(`/${bucket}/up/x.txt`);
  });

  it("paths escaping the bucket root are rejected, also behind a leading '/'", async () => {
    await service.writeFile('ok.txt', 'ok');
    const escapes = /escapes the bucket root/;
    for (const p of ['../x', '/../x', '//../x', '/a/../../x', '\\..\\x', '..', '/..']) {
      await expect(service.writeFile(p, 'x')).rejects.toThrow(escapes);
      await expect(service.readFile(p)).rejects.toThrow(escapes);
      await expect(service.readdir(p)).rejects.toThrow(escapes);
      await expect(service.stat(p)).rejects.toThrow(escapes);
      await expect(service.mkdir(p)).rejects.toThrow(escapes);
      await expect(service.copyFile('ok.txt', p)).rejects.toThrow(escapes);
      await expect(service.getSignedUrl(p)).rejects.toThrow(escapes);
      expect(() => service.createReadStream(p)).toThrow(escapes);
    }
    expect(await keys()).toEqual(['ok.txt']);
  });

  it('exists on the root is true for an existing bucket', async () => {
    expect(await service.exists('', bucket)).toBe(true);
  });
});

describeS3('nonexistent bucket (S3)', () => {
  const MISSING = { bucket: `e2e-missing-${randomUUID().slice(0, 12)}` };
  const noSuchBucket = { name: 'NoSuchBucket' };

  for (const [label, prefix] of [
    ['with a prefix', 'e2e/missing'],
    ['without a prefix', ''],
  ] as const) {
    it(`stat, exists, rm, readdir, rmdir, mkdir, copyFile, rename, readFile and streams reject with NoSuchBucket, ${label}`, async () => {
      const ctx = await createCtx(S3_BACKEND, 'missing-bucket', { overrides: { prefix: prefix || undefined } });
      try {
        const { service } = ctx;
        for (const p of ['a.txt', 'dir/a.txt', '']) {
          await expect(service.stat(p, MISSING)).rejects.toMatchObject(noSuchBucket);
          await expect(service.exists(p, MISSING.bucket)).rejects.toMatchObject(noSuchBucket);
          await expect(service.rm(p, { ...MISSING, recursive: true })).rejects.toMatchObject(noSuchBucket);
          await expect(service.rm(p, { ...MISSING, force: true })).rejects.toMatchObject(noSuchBucket);
          await expect(service.readdir(p, MISSING)).rejects.toMatchObject(noSuchBucket);
          await expect(service.readdir(p, { ...MISSING, recursive: true })).rejects.toMatchObject(noSuchBucket);
          await expect(service.rmdir(p, MISSING)).rejects.toMatchObject(noSuchBucket);
          await expect(service.rmdir(p, { ...MISSING, recursive: false })).rejects.toMatchObject(noSuchBucket);
          await expect(service.mkdir(p, MISSING)).rejects.toMatchObject(noSuchBucket);
        }
        await expect(service.copyFile('a.txt', 'b.txt', 0, MISSING.bucket)).rejects.toMatchObject(noSuchBucket);
        await expect(service.rename('a.txt', 'b.txt', MISSING.bucket)).rejects.toMatchObject(noSuchBucket);
        await expect(service.readFile('a.txt', MISSING)).rejects.toMatchObject(noSuchBucket);
        await expect(collect(service.createReadStream('a.txt', MISSING))).rejects.toMatchObject(noSuchBucket);
      } finally {
        // Not ctx.close(): without a prefix its rmdir('') would empty the SHARED bucket, under other workers' feet.
        // Nothing was written here, so closing the module is all the cleanup needed.
        await ctx.moduleRef.close();
      }
    });
  }
});

describeBackends('reading a folder', (backend) => {
  const h = useCtx(backend, 'read-folder');

  it('readFile on a folder is EISDIR (read), like Node', async () => {
    const { service, errPath } = h.ctx;
    await service.mkdir('empty');
    await service.mkdir('full');
    await service.writeFile('full/a.txt', 'x');
    // Whether Node attaches `path` to this error depends on the Node version (older 22.x does not), so the
    // fileSystem backend is compared against what the running Node does on a real directory. The emulated
    // backends (memory, s3) always carry the path, as current Node does.
    let expectPath = true;
    if (backend.name === 'fileSystem') {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nms-eisdir-'));
      try {
        const native: any = await fs.promises.readFile(dir).then(
          () => undefined,
          (e) => e,
        );
        expect(native).toMatchObject({ code: 'EISDIR', syscall: 'read' });
        expectPath = native.path !== undefined;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
    for (const p of ['empty', 'full', 'full/']) {
      await expectFsError(service.readFile(p), {
        code: 'EISDIR',
        errno: -21,
        syscall: 'read',
        ...(expectPath ? { path: errPath(p) } : {}),
      });
    }
    await expectFsError(service.readFile('missing'), { code: 'ENOENT', syscall: 'open' });
  });

  it('createReadStream on a folder emits EISDIR (read), like Node', async () => {
    const { service } = h.ctx;
    await service.mkdir('empty');
    await service.mkdir('full');
    await service.writeFile('full/a.txt', 'x');
    for (const p of ['empty', 'full']) {
      await expectFsError(collect(service.createReadStream(p)), { code: 'EISDIR', errno: -21, syscall: 'read' });
    }
    await expectFsError(collect(service.createReadStream('missing')), { code: 'ENOENT', syscall: 'open' });
  });
});
