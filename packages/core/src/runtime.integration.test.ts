import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { configuration, rateLimiter } from './runtime.js';

const strongSecret = randomBytes(32).toString('hex');

test('the OTP HMAC secret must decode to at least 32 random bytes and is never echoed', () => {
  const source = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:56479',
    QUEUE_REDIS_URL: 'redis://localhost:56480',
    APP_ORIGIN: 'http://localhost:5280',
    EMAIL_OTP_ENABLED: 'true',
    RESEND_API_KEY: 'synthetic-key',
  };
  const accepted = [
    randomBytes(32).toString('hex'),
    randomBytes(48).toString('hex'),
    randomBytes(32).toString('base64'),
    randomBytes(32).toString('base64url'),
    randomBytes(64).toString('base64'),
  ];
  for (const secret of accepted) {
    assert.equal(
      configuration({ ...source, EMAIL_OTP_HMAC_SECRET: secret }).EMAIL_OTP_ENABLED,
      'true',
    );
  }
  const rejected = [
    's'.repeat(32),
    's'.repeat(64),
    's'.repeat(43),
    'ab'.repeat(32),
    '0123456789abcdef'.repeat(4),
    '00'.repeat(32),
    'correct horse battery staple correct horse battery staple',
    randomBytes(31).toString('hex'),
    randomBytes(31).toString('base64'),
    randomBytes(32).toString('hex').slice(0, 63) + '!',
    Buffer.from(Array.from({ length: 32 }, (_, index) => index % 4)).toString('hex'),
  ];
  for (const secret of rejected) {
    assert.throws(
      () => configuration({ ...source, EMAIL_OTP_HMAC_SECRET: secret }),
      (error: unknown) =>
        error instanceof Error &&
        /HMAC secret/.test(error.message) &&
        !error.message.includes(secret),
    );
  }
});

test('the search queue transport is scoped, and the legacy names are refused', () => {
  const source = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:56479',
    QUEUE_REDIS_URL: 'redis://localhost:56480',
    APP_ORIGIN: 'http://localhost:5280',
  };
  assert.equal(configuration(source).SEARCH_QUEUE_TRANSPORT, 'redis');
  assert.equal(configuration(source).REGISTRATION_ENABLED, 'false');
  assert.throws(
    () => configuration({ ...source, REGISTRATION_ENABLED: 'true' }),
    /Registration requires email OTP/,
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
  // Queue data may never share the evicting rate-limit instance.
  assert.throws(
    () => configuration({ ...source, QUEUE_TRANSPORT: 'bullmq' }),
    /SEARCH_QUEUE_TRANSPORT/,
  );
  assert.throws(() => configuration({ ...source, QUEUE_REDIS_URL: source.REDIS_URL }), /isolated/);
  assert.throws(() => configuration({ ...source, QUEUE_TRANSPORT: 'sqs' }));
});

test('email OTP configuration is fail-closed for production and validates its independent key', () => {
  const source = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:56479',
    QUEUE_REDIS_URL: 'redis://localhost:56480',
    APP_ORIGIN: 'https://careerscope.tech',
  };
  assert.throws(() => configuration({ ...source, NODE_ENV: 'production' }), /requires email OTP/);
  assert.throws(
    () => configuration({ ...source, EMAIL_OTP_ENABLED: 'true', RESEND_API_KEY: 'synthetic' }),
    /HMAC secret/,
  );
  assert.throws(
    () =>
      configuration({
        ...source,
        EMAIL_OTP_ENABLED: 'true',
        EMAIL_OTP_HMAC_SECRET: 'short',
        RESEND_API_KEY: 'synthetic',
      }),
    /HMAC secret/,
  );
  assert.throws(
    () =>
      configuration({
        ...source,
        EMAIL_OTP_ENABLED: 'true',
        EMAIL_OTP_HMAC_SECRET: strongSecret,
      }),
    /RESEND_API_KEY/,
  );
  const enabled = configuration({
    ...source,
    NODE_ENV: 'production',
    EMAIL_OTP_ENABLED: 'true',
    EMAIL_OTP_HMAC_SECRET: strongSecret,
    RESEND_API_KEY: 'synthetic-key',
  });
  assert.equal(enabled.DEPLOYMENT_ENVIRONMENT, 'production');
  assert.equal(enabled.EMAIL_OTP_ENABLED, 'true');
  assert.equal(
    configuration({ ...source, APP_ORIGIN: 'http://localhost:5280' }).EMAIL_OTP_ENABLED,
    'false',
  );
});

test('registration requires OTP and approved-versioned legal configuration', () => {
  const source = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:56479',
    QUEUE_REDIS_URL: 'redis://localhost:56480',
    APP_ORIGIN: 'https://careerscope.example.test',
    NODE_ENV: 'production',
    REGISTRATION_ENABLED: 'true',
  };
  assert.throws(() => configuration(source), /Registration requires email OTP/);
  const otp = {
    ...source,
    EMAIL_OTP_ENABLED: 'true',
    EMAIL_OTP_HMAC_SECRET: strongSecret,
    RESEND_API_KEY: 'synthetic-key',
  };
  assert.throws(() => configuration(otp), /Registration requires versioned legal documents/);
  assert.throws(
    () =>
      configuration({
        ...otp,
        LEGAL_TERMS_VERSION: 'terms-1',
        LEGAL_TERMS_URL: 'http://careerscope.example.test/terms',
        LEGAL_PRIVACY_VERSION: 'privacy-1',
        LEGAL_PRIVACY_URL: 'https://careerscope.example.test/privacy',
        LEGAL_MARKETING_VERSION: 'marketing-1',
      }),
    /LEGAL_TERMS_URL must use HTTPS/,
  );
  assert.equal(
    configuration({
      ...otp,
      LEGAL_TERMS_VERSION: 'terms-1',
      LEGAL_TERMS_URL: 'https://careerscope.example.test/terms',
      LEGAL_PRIVACY_VERSION: 'privacy-1',
      LEGAL_PRIVACY_URL: 'https://careerscope.example.test/privacy',
      LEGAL_MARKETING_VERSION: 'marketing-1',
    }).REGISTRATION_ENABLED,
    'true',
  );
});

test('a public application origin is accepted only over https', () => {
  const source = {
    DATABASE_URL: 'postgres://localhost/test',
    REDIS_URL: 'redis://localhost:56479',
    QUEUE_REDIS_URL: 'redis://localhost:56480',
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
  const firstInstance = await rateLimiter(process.env.REDIS_URL, prefix);
  const secondInstance = await rateLimiter(process.env.REDIS_URL, prefix);
  try {
    const admitted = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0 ? firstInstance : secondInstance).consume('login', 5, 60),
      ),
    );
    assert.equal(admitted.filter(Boolean).length, 5);
    assert.ok((await firstInstance.client.ttl(`${prefix}login`)) > 0);
    await firstInstance.client.del(`${prefix}login`);
    assert.equal(await secondInstance.consume('login', 5, 60), true);
  } finally {
    await firstInstance.client.del(`${prefix}login`);
    await Promise.all([firstInstance.close(), secondInstance.close()]);
  }
});
