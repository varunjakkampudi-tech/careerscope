import assert from 'node:assert/strict';
import test from 'node:test';
import { Auth } from './auth.js';
import { Database } from './database.js';
import { testAccessAllowed, testAccessConfiguration, testUsers } from './test-users.js';

test('public test selection is disabled unless an explicit private proxy is configured', () => {
  assert.deepEqual(testAccessConfiguration({}, 'https://careerscope.tech'), { mode: 'disabled' });
  assert.throws(() =>
    testAccessConfiguration({ TEST_ACCESS_MODE: 'local' }, 'https://careerscope.tech'),
  );
  assert.throws(() =>
    testAccessConfiguration(
      { TEST_ACCESS_MODE: 'local', NODE_ENV: 'production' },
      'http://localhost:5280',
    ),
  );
  assert.throws(() =>
    testAccessConfiguration(
      { DEPLOYMENT_ENVIRONMENT: 'staging', TEST_ACCESS_MODE: 'proxy' },
      'https://careerscope.tech',
    ),
  );
  assert.throws(() =>
    testAccessConfiguration(
      {
        DEPLOYMENT_ENVIRONMENT: 'staging',
        TEST_ACCESS_MODE: 'proxy',
        TEST_PROXY_SECRET: 'a'.repeat(64),
      },
      'http://localhost:5280',
    ),
  );
});

test('local selection only accepts loopback requests', () => {
  const access = testAccessConfiguration({ TEST_ACCESS_MODE: 'local' }, 'http://localhost:5280');
  const direct = { host: 'localhost:5280' };
  assert.equal(testAccessAllowed(access, '127.0.0.1', undefined, direct), true);
  assert.equal(testAccessAllowed(access, '::1', undefined, direct), true);
  assert.equal(testAccessAllowed(access, '203.0.113.2', undefined, direct), false);
  assert.equal(testAccessAllowed({ mode: 'disabled' }, '127.0.0.1', undefined, direct), false);
});

test('local mode is never the implicit default', () => {
  for (const origin of ['http://localhost:5280', 'http://127.0.0.1:5280']) {
    assert.deepEqual(testAccessConfiguration({}, origin), { mode: 'disabled' });
    assert.deepEqual(testAccessConfiguration({ DEPLOYMENT_ENVIRONMENT: 'development' }, origin), {
      mode: 'disabled',
    });
    assert.deepEqual(testAccessConfiguration({ NODE_ENV: 'development' }, origin), {
      mode: 'disabled',
    });
  }
  assert.deepEqual(
    testAccessConfiguration({ TEST_ACCESS_MODE: 'local' }, 'http://localhost:5280'),
    { mode: 'local' },
  );
});

test('local mode rejects relayed requests and any non-loopback Host header', () => {
  const access = testAccessConfiguration({ TEST_ACCESS_MODE: 'local' }, 'http://localhost:5280');
  for (const host of ['localhost', 'localhost:5280', '127.0.0.1:80', '[::1]:5280', 'LOCALHOST']) {
    assert.equal(testAccessAllowed(access, '127.0.0.1', undefined, { host }), true, host);
  }
  for (const relay of [
    { 'x-forwarded-for': '203.0.113.9' },
    { forwarded: 'for=203.0.113.9' },
    { 'x-real-ip': '203.0.113.9' },
    { 'x-forwarded-for': '' },
  ]) {
    assert.equal(
      testAccessAllowed(access, '127.0.0.1', undefined, { host: 'localhost:5280', ...relay }),
      false,
      JSON.stringify(relay),
    );
  }
  for (const host of [
    'careerscope.tech',
    'evil.example:5280',
    'localhost.evil.test',
    '',
    undefined,
  ]) {
    assert.equal(testAccessAllowed(access, '127.0.0.1', undefined, { host }), false, String(host));
  }
  assert.equal(testAccessAllowed(access, '127.0.0.1', undefined), false, 'no headers at all');
  assert.equal(testAccessAllowed(access, '127.0.0.1', undefined, { host: ['localhost'] }), false);
});

test('hosted test access requires the private assertion from a loopback proxy', () => {
  const secret = 'a'.repeat(64);
  const access = testAccessConfiguration(
    {
      DEPLOYMENT_ENVIRONMENT: 'staging',
      NODE_ENV: 'production',
      TEST_ACCESS_MODE: 'proxy',
      TEST_PROXY_SECRET: secret,
    },
    'https://careerscope.tech',
  );
  assert.equal(testAccessAllowed(access, '127.0.0.1', secret), true);
  for (const header of [undefined, '', 'a'.repeat(63), 'b'.repeat(64), [secret]]) {
    assert.equal(testAccessAllowed(access, '127.0.0.1', header), false);
  }
  assert.equal(testAccessAllowed(access, '203.0.113.2', secret), false);
});

test('production refuses every test shortcut even with valid proxy credentials', () => {
  for (const NODE_ENV of ['development', 'production', undefined]) {
    for (const TEST_ACCESS_MODE of ['local', 'proxy']) {
      assert.throws(
        () =>
          testAccessConfiguration(
            {
              DEPLOYMENT_ENVIRONMENT: 'production',
              NODE_ENV,
              TEST_ACCESS_MODE,
              TEST_PROXY_SECRET: 'a'.repeat(64),
            },
            'https://production.example.invalid',
          ),
        /Test access is prohibited in production/,
      );
    }
    assert.deepEqual(
      testAccessConfiguration(
        { DEPLOYMENT_ENVIRONMENT: 'production', NODE_ENV },
        'http://localhost:5280',
      ),
      { mode: 'disabled' },
    );
  }
  assert.throws(
    () =>
      testAccessConfiguration(
        { NODE_ENV: 'production', TEST_ACCESS_MODE: 'proxy', TEST_PROXY_SECRET: 'a'.repeat(64) },
        'https://production.example.invalid',
      ),
    /Test access is prohibited in production/,
  );
});

test('invalid deployment configuration fails closed and staging never defaults to local', () => {
  assert.throws(
    () => testAccessConfiguration({ TEST_ACCESS_MODE: 'unknown' }, 'http://localhost'),
    /Invalid TEST_ACCESS_MODE/,
  );
  for (const environment of ['', 'prod', 'STAGING', 'unknown'])
    assert.throws(
      () => testAccessConfiguration({ DEPLOYMENT_ENVIRONMENT: environment }, 'http://localhost'),
      /Invalid DEPLOYMENT_ENVIRONMENT/,
    );
  assert.deepEqual(
    testAccessConfiguration({ DEPLOYMENT_ENVIRONMENT: 'staging' }, 'http://localhost'),
    { mode: 'disabled' },
  );
  assert.throws(() =>
    testAccessConfiguration(
      { DEPLOYMENT_ENVIRONMENT: 'staging', TEST_ACCESS_MODE: 'local' },
      'http://localhost',
    ),
  );
  assert.throws(() =>
    testAccessConfiguration(
      { TEST_ACCESS_MODE: 'proxy', TEST_PROXY_SECRET: 'a'.repeat(64) },
      'https://staging.example.invalid',
    ),
  );
});

test('test identities are distinct and arbitrary emails cannot touch the database', async () => {
  assert.equal(testUsers.length, 2);
  assert.equal(new Set(testUsers.map((user) => user.id)).size, 2);
  assert.deepEqual(
    testUsers.map((user) => user.role),
    ['candidate', 'admin'],
  );
  const database = new Database('postgres://localhost:1/unused');
  try {
    assert.equal(await new Auth(database).testLogin('unapproved@example.invalid'), null);
  } finally {
    await database.close();
  }
});
