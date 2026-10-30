import * as fs from 'fs';
import { GetObjectTaggingCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomBytes } from 'crypto';
import { Ctx, createCtx, describeS3, S3_BACKEND, S3_BUCKET } from './support/harness';

interface Call {
  name: string;
  input: any;
  start: number;
  end?: number;
}

describeS3('S3 request counts, parallel lookups and storage class (S3)', () => {
  let ctx: Ctx;
  let clock = 0;
  beforeEach(async () => {
    ctx = await createCtx(S3_BACKEND, 'requests');
  });
  afterEach(async () => {
    await ctx.close();
  });

  const key = (name: string) => `${ctx.prefix}/${name}`;

  /** Records every command with the order in which it started and finished (a logical clock, no timers). */
  const record = async (action: () => Promise<unknown>, fault?: (name: string, input: any) => void) => {
    const calls: Call[] = [];
    ctx.service.s3client!.middlewareStack.add(
      (next, context) => async (args) => {
        const call: Call = { name: context.commandName!.replace(/Command$/, ''), input: args.input, start: clock++ };
        calls.push(call);
        try {
          fault?.(call.name, call.input);
          return await next(args);
        } finally {
          call.end = clock++;
        }
      },
      { step: 'initialize', name: 'record' },
    );
    try {
      await action();
    } finally {
      ctx.service.s3client!.middlewareStack.remove('record');
    }
    return calls;
  };
  const names = (calls: Call[]) => calls.map((call) => call.name);

  const putRaw = (name: string, extra: Record<string, unknown> = {}, body: string | Buffer = 'x') =>
    ctx.service.s3client!.send(new PutObjectCommand({ Bucket: S3_BUCKET, Key: key(name), Body: body, ...extra }));
  const storageClassOf = async (name: string) =>
    (await ctx.service.s3client!.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: key(name) }))).StorageClass;
  const tagsOf = async (name: string) =>
    (await ctx.service.s3client!.send(new GetObjectTaggingCommand({ Bucket: S3_BUCKET, Key: key(name) }))).TagSet ?? [];

  describe('requests', () => {
    const fileRename = ['ListObjectsV2', 'ListObjectsV2', 'CopyObject', 'DeleteObject'];

    it('file rename: 4 requests in 3 round trips, to a new name and over an existing file', async () => {
      const { service } = ctx;
      await service.writeFile('a.txt', 'a');
      const toNew = await record(() => service.rename('a.txt', 'b.txt'));
      expect(names(toNew)).toEqual(fileRename);
      // Both LISTs start before either has finished: they run in parallel
      expect(Math.max(toNew[0].start, toNew[1].start)).toBeLessThan(Math.min(toNew[0].end!, toNew[1].end!));
      // Then copy and delete, one after the other
      expect(toNew[2].start).toBeGreaterThan(Math.max(toNew[0].end!, toNew[1].end!));
      expect(toNew[3].start).toBeGreaterThan(toNew[2].end!);

      await service.writeFile('c.txt', 'c');
      const over = await record(() => service.rename('c.txt', 'b.txt'));
      expect(names(over)).toEqual(fileRename);
      expect(Math.max(over[0].start, over[1].start)).toBeLessThan(Math.min(over[0].end!, over[1].end!));
      expect(await service.readFile('b.txt', 'utf8')).toBe('c');
    });

    it('copyFile: 3 requests in 2 round trips, to a new name and over an existing file', async () => {
      const { service } = ctx;
      await service.writeFile('a.txt', 'a');
      for (const dest of ['b.txt', 'b.txt']) {
        const calls = await record(() => service.copyFile('a.txt', dest));
        expect(names(calls)).toEqual(['ListObjectsV2', 'ListObjectsV2', 'CopyObject']);
        expect(Math.max(calls[0].start, calls[1].start)).toBeLessThan(Math.min(calls[0].end!, calls[1].end!));
      }
    });

    it('copyFile with COPYFILE_EXCL keeps the destination check (1 extra HEAD)', async () => {
      const { service } = ctx;
      await service.writeFile('a.txt', 'a');
      const calls = await record(() => service.copyFile('a.txt', 'b.txt', fs.constants.COPYFILE_EXCL));
      expect(names(calls)).toEqual(['ListObjectsV2', 'ListObjectsV2', 'HeadObject', 'CopyObject']);
      expect(calls[3].input.IfNoneMatch).toBe('*');
    });

    it('failed lookups: missing source, folder source and folder destination keep their error', async () => {
      const { service } = ctx;
      await service.writeFile('a.txt', 'a');
      await service.mkdir('dir');
      await service.writeFile('imp/x.txt', 'x');
      await expect(service.rename('nope', 'dir')).rejects.toMatchObject({ code: 'ENOENT', syscall: 'rename' });
      await expect(service.copyFile('nope', 'dir')).rejects.toMatchObject({ code: 'ENOENT', syscall: 'copyfile' });
      await expect(service.rename('a.txt', 'dir')).rejects.toMatchObject({ code: 'EISDIR' });
      await expect(service.rename('a.txt', 'imp')).rejects.toMatchObject({ code: 'EISDIR' });
      await expect(service.copyFile('a.txt', 'imp')).rejects.toMatchObject({ code: 'EISDIR' });
      await expect(service.rename('a.txt', '')).rejects.toMatchObject({ code: 'EISDIR' });
      // A file whose name is a prefix of other keys is still found
      await service.writeFile('a.txt.bak', 'bak');
      await service.rename('a.txt', 'z.txt');
      expect(await service.readFile('z.txt', 'utf8')).toBe('a');
      expect(await service.readFile('a.txt.bak', 'utf8')).toBe('bak');
    });

    it('folder rename with n objects: n + 2 * ceil(n / 1000) + 6 requests', async () => {
      const { service } = ctx;
      await service.mkdir('m');
      for (let i = 0; i < 3; i++) await service.writeFile(`m/${i}.txt`, 'x');
      const calls = await record(() => service.rename('m', 'm2'));
      // n = 4 (3 files and the marker): 6 lookups (2 parallel LISTs + HEAD and LIST twice), 1 LIST page,
      // 4 CopyObject, 1 DeleteObjects
      expect(calls).toHaveLength(4 + 2 + 6);
      expect(names(calls).filter((n) => n === 'CopyObject')).toHaveLength(4);
    });

    it('stat and exists: file 1 request, folder 2, missing path 2', async () => {
      const { service } = ctx;
      await service.writeFile('f.txt', 'f');
      await service.mkdir('explicit');
      await service.writeFile('implicit/x.txt', 'x');

      expect(names(await record(() => service.stat('f.txt')))).toEqual(['HeadObject']);
      const explicit = await record(() => service.stat('explicit'));
      expect(names(explicit)).toEqual(['HeadObject', 'ListObjectsV2']);
      expect((await service.stat('explicit')).mtime.getTime()).toBeGreaterThan(0);
      expect(names(await record(() => service.stat('implicit')))).toEqual(['HeadObject', 'ListObjectsV2']);
      expect((await service.stat('implicit')).mtime.getTime()).toBe(0);
      const missing = await record(() => service.stat('nope').catch(() => undefined));
      expect(names(missing)).toEqual(['HeadObject', 'ListObjectsV2']);
      expect(names(await record(() => service.exists('f.txt')))).toEqual(['HeadObject']);
      expect(names(await record(() => service.exists('nope')))).toEqual(['HeadObject', 'ListObjectsV2']);
    });
  });

  describe('storage class (s3mock round-trips it, so the destination is checked)', () => {
    it('rename and copyFile keep STANDARD_IA', async () => {
      const { service } = ctx;
      await putRaw('ia.txt', { StorageClass: 'STANDARD_IA' });
      await service.copyFile('ia.txt', 'copy.txt');
      expect(await storageClassOf('copy.txt')).toBe('STANDARD_IA');
      await service.rename('ia.txt', 'moved.txt');
      expect(await storageClassOf('moved.txt')).toBe('STANDARD_IA');
    });

    it('sends no StorageClass for STANDARD objects', async () => {
      const { service } = ctx;
      await service.writeFile('std.txt', 'x');
      const calls = await record(() => service.copyFile('std.txt', 'std2.txt'));
      expect(calls.find((c) => c.name === 'CopyObject')!.input.StorageClass).toBeUndefined();
      expect(await storageClassOf('std2.txt')).toBeUndefined();
    });

    it('a folder rename keeps the class of every object (mixed classes)', async () => {
      const { service } = ctx;
      await putRaw('src/ia.txt', { StorageClass: 'STANDARD_IA' });
      await putRaw('src/std.txt');
      await putRaw('src/sub/onezone.txt', { StorageClass: 'ONEZONE_IA' });
      await service.rename('src', 'dst');
      expect(await storageClassOf('dst/ia.txt')).toBe('STANDARD_IA');
      expect(await storageClassOf('dst/std.txt')).toBeUndefined();
      expect(await storageClassOf('dst/sub/onezone.txt')).toBe('ONEZONE_IA');
      const listed = await ctx.service.s3client!.send(
        new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: key('dst/') }),
      );
      expect(
        Object.fromEntries((listed.Contents ?? []).map((c) => [c.Key!.slice(key('dst/').length), c.StorageClass])),
      ).toEqual({
        'ia.txt': 'STANDARD_IA',
        'std.txt': 'STANDARD',
        'sub/onezone.txt': 'ONEZONE_IA',
      });
    });

    it('lets the error of S3 through when an object cannot be copied (InvalidObjectState)', async () => {
      const { service } = ctx;
      await putRaw('cold.txt', { StorageClass: 'STANDARD_IA' });
      await expect(
        record(
          () => service.rename('cold.txt', 'cold2.txt'),
          (name) => {
            if (name === 'CopyObject') throw Object.assign(new Error('restore first'), { name: 'InvalidObjectState' });
          },
        ),
      ).rejects.toMatchObject({ name: 'InvalidObjectState' });
      expect(await service.exists('cold.txt')).toBe(true);
    });
  });

  describe('multipart copy (5 MiB parts)', () => {
    const big = randomBytes(11 * 1024 * 1024);
    beforeEach(() => {
      (ctx.service as any).copyThreshold = 5 * 1024 * 1024;
      (ctx.service as any).copyPartSize = 5 * 1024 * 1024;
    });

    it('keeps the storage class and the tags', async () => {
      const { service } = ctx;
      await putRaw('big.bin', { StorageClass: 'STANDARD_IA', Tagging: 'team=core&env=test' }, big);
      const calls = await record(() => service.copyFile('big.bin', 'big2.bin'));
      expect(names(calls)).toContain('UploadPartCopy');
      const create = calls.find((c) => c.name === 'CreateMultipartUpload')!;
      expect(create.input.StorageClass).toBe('STANDARD_IA');
      expect(create.input.Tagging).toBe('team=core&env=test');
      expect(await storageClassOf('big2.bin')).toBe('STANDARD_IA');
      expect(await tagsOf('big2.bin')).toEqual(
        expect.arrayContaining([
          { Key: 'team', Value: 'core' },
          { Key: 'env', Value: 'test' },
        ]),
      );
      expect(await tagsOf('big2.bin')).toHaveLength(2);
      expect((await service.readFile('big2.bin')).equals(big)).toBe(true);

      await service.rename('big2.bin', 'big3.bin');
      expect(await storageClassOf('big3.bin')).toBe('STANDARD_IA');
      expect(await tagsOf('big3.bin')).toHaveLength(2);
    });

    it('URL-encodes tag keys and values', async () => {
      const { service } = ctx;
      await putRaw('big.bin', {}, big);
      const send = ctx.service.s3client!.send.bind(ctx.service.s3client!);
      // The tags of the source, as S3 would return them
      (ctx.service.s3client as any).send = async (command: any, ...rest: any[]) =>
        command instanceof GetObjectTaggingCommand
          ? {
              TagSet: [
                { Key: 'a b', Value: 'x&y=z/ü' },
                { Key: 'k2', Value: 'v2' },
              ],
            }
          : (send as any)(command, ...rest);
      const calls = await record(() => service.copyFile('big.bin', 'big2.bin'));
      expect(calls.find((c) => c.name === 'CreateMultipartUpload')!.input.Tagging).toBe(
        'a%20b=x%26y%3Dz%2F%C3%BC&k2=v2',
      );
    });

    it('a GetObjectTagging AccessDenied or NotImplemented: the copy succeeds without tags', async () => {
      const { service } = ctx;
      await putRaw('big.bin', { Tagging: 'team=core' }, big);
      for (const name of ['AccessDenied', 'NotImplemented']) {
        const calls = await record(
          () => service.copyFile('big.bin', `copy-${name}.bin`),
          (command) => {
            if (command === 'GetObjectTagging') throw Object.assign(new Error('nope'), { name });
          },
        );
        expect(names(calls)).toContain('CompleteMultipartUpload');
        expect(calls.find((c) => c.name === 'CreateMultipartUpload')!.input.Tagging).toBeUndefined();
        expect(await tagsOf(`copy-${name}.bin`)).toEqual([]);
        expect((await service.readFile(`copy-${name}.bin`)).equals(big)).toBe(true);
      }
    });

    it('other GetObjectTagging failures still fail the copy', async () => {
      const { service } = ctx;
      await putRaw('big.bin', {}, big);
      await expect(
        record(
          () => service.copyFile('big.bin', 'big2.bin'),
          (command) => {
            if (command === 'GetObjectTagging') throw Object.assign(new Error('boom'), { name: 'InternalError' });
          },
        ),
      ).rejects.toThrow('boom');
      expect(await service.exists('big2.bin')).toBe(false);
    });
  });
});
