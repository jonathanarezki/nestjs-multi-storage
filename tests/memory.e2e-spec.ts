import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { StorageModule, StorageModuleOptions, StorageService } from '../lib';
import { collect } from './support/harness';

async function createModule(options: Partial<StorageModuleOptions> = {}) {
  const moduleRef = await Test.createTestingModule({
    imports: [StorageModule.forRoot({ type: 'memory', ...options })],
  }).compile();
  await moduleRef.init();
  return { moduleRef, service: moduleRef.get(StorageService) };
}

describe('memory backend', () => {
  it('has no S3 client', async () => {
    const { moduleRef, service } = await createModule();
    expect(service.s3client).toBeUndefined();
    await moduleRef.close();
  });

  it('starts empty, also for a fresh Nest testing module', async () => {
    const first = await createModule();
    expect(await first.service.readdir('')).toEqual([]);
    await first.service.writeFile('a.txt', 'a');
    expect(await first.service.readdir('')).toEqual(['a.txt']);
    await first.moduleRef.close();

    const second = await createModule();
    expect(await second.service.readdir('')).toEqual([]);
    expect(await second.service.exists('a.txt')).toBe(false);
    await second.moduleRef.close();
  });

  it('does not share data between two instances, even with the same prefix', async () => {
    const a = await createModule({ prefix: '/shared' });
    const b = await createModule({ prefix: '/shared' });
    await a.service.writeFile('only-a.txt', 'a');
    expect(await a.service.exists('only-a.txt')).toBe(true);
    expect(await b.service.exists('only-a.txt')).toBe(false);
    await expect(b.service.readFile('only-a.txt')).rejects.toMatchObject({ code: 'ENOENT' });
    await a.moduleRef.close();
    await b.moduleRef.close();
  });

  it("uses '/' as the root without a prefix, independent of the cwd", async () => {
    const { moduleRef, service } = await createModule();
    await service.writeFile('a.txt', 'a');
    await service.mkdir('d/e');
    await expect(service.readFile('a.txt', 'utf8')).resolves.toBe('a');
    // The error path shows where the file lives in the volume
    await expect(service.readFile('missing.txt')).rejects.toMatchObject({ path: '/missing.txt' });
    // '/' is the whole volume: '..' is clamped at the root instead of reaching the real /etc
    await expect(service.readFile('../../etc/passwd')).rejects.toMatchObject({ code: 'ENOENT', path: '/etc/passwd' });
    await moduleRef.close();
  });

  it('resolves a relative prefix under / and creates the root', async () => {
    const { moduleRef, service } = await createModule({ prefix: 'some/where' });
    expect(await service.readdir('')).toEqual([]);
    await service.writeFile('a.txt', 'a');
    await expect(service.readFile('missing.txt')).rejects.toMatchObject({ path: '/some/where/missing.txt' });
    await moduleRef.close();
  });

  describe('files seed', () => {
    it('pre-populates strings, Buffers and nested paths', async () => {
      const { moduleRef, service } = await createModule({
        prefix: '/seeded',
        files: {
          'a.txt': 'hello',
          'bin/data.bin': Buffer.from([1, 2, 3]),
          'deep/er/nested/c.txt': 'nested',
          '/leading-slash.txt': 'slash',
        },
      });
      expect(await service.readFile('a.txt', 'utf8')).toBe('hello');
      expect([...(await service.readFile('bin/data.bin'))]).toEqual([1, 2, 3]);
      expect(await service.readFile('deep/er/nested/c.txt', 'utf8')).toBe('nested');
      expect(await service.readFile('leading-slash.txt', 'utf8')).toBe('slash');
      expect((await service.stat('deep/er')).isDirectory()).toBe(true);
      expect((await service.readdir('', { recursive: true })).sort()).toEqual([
        'a.txt',
        'bin',
        'bin/data.bin',
        'deep',
        'deep/er',
        'deep/er/nested',
        'deep/er/nested/c.txt',
        'leading-slash.txt',
      ]);
      await moduleRef.close();
    });

    it('works without a prefix and stays usable (write, rename, rm) afterwards', async () => {
      const { moduleRef, service } = await createModule({ files: { 'x/y.txt': 'y' } });
      expect(await service.readFile('x/y.txt', 'utf8')).toBe('y');
      await service.rename('x/y.txt', 'z.txt');
      await service.rm('x', { recursive: true });
      expect(await service.readdir('')).toEqual(['z.txt']);
      await moduleRef.close();
    });

    it('rejects a seed path that escapes the prefix', async () => {
      await expect(createModule({ prefix: '/seeded', files: { '../evil.txt': 'x' } })).rejects.toThrow(
        /escapes the storage prefix/,
      );
    });

    it('is applied per instance', async () => {
      const options = { files: { 'a.txt': 'a' } };
      const first = await createModule(options);
      await first.service.writeFile('a.txt', 'changed');
      const second = await createModule(options);
      expect(await second.service.readFile('a.txt', 'utf8')).toBe('a');
      await first.moduleRef.close();
      await second.moduleRef.close();
    });
  });

  it.each(['../x', 'a/../../x', '..'])('rejects the escaping path %p', async (p) => {
    const { moduleRef, service } = await createModule({ prefix: '/jail/inner' });
    await expect(service.writeFile(p, 'x')).rejects.toThrow(/escapes the storage prefix/);
    await expect(service.readFile(p)).rejects.toThrow(/escapes the storage prefix/);
    expect(() => service.createReadStream(p)).toThrow(/escapes the storage prefix/);
    await expect(service.readdir('..')).rejects.toThrow(/escapes the storage prefix/);
    await moduleRef.close();
  });

  it('does not treat a sibling that merely shares the prefix string as inside', async () => {
    const { moduleRef, service } = await createModule({ prefix: '/jail/inner' });
    await expect(service.writeFile('../inner2/x', 'x')).rejects.toThrow(/escapes the storage prefix/);
    await moduleRef.close();
  });

  it("with the '/' root, '..' cannot climb out (path.resolve clamps it) and absolute-looking paths stay inside", async () => {
    const { moduleRef, service } = await createModule();
    await service.writeFile('/abs.txt', 'x');
    expect(await service.readdir('')).toEqual(['abs.txt']);
    await moduleRef.close();
  });

  it('never touches the real disk', async () => {
    const name = `memory-backend-${randomUUID()}`;
    const prefix = path.join(process.cwd(), `${name}-prefix`);
    const { moduleRef, service } = await createModule({ prefix });
    const relative = createModule();

    await service.writeFile(`${name}.txt`, 'x');
    await service.mkdir(`${name}-dir/nested`);
    await service.copyFile(`${name}.txt`, `${name}-copy.txt`);
    await service.createWriteStream(`${name}-stream.txt`).end('streamed');
    await (await relative).service.writeFile(`${name}-relative.txt`, 'x');

    expect(await service.readFile(`${name}.txt`, 'utf8')).toBe('x');
    for (const candidate of [
      prefix,
      path.join(prefix, `${name}.txt`),
      path.join(process.cwd(), `${name}.txt`),
      path.join(process.cwd(), `${name}-relative.txt`),
      path.join('/', `${name}-relative.txt`),
    ]) {
      expect(fs.existsSync(candidate)).toBe(false);
    }
    await moduleRef.close();
    await (await relative).moduleRef.close();
  });

  it('streams work end to end (write, ranged read, encoding)', async () => {
    const { moduleRef, service } = await createModule();
    const ws = service.createWriteStream('s.txt');
    await new Promise<void>((resolve, reject) => {
      ws.on('finish', resolve).on('error', reject);
      ws.end('0123456789');
    });
    expect((await collect(service.createReadStream('s.txt', { start: 2, end: 4 }))).toString()).toBe('234');
    expect((await collect(service.createReadStream('s.txt', { end: 3 }))).toString()).toBe('0123');
    expect(await collect(service.createReadStream('s.txt', { encoding: 'hex' }))).toEqual(
      Buffer.from('30313233343536373839'),
    );
    await moduleRef.close();
  });

  describe('signed URLs', () => {
    it('throw and name the memory type', async () => {
      const { moduleRef, service } = await createModule();
      await expect(service.getSignedUrl('a.txt')).rejects.toThrow('Signed URLs are not supported for memory storage.');
      await expect(service.getSignedPutUrl('a.txt')).rejects.toThrow(
        'Signed URLs are not supported for memory storage.',
      );
      await moduleRef.close();
    });

    it('still name the filesystem for the fileSystem type', async () => {
      const service = new StorageService({ type: 'fileSystem', prefix: '/tmp' });
      await expect(service.getSignedUrl('a.txt')).rejects.toThrow(
        'Signed URLs are not supported for filesystem storage.',
      );
    });
  });

  describe('missing memfs', () => {
    afterEach(() => {
      jest.dontMock('memfs');
    });

    it('throws a clear error when the optional peer dependency is not installed', () => {
      jest.isolateModules(() => {
        jest.doMock('memfs', () => {
          throw Object.assign(new Error("Cannot find module 'memfs'"), { code: 'MODULE_NOT_FOUND' });
        });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { StorageService: Isolated } = require('../lib/storage.service');
        expect(() => new Isolated({ type: 'memory' })).toThrow(
          `type 'memory' requires the optional peer dependency "memfs": npm install memfs`,
        );
      });
    });

    it('does not load memfs for the other backends', () => {
      jest.isolateModules(() => {
        jest.doMock('memfs', () => {
          throw new Error('memfs must not be loaded');
        });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { StorageService: Isolated } = require('../lib/storage.service');
        expect(() => new Isolated({ type: 'fileSystem', prefix: '/tmp' })).not.toThrow();
        expect(() => new Isolated({ type: 's3', bucket: 'b' })).not.toThrow();
      });
    });
  });
});
