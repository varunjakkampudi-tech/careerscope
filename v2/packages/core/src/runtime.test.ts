import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { configuration, rateLimiter } from './runtime.js';

test('queue transport defaults to SQS and BullMQ requires a separate local endpoint', () => {
  const source = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:56479',
    LOCAL_AWS_ENDPOINT: 'http://localhost:54566',
    APP_ORIGIN: 'http://localhost:5280',
  };
  assert.equal(configuration(source).QUEUE_TRANSPORT, 'sqs');
  assert.throws(() => configuration({ ...source, QUEUE_TRANSPORT: 'unknown' }));
  assert.throws(() => configuration({ ...source, QUEUE_TRANSPORT: 'bullmq' }));
  assert.throws(() =>
    configuration({ ...source, QUEUE_TRANSPORT: 'bullmq', QUEUE_REDIS_URL: source.REDIS_URL }),
  );
  assert.throws(() =>
    configuration({ ...source, QUEUE_TRANSPORT: 'bullmq', QUEUE_REDIS_URL: 'redis://example.com' }),
  );
  assert.equal(
    configuration({
      ...source,
      QUEUE_TRANSPORT: 'bullmq',
      QUEUE_REDIS_URL: 'redis://localhost:56480',
    }).QUEUE_TRANSPORT,
    'bullmq',
  );
});

test('Redis rate limit is atomic and expires rather than persisting authorization', async () => {
  assert.ok(process.env.REDIS_URL);
  const prefix = `test:${randomUUID()}:`;
  const limiter = await rateLimiter(process.env.REDIS_URL, prefix);
  try {
    const admitted = await Promise.all(
      Array.from({ length: 20 }, () => limiter.consume('login', 5, 60)),
    );
    assert.equal(admitted.filter(Boolean).length, 5);
    assert.ok((await limiter.client.ttl(`${prefix}login`)) > 0);
    await limiter.client.del(`${prefix}login`);
    assert.equal(await limiter.consume('login', 5, 60), true);
  } finally {
    await limiter.client.del(`${prefix}login`);
    await limiter.close();
  }
});
