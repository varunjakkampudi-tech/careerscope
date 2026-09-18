import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { configuration, rateLimiter } from './runtime.js';

test('the search queue transport is scoped, and the legacy names are refused', () => {
  const source = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:56479',
    LOCAL_AWS_ENDPOINT: 'http://localhost:54566',
    APP_ORIGIN: 'http://localhost:5280',
  };
  assert.equal(configuration(source).SEARCH_QUEUE_TRANSPORT, 'sqs');
  assert.equal(configuration(source).REGISTRATION_ENABLED, 'false');
  assert.equal(
    configuration({ ...source, REGISTRATION_ENABLED: 'true' }).REGISTRATION_ENABLED,
    'true',
  );
  assert.throws(() => configuration({ ...source, REGISTRATION_ENABLED: 'yes' }));
  assert.throws(() => configuration({ ...source, SEARCH_QUEUE_TRANSPORT: 'unknown' }));
  assert.throws(() => configuration({ ...source, SEARCH_QUEUE_TRANSPORT: 'bullmq' }));
  assert.throws(() =>
    configuration({
      ...source,
      SEARCH_QUEUE_TRANSPORT: 'bullmq',
      SEARCH_QUEUE_REDIS_URL: source.REDIS_URL,
    }),
  );
  assert.throws(() =>
    configuration({
      ...source,
      SEARCH_QUEUE_TRANSPORT: 'bullmq',
      SEARCH_QUEUE_REDIS_URL: 'redis://example.com',
    }),
  );
  assert.equal(
    configuration({
      ...source,
      SEARCH_QUEUE_TRANSPORT: 'bullmq',
      SEARCH_QUEUE_REDIS_URL: 'redis://localhost:56480',
    }).SEARCH_QUEUE_TRANSPORT,
    'bullmq',
  );
  // The old names implied the files worker honoured them, which it never did.
  assert.throws(
    () => configuration({ ...source, QUEUE_TRANSPORT: 'bullmq' }),
    /SEARCH_QUEUE_TRANSPORT/,
  );
  assert.throws(
    () => configuration({ ...source, QUEUE_REDIS_URL: 'redis://localhost:56480' }),
    /SEARCH_QUEUE_TRANSPORT/,
  );
  assert.throws(() => configuration({ ...source, QUEUE_TRANSPORT: 'sqs' }));
});

test('a public application origin is accepted only over https', () => {
  const source = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:56479',
    LOCAL_AWS_ENDPOINT: 'http://localhost:54566',
    APP_ORIGIN: 'https://careerscope.tech',
  };
  assert.equal(configuration(source).APP_ORIGIN, 'https://careerscope.tech');
  assert.equal(
    configuration({ ...source, APP_ORIGIN: 'http://localhost:5280' }).APP_ORIGIN,
    'http://localhost:5280',
  );
  // Plain http against a real hostname would drop Secure from the session cookie.
  assert.throws(() => configuration({ ...source, APP_ORIGIN: 'http://careerscope.tech' }));
  assert.throws(() => configuration({ ...source, APP_ORIGIN: 'https://careerscope.tech/app' }));
  assert.throws(() => configuration({ ...source, APP_ORIGIN: 'ftp://careerscope.tech' }));
  // Infrastructure endpoints stay loopback-only even when the origin is public.
  assert.throws(() => configuration({ ...source, DATABASE_URL: 'postgres://db.example.com/x' }));
  assert.throws(() => configuration({ ...source, REDIS_URL: 'redis://cache.example.com' }));
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
