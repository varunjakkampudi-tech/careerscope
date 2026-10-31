import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configuration, isRandomSecret, rateLimiter } from './runtime.js';

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

test('REDIS_PASSWORD_FILE supplies the Redis password without it appearing in the environment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'redis-password-'));
  try {
    const file = join(directory, 'redis-password');
    const password = randomBytes(24).toString('hex');
    writeFileSync(file, `${password}\n`);
    const source = {
      DATABASE_URL: 'postgres://localhost/test',
      REDIS_URL: 'redis://127.0.0.1:6379',
      QUEUE_REDIS_URL: 'redis://127.0.0.1:6380',
      APP_ORIGIN: 'http://localhost:5280',
      REDIS_PASSWORD_FILE: file,
    };
    const env = configuration(source);
    assert.equal(new URL(env.REDIS_URL).password, password);
    assert.equal(new URL(env.QUEUE_REDIS_URL).password, password);
    assert.equal(new URL(env.QUEUE_REDIS_URL).port, '6380');
    // Without the file the URLs are untouched, and an explicit URL password wins.
    assert.equal(
      configuration({ ...source, REDIS_PASSWORD_FILE: undefined }).REDIS_URL,
      source.REDIS_URL,
    );
    const explicit = 'redis://:explicitpassword1234@127.0.0.1:6379';
    assert.equal(
      new URL(configuration({ ...source, REDIS_URL: explicit }).REDIS_URL).password,
      'explicitpassword1234',
    );
    // A missing, empty or malformed file fails closed.
    assert.throws(() =>
      configuration({ ...source, REDIS_PASSWORD_FILE: join(directory, 'absent') }),
    );
    writeFileSync(file, '\n');
    assert.throws(() => configuration(source), /REDIS_PASSWORD_FILE/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('isRandomSecret rejects patterned and single-class values and accepts generated ones', () => {
  const sequence = (length: number, next: (index: number) => number) =>
    Buffer.from(Array.from({ length }, (_, index) => next(index) & 0xff));
  // A generated secret is retried here only to keep the test deterministic about its own inputs.
  const fewValues = randomBytes(64).map((byte) => byte % 20);
  const rejected = [
    sequence(32, (index) => index).toString('hex'), // counter 00 01 02 .. 1f
    sequence(32, (index) => index).toString('base64'),
    sequence(48, (index) => index * 7).toString('hex'), // constant step of 7
    sequence(40, (index) => 200 - index * 3).toString('hex'), // constant negative step, wraps
    sequence(64, (index) => index * 5).toString('base64url'),
    Buffer.from(fewValues).toString('hex'), // at most 20 distinct byte values
    'qwertyuiopasdfghjklzxcvbnmqwertyuiopasdfghjklz', // lowercase letters only, valid base64 form
    'QWERTYUIOPASDFGHJKLZXCVBNMQWERTYUIOPASDFGHJKLZ',
    'thequickbrownfoxjumpsoverthelazydogagainandagain', // dictionary-like, 48 characters
    '1234567890'.repeat(7), // digits only
    'ab'.repeat(32),
    's'.repeat(64),
  ];
  for (const secret of rejected) assert.equal(isRandomSecret(secret), false);
  for (let round = 0; round < 50; round++) {
    assert.equal(isRandomSecret(randomBytes(32).toString('hex')), true);
    assert.equal(isRandomSecret(randomBytes(32).toString('base64')), true);
    assert.equal(isRandomSecret(randomBytes(33).toString('base64url')), true);
  }
});

test('OTP secrets are read from files, fail closed when missing or weak, and are never echoed', () => {
  const directory = mkdtempSync(join(tmpdir(), 'otp-secrets-'));
  try {
    const hmacFile = join(directory, 'hmac');
    const resendFile = join(directory, 'resend');
    const hmac = randomBytes(32).toString('hex');
    const resend = 're_' + randomBytes(16).toString('hex');
    writeFileSync(hmacFile, `${hmac}\n`);
    writeFileSync(resendFile, `${resend}\n`);
    const source = {
      DATABASE_URL: 'postgres://127.0.0.1/test',
      REDIS_URL: 'redis://127.0.0.1:6379',
      QUEUE_REDIS_URL: 'redis://127.0.0.1:6380',
      APP_ORIGIN: 'https://careerscope.tech',
      DEPLOYMENT_ENVIRONMENT: 'production',
      EMAIL_OTP_ENABLED: 'true',
      EMAIL_OTP_HMAC_SECRET_FILE: hmacFile,
      RESEND_API_KEY_FILE: resendFile,
    };
    const env = configuration(source);
    assert.equal(env.EMAIL_OTP_HMAC_SECRET, hmac);
    assert.equal(env.RESEND_API_KEY, resend);
    const refused = (override: Record<string, string | undefined>, pattern: RegExp) =>
      assert.throws(
        () => configuration({ ...source, ...override }),
        (error: unknown) =>
          error instanceof Error &&
          pattern.test(error.message) &&
          !error.message.includes(hmac) &&
          !error.message.includes(resend) &&
          !error.message.includes(directory),
      );
    // Missing file, empty file, multi-token file.
    refused({ EMAIL_OTP_HMAC_SECRET_FILE: join(directory, 'absent') }, /HMAC_SECRET_FILE/);
    refused({ RESEND_API_KEY_FILE: join(directory, 'absent') }, /RESEND_API_KEY_FILE/);
    writeFileSync(resendFile, '\n');
    refused({}, /RESEND_API_KEY_FILE/);
    writeFileSync(resendFile, `${resend}\n`);
    // A weak secret in the file is refused by the same screen as an environment value.
    const weak = sequenceHex();
    writeFileSync(hmacFile, `${weak}\n`);
    refused({}, /HMAC secret/);
    writeFileSync(hmacFile, `${hmac}\n`);
    // An environment value next to a file is ambiguous and refused.
    refused({ EMAIL_OTP_HMAC_SECRET: hmac }, /either EMAIL_OTP_HMAC_SECRET or/);
    // Without the files production OTP still fails closed.
    refused(
      { EMAIL_OTP_HMAC_SECRET_FILE: undefined, RESEND_API_KEY_FILE: undefined },
      /HMAC secret/,
    );
    // Workers do not receive the secrets and do not need them; the OTP flags still apply.
    const worker = configuration(
      { ...source, EMAIL_OTP_HMAC_SECRET_FILE: undefined, RESEND_API_KEY_FILE: undefined },
      { emailOtpSecrets: false },
    );
    assert.equal(worker.EMAIL_OTP_HMAC_SECRET, undefined);
    assert.throws(
      () =>
        configuration(
          { ...source, EMAIL_OTP_ENABLED: undefined, EMAIL_OTP_HMAC_SECRET_FILE: undefined },
          { emailOtpSecrets: false },
        ),
      /requires email OTP/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

/** The counter 00 01 02 .. 1f as hex, a classic placeholder secret. */
function sequenceHex() {
  return Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString('hex');
}
