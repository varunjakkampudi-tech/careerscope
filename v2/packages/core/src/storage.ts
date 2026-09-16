import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetBucketAclCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { z } from 'zod';
import { localEndpoint } from './queue.js';

export const maximumResumeBytes = 5 * 1024 * 1024;

const objectSchema = z
  .object({
    ownerId: z.string().uuid(),
    resumeId: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().min(1).max(maximumResumeBytes),
    contentType: z.enum([
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]),
  })
  .strict();

export type ResumeObject = z.infer<typeof objectSchema>;

export const resumeUploadMetadataSchema = objectSchema.pick({
  sha256: true,
  bytes: true,
  contentType: true,
});

export function storageConfiguration(source: NodeJS.ProcessEnv = process.env) {
  const values: Record<string, string | undefined> = {};
  const suffixes = ['ENDPOINT', 'BUCKET', 'ACCESS_KEY', 'SECRET_KEY'];
  const canonical = suffixes.some((suffix) => source[`S3_${suffix}`] !== undefined);
  for (const suffix of suffixes) {
    const current = source[`S3_${suffix}`];
    const legacy = source[`MINIO_${suffix}`];
    if (current !== undefined && legacy !== undefined && current !== legacy) {
      throw new Error(`Conflicting S3_${suffix} and legacy configuration`);
    }
    values[`S3_${suffix}`] = canonical ? current : legacy;
  }
  return z
    .object({
      S3_ENDPOINT: z.string().transform(localEndpoint),
      S3_BUCKET: z.string().regex(/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/),
      S3_ACCESS_KEY: z.string().min(1),
      S3_SECRET_KEY: z.string().min(16),
    })
    .parse(values);
}

function objectKey(object: ResumeObject) {
  const parsed = objectSchema.parse(object);
  return `owners/${parsed.ownerId}/resumes/${parsed.resumeId}/${parsed.sha256}`;
}

function operationSignal(signal?: AbortSignal) {
  return AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
}

function validateBody(object: ResumeObject, body: Uint8Array) {
  objectSchema.parse(object);
  if (
    body.byteLength !== object.bytes ||
    createHash('sha256').update(body).digest('hex') !== object.sha256
  ) {
    throw new Error('Resume object integrity check failed');
  }
}

export class PrivateResumeStorage {
  private readonly client: S3Client;
  readonly bucket: string;
  private ready = false;

  constructor(config: NodeJS.ProcessEnv) {
    const parsed = storageConfiguration(config);
    this.bucket = parsed.S3_BUCKET;
    this.client = new S3Client({
      endpoint: parsed.S3_ENDPOINT,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: parsed.S3_ACCESS_KEY,
        secretAccessKey: parsed.S3_SECRET_KEY,
      },
      maxAttempts: 1,
    });
  }

  async initialize(signal?: AbortSignal) {
    this.ready = false;
    const options = { abortSignal: operationSignal(signal) };
    const versioning = await this.client.send(
      new GetBucketVersioningCommand({ Bucket: this.bucket }),
      options,
    );
    if (versioning.Status !== 'Enabled')
      throw new Error('Resume bucket must have versioning enabled');
    const acl = await this.client.send(new GetBucketAclCommand({ Bucket: this.bucket }), options);
    if (
      !acl.Owner?.ID ||
      !acl.Grants?.length ||
      acl.Grants.some(
        (grant) => grant.Grantee?.Type !== 'CanonicalUser' || grant.Grantee.ID !== acl.Owner?.ID,
      )
    )
      throw new Error('Resume bucket must be private');
    try {
      await this.client.send(new GetBucketPolicyCommand({ Bucket: this.bucket }), options);
      throw new Error('Resume bucket policies are not supported; use private identity policies');
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'NoSuchBucketPolicy') throw error;
    }
    this.ready = true;
  }

  async put(object: ResumeObject, body: Uint8Array, signal?: AbortSignal) {
    objectSchema.parse(object);
    if (body.byteLength !== object.bytes) throw new Error('Resume object size mismatch');
    const data = Buffer.from(body);
    validateBody(object, data);
    if (!this.ready) throw new Error('Resume storage is not initialized');
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: objectKey(object),
        Body: data,
        ContentLength: object.bytes,
        ContentType: object.contentType,
        ChecksumSHA256: Buffer.from(object.sha256, 'hex').toString('base64'),
        IfNoneMatch: '*',
      }),
      { abortSignal: operationSignal(signal) },
    );
    if (!result.VersionId || result.VersionId === 'null') {
      throw new Error('Resume bucket must have versioning enabled');
    }
    return result.VersionId;
  }

  async get(object: ResumeObject, versionId: string, signal?: AbortSignal) {
    const key = objectKey(object);
    z.string()
      .min(1)
      .max(1024)
      .refine((value) => value !== 'null')
      .parse(versionId);
    const abortSignal = operationSignal(signal);
    const result = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        VersionId: versionId,
      }),
      { abortSignal },
    );
    const body = result.Body;
    if (!body || !('destroy' in body)) throw new Error('Resume object stream unavailable');
    const abort = () => body.destroy(new Error('Resume read interrupted'));
    abortSignal.addEventListener('abort', abort, { once: true });
    try {
      abortSignal.throwIfAborted();
      if (
        result.ContentLength !== object.bytes ||
        result.ContentType !== object.contentType ||
        result.VersionId !== versionId
      ) {
        throw new Error('Resume object metadata mismatch');
      }
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of body) {
        abortSignal.throwIfAborted();
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > object.bytes) throw new Error('Resume object exceeds expected size');
        chunks.push(buffer);
      }
      const data = Buffer.concat(chunks, bytes);
      validateBody(object, data);
      return data;
    } finally {
      abortSignal.removeEventListener('abort', abort);
      body.destroy();
    }
  }

  async recoverVersion(object: ResumeObject, signal?: AbortSignal): Promise<string | null> {
    const key = objectKey(object);
    const abortSignal = operationSignal(signal);
    let version: string | undefined;
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
        { abortSignal },
      );
      version = result.VersionId;
      if (result.ContentLength !== object.bytes || result.ContentType !== object.contentType) {
        throw new Error('Resume object metadata mismatch');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'NotFound') return null;
      throw error;
    }
    if (!version || version === 'null') throw new Error('Resume object version unavailable');
    await this.get(object, version, abortSignal);
    return version;
  }

  async delete(object: ResumeObject, versionId: string, signal?: AbortSignal) {
    const key = objectKey(object);
    z.string()
      .min(1)
      .max(1024)
      .refine((value) => value !== 'null')
      .parse(versionId);
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
        VersionId: versionId,
      }),
      { abortSignal: operationSignal(signal) },
    );
  }

  close() {
    this.ready = false;
    this.client.destroy();
  }
}
