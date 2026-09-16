import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteBucketPolicyCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { PrivateResumeStorage } from './storage.js';
import { localEndpoint } from './queue.js';

test('local S3 version lifecycle, bucket privacy guard and immutable resume objects', async (context) => {
  const candidate = process.env.S3_CONTRACT_ENDPOINT;
  const configuredEndpoint = candidate ?? process.env.LOCAL_AWS_ENDPOINT;
  assert.ok(configuredEndpoint, 'Integration test requires an explicit local S3 endpoint');
  const endpoint = localEndpoint(configuredEndpoint);
  const accessKeyId = candidate ? process.env.S3_CONTRACT_ACCESS_KEY : 'local';
  const secretAccessKey = candidate ? process.env.S3_CONTRACT_SECRET_KEY : 'local-synthetic-secret';
  assert.ok(
    accessKeyId && secretAccessKey,
    'Candidate contract tests require explicit credentials',
  );
  const bucket = `test-resumes-${randomUUID()}`;
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
    maxAttempts: 1,
  });
  const storage = new PrivateResumeStorage({
    S3_ENDPOINT: endpoint,
    S3_BUCKET: bucket,
    S3_ACCESS_KEY: accessKeyId,
    S3_SECRET_KEY: secretAccessKey,
  });
  const options = () => ({ abortSignal: AbortSignal.timeout(10_000) });
  await client.send(new CreateBucketCommand({ Bucket: bucket }), options());
  context.after(async () => {
    storage.close();
    try {
      const objects = await client.send(
        new ListObjectVersionsCommand({ Bucket: bucket }),
        options(),
      );
      for (const item of [...(objects.Versions ?? []), ...(objects.DeleteMarkers ?? [])]) {
        await client.send(
          new DeleteObjectCommand({ Bucket: bucket, Key: item.Key, VersionId: item.VersionId }),
          options(),
        );
      }
      const remaining = await client.send(
        new ListObjectVersionsCommand({ Bucket: bucket }),
        options(),
      );
      assert.equal(remaining.Versions?.length ?? 0, 0, 'Cleanup must remove every version');
      assert.equal(
        remaining.DeleteMarkers?.length ?? 0,
        0,
        'Cleanup must remove every delete marker',
      );
      context.diagnostic('Version cleanup passed; deleting empty synthetic bucket');
      await client.send(new DeleteBucketCommand({ Bucket: bucket }), options());
    } finally {
      client.destroy();
    }
  });
  await assert.rejects(storage.initialize(), /versioning/);
  await client.send(
    new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: 'Enabled' },
    }),
    options(),
  );
  await storage.initialize();
  const data = Buffer.from('%PDF-1.7\nSynthetic storage fixture, not a parsed resume');
  const object = {
    ownerId: randomUUID(),
    resumeId: randomUUID(),
    sha256: createHash('sha256').update(data).digest('hex'),
    bytes: data.length,
    contentType: 'application/pdf' as const,
  };
  const version = await storage.put(object, data);
  assert.notEqual(version, 'null');
  assert.equal(await storage.recoverVersion(object), version);
  assert.equal(await storage.recoverVersion({ ...object, resumeId: randomUUID() }), null);
  await assert.rejects(storage.recoverVersion({ ...object, bytes: object.bytes + 1 }), /metadata/);
  assert.deepEqual(await storage.get(object, version), data);
  if (candidate) {
    const objectUrl = new URL(
      `/${bucket}/owners/${object.ownerId}/resumes/${object.resumeId}/${object.sha256}`,
      endpoint,
    );
    objectUrl.searchParams.set('versionId', version);
    const listingUrl = new URL(`/${bucket}`, endpoint);
    listingUrl.searchParams.set('list-type', '2');
    for (const [url, method] of [
      [objectUrl, 'GET'],
      [objectUrl, 'DELETE'],
      [new URL(objectUrl.pathname, endpoint), 'PUT'],
      [listingUrl, 'GET'],
    ] as const) {
      const response = await fetch(url, {
        method,
        body: method === 'PUT' ? data : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      assert.equal(response.status, 403, `Anonymous ${method} must be denied`);
    }
    const unauthorized = new PrivateResumeStorage({
      S3_ENDPOINT: endpoint,
      S3_BUCKET: bucket,
      S3_ACCESS_KEY: accessKeyId,
      S3_SECRET_KEY: `${secretAccessKey}-incorrect`,
    });
    const denied = (error: unknown) =>
      error instanceof S3ServiceException && error.$metadata.httpStatusCode === 403;
    try {
      await assert.rejects(unauthorized.initialize(), denied);
      await assert.rejects(unauthorized.get(object, version), denied);
      await assert.rejects(unauthorized.delete(object, version), denied);
      await assert.rejects(unauthorized.recoverVersion(object), denied);
    } finally {
      unauthorized.close();
    }
    assert.deepEqual(await storage.get(object, version), data);
    context.diagnostic('Candidate anonymous and wrong-secret denial assertions passed');
  }
  await assert.rejects(storage.put(object, data));
  const concurrentObject = { ...object, resumeId: randomUUID() };
  const writes = await Promise.allSettled(
    Array.from({ length: 8 }, () => storage.put(concurrentObject, data)),
  );
  const winners = writes.filter((result) => result.status === 'fulfilled');
  assert.equal(winners.length, 1, 'Exactly one concurrent conditional write must succeed');
  for (const result of writes) {
    if (result.status === 'rejected') {
      assert.equal(result.reason?.$metadata?.httpStatusCode, 412);
    }
  }
  const storedVersions = await client.send(
    new ListObjectVersionsCommand({ Bucket: bucket }),
    options(),
  );
  assert.equal(storedVersions.Versions?.length, 2, 'Rejected writes must not create versions');
  assert.deepEqual(await storage.get(concurrentObject, winners[0]!.value), data);
  await assert.rejects(storage.get({ ...object, ownerId: randomUUID() }, version));
  await assert.rejects(storage.get({ ...object, bytes: object.bytes + 1 }, version), /metadata/);
  await client.send(
    new PutBucketPolicyCommand({
      Bucket: bucket,
      Policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: '*',
            Action: 's3:GetObject',
            Resource: `arn:aws:s3:::${bucket}/*`,
          },
        ],
      }),
    }),
    options(),
  );
  await assert.rejects(storage.initialize(), /policies/);
  await assert.rejects(storage.put({ ...object, resumeId: randomUUID() }, data), /not initialized/);
  await client.send(new DeleteBucketPolicyCommand({ Bucket: bucket }), options());
  await storage.initialize();
  await storage.delete(object, version);
  await assert.rejects(storage.get(object, version));
  await storage.delete(object, version);
  context.diagnostic('All private immutable object lifecycle assertions passed');
});
