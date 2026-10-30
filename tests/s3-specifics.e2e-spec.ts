import { Test } from '@nestjs/testing';
import { ListObjectsV2Command } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { StorageModule, StorageService } from '../lib';
import {
  createCtx,
  describeBackends,
  describeS3,
  expectFsError,
  S3_BACKEND,
  S3_ENDPOINT,
  s3Options,
  useCtx,
} from './support/harness';

describeBackends('signed URLs on the filesystem', (backend) => {
  if (backend.isS3) return;
  const h = useCtx(backend, 'signed-fs');

  it('throw on the filesystem backend', async () => {
    await expect(h.ctx.service.getSignedUrl('a.txt')).rejects.toThrow('Signed URLs are not supported');
    await expect(h.ctx.service.getSignedPutUrl('a.txt')).rejects.toThrow('Signed URLs are not supported');
  });
});

describeS3('S3 client and signed URLs', () => {
  it('creates the client without explicit credentials from the AWS_* environment', async () => {
    const saved = {
      id: process.env.AWS_ACCESS_KEY_ID,
      secret: process.env.AWS_SECRET_ACCESS_KEY,
      token: process.env.AWS_SESSION_TOKEN,
    };
    process.env.AWS_ACCESS_KEY_ID = 'env-key-id';
    process.env.AWS_SECRET_ACCESS_KEY = 'env-secret';
    delete process.env.AWS_SESSION_TOKEN;
    let ctx;
    try {
      ctx = await createCtx(S3_BACKEND, 'env-creds', {
        overrides: { accessKeyId: undefined, secretAccessKey: undefined },
      });
      const client = ctx.service.s3client!;
      expect(client).toBeDefined();
      const credentials = await client.config.credentials();
      expect(credentials.accessKeyId).toBe('env-key-id');
      expect(credentials.secretAccessKey).toBe('env-secret');

      await ctx.service.writeFile('env.txt', 'works');
      expect((await ctx.service.readFile('env.txt')).toString()).toBe('works');
    } finally {
      await ctx?.close();
      for (const [key, value] of [
        ['AWS_ACCESS_KEY_ID', saved.id],
        ['AWS_SECRET_ACCESS_KEY', saved.secret],
        ['AWS_SESSION_TOKEN', saved.token],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('uses explicit credentials when given', async () => {
    const ctx = await createCtx(S3_BACKEND, 'explicit-creds', {
      overrides: { accessKeyId: 'explicit-id', secretAccessKey: 'explicit-secret' },
    });
    try {
      const credentials = await ctx.service.s3client!.config.credentials();
      expect(credentials.accessKeyId).toBe('explicit-id');
    } finally {
      await ctx.close();
    }
  });

  it('getSignedUrl returns a working GET URL; response overrides apply', async () => {
    const ctx = await createCtx(S3_BACKEND, 'signed-get');
    try {
      const { service } = ctx;
      await service.writeFile('signed/hello.txt', 'signed hello');
      const url = await service.getSignedUrl('signed/hello.txt', { expiresIn: 120 });
      expect(url).toContain('X-Amz-Signature');
      expect(url).toContain('X-Amz-Expires=120');
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('signed hello');

      const custom = await service.getSignedUrl('signed/hello.txt', {
        responseContentType: 'application/x-custom',
        responseContentDisposition: 'attachment; filename="x.txt"',
      });
      const customResponse = await fetch(custom);
      expect(customResponse.headers.get('content-type')).toContain('application/x-custom');
      expect(customResponse.headers.get('content-disposition')).toContain('attachment');
    } finally {
      await ctx.close();
    }
  });

  it('getSignedPutUrl returns a working PUT URL', async () => {
    const ctx = await createCtx(S3_BACKEND, 'signed-put');
    try {
      const { service } = ctx;
      const url = await service.getSignedPutUrl('upload/new.txt', { contentType: 'text/plain' });
      const response = await fetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: 'uploaded via signed url',
      });
      expect(response.status).toBe(200);
      expect((await service.readFile('upload/new.txt')).toString()).toBe('uploaded via signed url');
      expect((await service.stat('upload/new.txt')).contentType).toBe('text/plain');
    } finally {
      await ctx.close();
    }
  });

  it('signs for another bucket when asked to', async () => {
    const ctx = await createCtx(S3_BACKEND, 'signed-bucket');
    try {
      const url = await ctx.service.getSignedUrl('x.txt', { bucket: 'other-bucket' });
      expect(new URL(url).pathname.startsWith('/other-bucket/')).toBe(true);
    } finally {
      await ctx.close();
    }
  });

  const local = ['localhost', '127.0.0.1'].includes(new URL(S3_ENDPOINT || 'http://x').hostname);
  (local ? describe : describe.skip)('endpointCDN', () => {
    const port = new URL(S3_ENDPOINT || 'http://localhost:1').port;
    const overrides = { endpoint: `http://localhost:${port}`, endpointCDN: `http://127.0.0.1:${port}` };

    it('rewrites the host of signed GET and PUT URLs', async () => {
      const ctx = await createCtx(S3_BACKEND, 'cdn-urls', { overrides });
      try {
        const get = new URL(await ctx.service.getSignedUrl('a.txt'));
        const put = new URL(await ctx.service.getSignedPutUrl('a.txt'));
        expect(get.host).toBe(`127.0.0.1:${port}`);
        expect(put.host).toBe(`127.0.0.1:${port}`);

        await ctx.service.writeFile('cdn/a.txt', 'cdn content');
        const response = await fetch(await ctx.service.getSignedUrl('cdn/a.txt'));
        expect(await response.text()).toBe('cdn content');
      } finally {
        await ctx.close();
      }
    });

    it('readFile goes through the CDN host; a 404 rejects', async () => {
      const ctx = await createCtx(S3_BACKEND, 'cdn-read', { overrides });
      try {
        const { service } = ctx;
        await service.writeFile('cdn/a.txt', 'cdn content');

        const requested: string[] = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = ((input: any, init?: any) => {
          requested.push(String(input));
          return originalFetch(input, init);
        }) as typeof fetch;
        try {
          expect((await service.readFile('cdn/a.txt')).toString()).toBe('cdn content');
          await expectFsError(service.readFile('cdn/missing.txt'), {
            code: 'ENOENT',
            syscall: 'open',
            path: 'cdn/missing.txt',
          });
        } finally {
          globalThis.fetch = originalFetch;
        }
        expect(requested).toHaveLength(2);
        for (const url of requested) expect(new URL(url).host).toBe(`127.0.0.1:${port}`);
      } finally {
        await ctx.close();
      }
    });
  });
});

describeS3('buckets and options (S3)', () => {
  it('addresses another bucket via the bucket option (rejects when it does not exist)', async () => {
    const ctx = await createCtx(S3_BACKEND, 'other-bucket');
    try {
      await expect(ctx.service.writeFile('a.txt', 'x', { bucket: 'no-such-bucket' })).rejects.toThrow();
      await expect(ctx.service.readFile('a.txt', { bucket: 'no-such-bucket' })).rejects.toThrow();
      await expect(ctx.service.stat('a.txt', { bucket: 'no-such-bucket' })).rejects.toThrow();
    } finally {
      await ctx.close();
    }
  });

  it('writes and reads through the raw client consistently with the service', async () => {
    const ctx = await createCtx(S3_BACKEND, 'raw');
    try {
      await ctx.service.writeFile('raw.txt', 'x');
      const out = await ctx.service.s3client!.send(
        new ListObjectsV2Command({ Bucket: 'test', Prefix: `${ctx.prefix}/` }),
      );
      expect(out.Contents?.map((c) => c.Key)).toEqual([`${ctx.prefix}/raw.txt`]);
    } finally {
      await ctx.close();
    }
  });

  it('works without an S3 prefix at all', async () => {
    const key = `noprefix-${randomUUID().slice(0, 8)}`;
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot(s3Options('', { prefix: undefined }))],
    }).compile();
    await moduleRef.init();
    const service = moduleRef.get(StorageService);
    try {
      await service.writeFile(`${key}/a.txt`, 'x');
      expect(await service.readdir(key)).toEqual(['a.txt']);
    } finally {
      await service.rmdir(key);
      await moduleRef.close();
    }
  });
});
