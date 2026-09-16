import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { PrivateResumeStorage, storageConfiguration, maximumResumeBytes } from './storage.js';

const data = Buffer.from('%PDF-1.7\nSynthetic transport fixture, not a parser fixture');
const object = {
  ownerId: '11111111-1111-4111-8111-111111111111',
  resumeId: '22222222-2222-4222-8222-222222222222',
  sha256: createHash('sha256').update(data).digest('hex'),
  bytes: data.length,
  contentType: 'application/pdf' as const,
};
const config = {
  MINIO_ENDPOINT: 'http://127.0.0.1:19000',
  MINIO_BUCKET: 'synthetic-resumes',
  MINIO_ACCESS_KEY: 'synthetic',
  MINIO_SECRET_KEY: 'synthetic-secret-not-real',
};

test('storage rejects external endpoints, URL credentials and invalid bucket names', () => {
  assert.equal(maximumResumeBytes, 5 * 1024 * 1024);
  const canonical = {
    S3_ENDPOINT: config.MINIO_ENDPOINT,
    S3_BUCKET: config.MINIO_BUCKET,
    S3_ACCESS_KEY: config.MINIO_ACCESS_KEY,
    S3_SECRET_KEY: config.MINIO_SECRET_KEY,
  };
  assert.deepEqual(storageConfiguration(canonical), canonical);
  assert.deepEqual(storageConfiguration(config), canonical);
  assert.deepEqual(storageConfiguration({ ...config, ...canonical }), canonical);
  for (const name of Object.keys(canonical)) {
    assert.throws(
      () => storageConfiguration({ ...config, ...canonical, [name]: 'different' }),
      /Conflicting/,
    );
    assert.throws(() => storageConfiguration({ ...config, ...canonical, [name]: undefined }));
  }
  for (const endpoint of [
    'https://example.test',
    'http://user:secret@localhost',
    'http://localhost/bucket',
  ]) {
    assert.throws(() => storageConfiguration({ ...config, MINIO_ENDPOINT: endpoint }));
  }
  assert.throws(() => storageConfiguration({ ...config, MINIO_BUCKET: '../private' }));
  assert.throws(() => storageConfiguration({ ...config, MINIO_SECRET_KEY: '' }));
});

test('storage validates owner identity, size, checksum and version before IO', async () => {
  const storage = new PrivateResumeStorage(config);
  try {
    await assert.rejects(storage.put({ ...object, ownerId: '../other' }, data));
    await assert.rejects(storage.put({ ...object, bytes: maximumResumeBytes + 1 }, data));
    await assert.rejects(storage.put(object, Buffer.from('tampered')));
    await assert.rejects(storage.get(object, 'null'));
    await assert.rejects(storage.delete(object, ''));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(storage.put(object, data, controller.signal));
  } finally {
    storage.close();
  }
});

test('storage sends private immutable writes and version-specific verified reads/deletes', async () => {
  const requests: { method: string | undefined; url: string | undefined }[] = [];
  let corrupt = false;
  let versioned = true;
  let publicBucket = false;
  const server = createServer(async (request, response) => {
    if (request.url?.includes('?versioning')) {
      response.end(
        `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>${versioned ? 'Enabled' : 'Suspended'}</Status></VersioningConfiguration>`,
      );
      return;
    }
    if (request.url?.includes('?acl')) {
      response.end(
        '<AccessControlPolicy><Owner><ID>synthetic</ID></Owner><AccessControlList><Grant><Grantee xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="CanonicalUser"><ID>synthetic</ID></Grantee><Permission>FULL_CONTROL</Permission></Grant></AccessControlList></AccessControlPolicy>',
      );
      return;
    }
    if (request.url?.includes('?policy')) {
      response.statusCode = publicBucket ? 200 : 404;
      response.end(publicBucket ? '{}' : '<Error><Code>NoSuchBucketPolicy</Code></Error>');
      return;
    }
    requests.push({ method: request.method, url: request.url });
    if (request.method === 'PUT') {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      assert.deepEqual(Buffer.concat(chunks), data);
      assert.equal(request.headers['if-none-match'], '*');
      assert.equal(request.headers['x-amz-acl'], undefined);
      assert.equal(
        request.headers['x-amz-checksum-sha256'],
        Buffer.from(object.sha256, 'hex').toString('base64'),
      );
      if (versioned) response.setHeader('x-amz-version-id', 'version-1');
      response.end();
    } else if (request.method === 'HEAD') {
      response.setHeader('content-type', object.contentType);
      response.setHeader('content-length', data.length);
      response.setHeader('x-amz-version-id', 'version-1');
      response.end();
    } else if (request.method === 'GET') {
      response.setHeader('content-type', object.contentType);
      response.setHeader('x-amz-version-id', 'version-1');
      response.end(corrupt ? Buffer.alloc(data.length) : data);
    } else {
      response.statusCode = 204;
      response.end();
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const storage = new PrivateResumeStorage({
    ...config,
    MINIO_ENDPOINT: `http://127.0.0.1:${address.port}`,
  });
  try {
    await assert.rejects(storage.put(object, data), /not initialized/);
    await storage.initialize();
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(storage.put(object, data, cancelled.signal));
    assert.equal(requests.length, 0);
    assert.equal(await storage.put(object, data), 'version-1');
    assert.deepEqual(await storage.get(object, 'version-1'), data);
    assert.equal(await storage.recoverVersion(object), 'version-1');
    corrupt = true;
    await assert.rejects(storage.get(object, 'version-1'), /integrity/);
    await assert.rejects(storage.recoverVersion(object), /integrity/);
    await assert.rejects(storage.recoverVersion(object, cancelled.signal));
    await storage.delete(object, 'version-1');
    assert.ok(
      requests.every((request) =>
        request.url?.includes(
          `/owners/${object.ownerId}/resumes/${object.resumeId}/${object.sha256}`,
        ),
      ),
    );
    assert.ok(
      requests
        .filter((request) => request.method === 'GET' || request.method === 'DELETE')
        .every((request) => request.url?.includes('versionId=version-1')),
    );
    versioned = false;
    await assert.rejects(storage.put(object, data), /versioning/);
    await assert.rejects(storage.initialize(), /versioning/);
    versioned = true;
    publicBucket = true;
    await assert.rejects(storage.initialize(), /policies/);
    await assert.rejects(storage.put(object, data), /not initialized/);
  } finally {
    storage.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
