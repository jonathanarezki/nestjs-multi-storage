import { HeadObjectCommand } from '@aws-sdk/client-s3';
import {
  collect,
  createCtx,
  describeBackends,
  describeS3,
  S3_BACKEND,
  S3_BUCKET,
  sleep,
  useCtx,
} from './support/harness';

const MiB = 1024 * 1024;

describeBackends('streams', (backend) => {
  const h = useCtx(backend, 'streams');

  it('createReadStream reads the whole file', async () => {
    const { service } = h.ctx;
    await service.writeFile('s.txt', 'abcdefghij');
    expect((await collect(service.createReadStream('s.txt'))).toString()).toBe('abcdefghij');
  });

  it('createReadStream honours start/end (inclusive)', async () => {
    const { service } = h.ctx;
    await service.writeFile('s.txt', 'abcdefghij');
    expect((await collect(service.createReadStream('s.txt', { start: 2, end: 5 }))).toString()).toBe('cdef');
    expect((await collect(service.createReadStream('s.txt', { start: 7 }))).toString()).toBe('hij');
    expect((await collect(service.createReadStream('s.txt', { end: 3 }))).toString()).toBe('abcd');
  });

  it('createReadStream emits error for a missing file', async () => {
    await expect(collect(h.ctx.service.createReadStream('missing.txt'))).rejects.toThrow();
  });

  it('createWriteStream writes a small file; finish fires once', async () => {
    const { service } = h.ctx;
    const ws = service.createWriteStream('w.txt');
    let finishes = 0;
    ws.on('finish', () => finishes++);
    await new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('close', () => resolve());
      ws.write('hello ');
      ws.end('world');
    });
    expect(finishes).toBe(1);
    expect((await service.readFile('w.txt')).toString()).toBe('hello world');
  });

  it('createWriteStream: 12 MiB (multipart on S3), finish once, object exists at finish', async () => {
    const { service } = h.ctx;
    await service.mkdir('big');
    const ws = service.createWriteStream('big/stream.bin');
    const chunk = Buffer.alloc(MiB, 1);
    let finishes = 0;
    let existsAtFinish: Promise<boolean> | undefined;
    const finished = new Promise<void>((resolve, reject) => {
      ws.on('error', reject);
      ws.on('finish', () => {
        finishes++;
        existsAtFinish = service.exists('big/stream.bin');
        resolve();
      });
    });
    for (let i = 0; i < 12; i++) if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
    ws.end();
    await finished;
    expect(await existsAtFinish).toBe(true);
    expect((await service.stat('big/stream.bin')).size).toBe(12 * MiB);
    await sleep(200);
    expect(finishes).toBe(1);
    expect((await service.readFile('big/stream.bin')).length).toBe(12 * MiB);
  });

  it('pipes a read stream into a write stream', async () => {
    const { service } = h.ctx;
    await service.writeFile('src.txt', 'piped content');
    await new Promise<void>((resolve, reject) => {
      const ws = service.createWriteStream('dst.txt');
      ws.on('error', reject);
      ws.on('finish', () => resolve());
      service.createReadStream('src.txt').on('error', reject).pipe(ws);
    });
    expect((await service.readFile('dst.txt')).toString()).toBe('piped content');
  });
});

describeS3('write streams (S3 specifics)', () => {
  it('creates the object with the content type of the extension or the option', async () => {
    const ctx = await createCtx(S3_BACKEND, 'ws-ct');
    try {
      const { service } = ctx;
      await new Promise<void>((resolve, reject) => {
        const ws = service.createWriteStream('a.json', { contentType: 'application/x-custom' });
        ws.on('error', reject).on('finish', () => resolve());
        ws.end('{}');
      });
      await new Promise<void>((resolve, reject) => {
        const ws = service.createWriteStream('b.json');
        ws.on('error', reject).on('finish', () => resolve());
        ws.end('{}');
      });
      expect((await service.stat('a.json')).contentType).toBe('application/x-custom');
      expect((await service.stat('b.json')).contentType).toBe('application/json');
    } finally {
      await ctx.close();
    }
  });

  it('surfaces an upload error (nonexistent bucket) as an error event', async () => {
    const ctx = await createCtx(S3_BACKEND, 'ws-err', { overrides: { bucket: 'no-such-bucket' } });
    try {
      const ws = ctx.service.createWriteStream('x.bin');
      let finished = false;
      ws.on('finish', () => (finished = true));
      await expect(
        new Promise((resolve, reject) => {
          ws.on('error', reject);
          ws.on('close', resolve);
          ws.end('data');
        }),
      ).rejects.toThrow();
      expect(finished).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  it('destroy() mid-upload leaves no object behind', async () => {
    const ctx = await createCtx(S3_BACKEND, 'ws-destroy');
    try {
      const { service } = ctx;
      const ws = service.createWriteStream('partial.bin');
      let finished = false;
      ws.on('finish', () => (finished = true));
      ws.on('error', () => undefined);
      const closed = new Promise((resolve) => ws.on('close', resolve));

      const chunk = Buffer.alloc(MiB, 2);
      for (let i = 0; i < 7; i++) if (!ws.write(chunk)) await new Promise((r) => ws.once('drain', r));
      await sleep(300); // let the first parts go out
      ws.destroy();
      await closed;
      await sleep(1000);

      expect(finished).toBe(false);
      expect(await service.exists('partial.bin')).toBe(false);
      await expect(
        service.s3client!.send(new HeadObjectCommand({ Bucket: S3_BUCKET, Key: `${ctx.prefix}/partial.bin` })),
      ).rejects.toMatchObject({ $metadata: { httpStatusCode: 404 } });
    } finally {
      await ctx.close();
    }
  });
});
