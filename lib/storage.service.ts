import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { MODULE_OPTIONS_TOKEN } from './storage.module-definition';
import { StorageModuleOptions } from './interfaces';
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsCommand,
  ListObjectsCommandInput,
  ListObjectsCommandOutput,
  PutObjectCommand,
  PutObjectCommandOutput,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import * as fs from 'fs';
import * as path from 'path';
import * as stream from 'stream';
import { PassThrough, Readable } from 'stream';

@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private s3Client: S3Client | undefined;

  private readonly useFileSystem: boolean = false;
  private readonly prefix: string;
  private readonly endpoint?: string;
  private readonly region?: string;
  private readonly bucket?: string;
  private readonly accessKeyId?: string;
  private readonly secretAccessKey?: string;

  constructor(@Inject(MODULE_OPTIONS_TOKEN) private options: StorageModuleOptions) {
    switch (options.type) {
      case 's3':
        this.endpoint = options.endpoint;
        this.region = options.region;
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

  async exists(_path: string, bucket?: string): Promise<boolean> {
    if (this.useFileSystem) {
      return fs.existsSync(path.join(this.prefix, _path));
    } else {
      if (typeof bucket !== 'string') {
        bucket = this.bucket;
      }

      return this.s3Client!.send(
        new ListObjectsCommand({ Bucket: bucket, Delimiter: '/', Prefix: this.normalizeKey(_path) }),
      ).then((output: ListObjectsCommandOutput) => {
        if (output.Contents && output.Prefix) {
          for (const content of output.Contents) {
            if (content.Key === output.Prefix) {
              return true;
            }
            if (content.Key === output.Prefix + '/') {
              return true;
            }
          }
        }

        return false;
      });
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

      return this.s3Client!.send(new GetObjectCommand({ Bucket: bucket, Key: this.normalizeKey(filePath) })).then(
        (data) => streamToBuffer(data.Body as Readable),
      );
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

  createReadStream(filePath: string, bucket?: string): fs.ReadStream | Readable {
    if (this.useFileSystem) {
      return fs.createReadStream(path.join(this.prefix, filePath));
    } else {
      if (typeof bucket !== 'string') {
        bucket = this.bucket;
      }

      const pass = new stream.PassThrough();

      this.s3Client!.send(new GetObjectCommand({ Bucket: bucket, Key: this.normalizeKey(filePath) })).then((data) => {
        const _stream = data.Body as Readable;
        _stream.on('data', (chunk) => pass.push(chunk));
        _stream.on('end', () => pass.end());
      });

      return pass;
    }
  }

  createWriteStream(
    filePath: string,
    options = { highWaterMark: 1024 * 1024 * 10 },
    bucket?: string,
  ): fs.WriteStream | PassThrough {
    if (options.highWaterMark < 1024 * 1024 * 5) {
      throw new Error('Option: highWaterMark is smaller than the minimum size of 5MB');
    }

    if (this.useFileSystem) {
      return fs.createWriteStream(path.join(this.prefix, filePath), options);
    } else {
      if (typeof bucket !== 'string') {
        bucket = this.bucket;
      }

      const pass = new stream.PassThrough();

      const upload = new Upload({
        client: this.s3Client!,
        params: { Bucket: bucket, Key: this.normalizeKey(filePath), Body: pass },

        queueSize: 4, // optional concurrency configuration
        partSize: options.highWaterMark, // optional size of each part, in bytes, at least 5MB
        leavePartsOnError: false, // optional manually handle dropped parts
      });

      upload.done().then();

      return pass;
    }
  }
}
