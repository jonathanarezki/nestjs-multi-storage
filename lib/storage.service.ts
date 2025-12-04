import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MODULE_OPTIONS_TOKEN } from './storage.module-definition';
import { StorageModuleOptions } from './interfaces';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsCommand,
  ListObjectsCommandInput,
  ListObjectsCommandOutput,
  PutObjectCommand,
  PutObjectCommandOutput,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';
import { PassThrough, Readable } from 'stream';
import * as fetch from 'node-fetch';

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private s3Client: S3Client | undefined;

  private readonly useFileSystem: boolean = false;
  private readonly prefix: string;
  private readonly endpoint?: string;
  private readonly endpointCDN?: string;
  private readonly region?: string;
  private readonly forcePathStyle?: boolean;
  private readonly bucket?: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;

  constructor(@Inject(MODULE_OPTIONS_TOKEN) private options: StorageModuleOptions) {
    switch (options.type) {
      case 's3':
        this.endpoint = options.endpoint;
        this.endpointCDN = options.endpointCDN;
        this.region = options.region;
        this.forcePathStyle = options.forcePathStyle;
        this.bucket = options.bucket;
        this.accessKeyId = options.accessKeyId;
        this.secretAccessKey = options.secretAccessKey;
        break;
      case 'fileSystem':
      default:
        this.useFileSystem = true;
        break;
    }

    this.prefix = options.prefix ?? '';
  }

  get s3client() {
    return this.s3Client;
  }

  async onModuleInit() {
    if (!this.useFileSystem && this.endpoint && this.region && this.accessKeyId && this.secretAccessKey) {
      this.s3Client = new S3Client({
        endpoint: this.endpoint,
        region: this.region,
        forcePathStyle: this.forcePathStyle ?? undefined,
        credentials: {
          accessKeyId: this.accessKeyId,
          secretAccessKey: this.secretAccessKey,
        },
      });
    }
  }

  async onModuleDestroy() {
    return this.s3Client?.destroy();
  }

  private normalizeDirKey(key: string) {
    return `${path.normalize(key)}/`.replace(/\\+/g, '/').replace(/\/+/g, '/').replace(/^\//, '/');
  }

  private normalizeKey(key: string) {
    return path.normalize(key).replace(/\\+/g, '/').replace(/\/+/g, '/').replace(/^\//, '/').replace(/\/+$/, '');
  }

  async mkdir(folderPath: string, bucket?: string): Promise<PutObjectCommandOutput | string | undefined> {
    if (this.useFileSystem) {
      return fs.promises.mkdir(path.join(this.prefix, folderPath), { recursive: true });
    } else {
      if (typeof bucket !== 'string') {
        bucket = this.bucket;
      }

      await this.s3Client!.send(
        new PutObjectCommand({ Bucket: bucket, Key: this.normalizeDirKey(folderPath), Body: '', ContentLength: 0 }),
      );
    }
  }

  async readdir(folderPath: string, bucket?: string): Promise<string[]> {
    if (this.useFileSystem) {
      return fs.promises.readdir(path.join(this.prefix, folderPath));
    } else {
      if (typeof bucket !== 'string') {
        bucket = this.bucket;
      }

      const bucketParams: ListObjectsCommandInput = {
        Bucket: bucket,
        Delimiter: '/',
        Prefix: this.normalizeDirKey(folderPath),
      };
      const list: string[] = [];

      // Declare truncated as a flag that the while loop is based on.
      let truncated = true;
      // Declare a variable to which the key of the last element is assigned to in the response.
      let pageMarker;
      // while loop that runs until 'response.truncated' is false.
      while (truncated) {
        try {
          await this.s3Client!.send(new ListObjectsCommand(bucketParams)).then((output: ListObjectsCommandOutput) => {
            output.Contents?.forEach((content) => {
              const key = content.Key?.replace(output.Prefix ?? '', '').replace(/\/+$/, '') ?? '';
              if (key.length) {
                list.push(key);
              }
            });

            output.CommonPrefixes?.forEach((prefix) => {
              const key = prefix.Prefix?.replace(output.Prefix ?? '', '').replace(/\/+$/, '') ?? '';
              if (key.length) {
                list.push(key);
              }
            });

            truncated = output.IsTruncated ?? false;

            if (truncated && output.Contents) {
              pageMarker = output.Contents.slice(-1)[0].Key;
              if (pageMarker) {
                bucketParams.Marker = pageMarker;
              } else {
                truncated = false;
              }
            }
          });
        } catch (err) {
          console.log('Error', err);
          truncated = false;
        }
      }

      return list.sort();
    }
  }

  async rmdir(folderPath: string, bucket?: string): Promise<void> {
    if (this.useFileSystem) {
      return fs.promises.rm(path.join(this.prefix, folderPath), { recursive: true });
    } else {
      if (typeof bucket !== 'string') {
        bucket = this.bucket;
      }

      const keys = await this.s3Client!.send(
        new ListObjectsCommand({ Bucket: bucket, Prefix: this.normalizeDirKey(folderPath) }),
      ).then((output: ListObjectsCommandOutput) => {
        const list: string[] = [];

        output.Contents?.forEach((content) => {
          list.push(content.Key ?? '');
        });

        return list.sort().reverse();
      });

      await this.s3Client!.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((key) => ({ Key: key })) } }),
      );
    }
  }

  async exists(p: string, bucket?: string): Promise<boolean> {
    if (this.useFileSystem) {
      return fs.existsSync(path.join(this.prefix, p));
    }

    bucket ??= this.bucket;

    const key = this.normalizeKey(p);

    try {
      await this.s3Client!.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404) {
        try {
          await this.s3Client!.send(new HeadObjectCommand({ Bucket: bucket, Key: this.normalizeDirKey(p) }));
          return true;
        } catch {
          return false;
        }
      }
      throw e;
    }
  }

  async readFile(filePath: string, bucket?: string): Promise<Buffer> {
    if (this.useFileSystem) {
      return fs.promises.readFile(path.join(this.prefix, filePath));
    } else {
      if (typeof bucket !== 'string') {
        bucket = this.bucket;
      }

      const streamToBuffer: (_stream: stream) => Promise<Buffer> = (_stream) => {
        return new Promise((resolve, reject) => {
          const chunks: Buffer[] = [];
          _stream.on('data', (chunk) => chunks.push(chunk));
          _stream.on('error', reject);
          _stream.on('end', () => resolve(Buffer.concat(chunks)));
        });
      };

      if (this.endpointCDN) {
        return getSignedUrl(
          this.s3Client as any,
          new GetObjectCommand({ Bucket: bucket, Key: this.normalizeKey(filePath) }) as any,
          {
            expiresIn: 60,
          },
        ).then(async (result) => {
          const path = result.replace(
            this.endpoint!.replace(/(^\w+:|^)\/\//, ''),
            this.endpointCDN!.replace(/(^\w+:|^)\/\//, ''),
          );
          return fetch(path)
            .then((response) => response.buffer())
            .catch((error) => {
              throw error;
            });
        });
      } else {
        return this.s3Client!.send(new GetObjectCommand({ Bucket: bucket, Key: this.normalizeKey(filePath) })).then(
          (data) => streamToBuffer(data.Body as Readable),
        );
      }
    }
  }

  async writeFile(filePath: string, data: string | Buffer, bucket?: string): Promise<void> {
    if (this.useFileSystem) {
      return fs.promises.writeFile(path.join(this.prefix, filePath), data);
    } else {
      if (typeof bucket !== 'string') {
        bucket = this.bucket;
      }

      if (typeof data === 'string') {
        data = Buffer.from(data);
      }
      await this.s3Client!.send(new PutObjectCommand({ Bucket: bucket, Key: this.normalizeKey(filePath), Body: data }));
    }
  }

  public async getSignedUrl(
    filePath: string,
    opts?: { bucket?: string; expiresIn?: number; responseContentDisposition?: string },
  ): Promise<string> {
    if (this.useFileSystem) {
      throw new Error('Signed URLs are not supported for filesystem storage.');
    }

    const bucket = opts?.bucket ?? this.bucket!;
    const command = new GetObjectCommand({
      Bucket: bucket,
      Key: this.normalizeKey(filePath),
      ResponseContentDisposition: opts?.responseContentDisposition,
    });

    const url = await getSignedUrl(this.s3Client!, command, { expiresIn: opts?.expiresIn ?? 60 });

    if (this.endpointCDN && this.endpoint) {
      return url.replace(this.endpoint.replace(/(^\w+:|^)\/\//, ''), this.endpointCDN.replace(/(^\w+:|^)\/\//, ''));
    }
    return url;
  }

  public async getSignedPutUrl(
    filePath: string,
    opts?: { bucket?: string; expiresIn?: number; contentType?: string },
  ): Promise<string> {
    if (this.useFileSystem) {
      throw new Error('Signed URLs are not supported for filesystem storage.');
    }

    const bucket = opts?.bucket ?? this.bucket!;
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: this.normalizeKey(filePath),
      ContentType: opts?.contentType,
    });

    const url = await getSignedUrl(this.s3Client!, command, { expiresIn: opts?.expiresIn ?? 60 });

    if (this.endpointCDN && this.endpoint) {
      return url.replace(this.endpoint.replace(/(^\w+:|^)\/\//, ''), this.endpointCDN.replace(/(^\w+:|^)\/\//, ''));
    }
    return url;
  }

  async rm(filePath: string, bucket?: string): Promise<void> {
    if (this.useFileSystem) {
      return fs.promises.rm(path.join(this.prefix, filePath));
    } else {
      if (typeof bucket !== 'string') {
        bucket = this.bucket;
      }

      await this.s3Client!.send(new DeleteObjectCommand({ Bucket: bucket, Key: this.normalizeKey(filePath) }));
    }
  }

  createReadStream(filePath: string, opts?: { start?: number; end?: number }, bucket?: string): Readable {
    if (this.useFileSystem) {
      return fs.createReadStream(path.join(this.prefix, filePath), opts as any);
    }

    bucket ??= this.bucket;

    const Range =
      typeof opts?.start === 'number' || typeof opts?.end === 'number'
        ? `bytes=${opts?.start ?? 0}-${typeof opts?.end === 'number' ? opts.end : ''}`
        : undefined;

    const pass = new PassThrough();

    this.s3Client!.send(new GetObjectCommand({ Bucket: bucket, Key: this.normalizeKey(filePath), Range }))
      .then(({ Body }) => (Body as Readable).pipe(pass))
      .catch((err) => pass.destroy(err));

    return pass;
  }

  createWriteStream(
    filePath: string,
    options?: { highWaterMark?: number; partSize?: number; queueSize?: number },
    bucket?: string,
  ) {
    if (this.useFileSystem) {
      return fs.createWriteStream(path.join(this.prefix, filePath), options as any);
    }

    bucket ??= this.bucket;

    const pass = new PassThrough({ highWaterMark: options?.highWaterMark });

    const upload = new Upload({
      client: this.s3Client!,
      params: { Bucket: bucket, Key: this.normalizeKey(filePath), Body: pass },
      queueSize: options?.queueSize ?? 4,
      partSize: Math.max(options?.partSize ?? 5 * 1024 * 1024, 5 * 1024 * 1024),
      leavePartsOnError: false,
    });

    upload.done().then(
      () => pass.emit('finish'),
      (err) => pass.destroy(err),
    );

    return pass;
  }
}
