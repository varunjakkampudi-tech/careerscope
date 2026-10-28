import assert from 'node:assert/strict';
import test from 'node:test';
import { Database, resolveConnectionTimeoutMs, resolveStatementTimeoutMs } from './database.ts';
import { logger } from './runtime.ts';

test('statement timeout defaults to 10000 when unset or empty', () => {
  assert.equal(resolveStatementTimeoutMs(undefined, 'development'), 10_000);
  assert.equal(resolveStatementTimeoutMs('', 'development'), 10_000);
  assert.equal(resolveStatementTimeoutMs(undefined, 'production'), 10_000);
});

test('statement timeout accepts the inclusive bounds outside production', () => {
  assert.equal(resolveStatementTimeoutMs('1000', 'development'), 1000);
  assert.equal(resolveStatementTimeoutMs('600000', 'development'), 600_000);
});

test('statement timeout rejects out-of-range and non-integer values', () => {
  for (const raw of ['999', '600001', 'abc', '1.5']) {
    assert.throws(
      () => resolveStatementTimeoutMs(raw, 'development'),
      /DATABASE_STATEMENT_TIMEOUT_MS must be an integer/,
      raw,
    );
  }
});

test('production caps an override above 10000 and logs a warning', (context) => {
  const warn = context.mock.method(logger, 'warn', () => undefined);
  assert.equal(resolveStatementTimeoutMs('60000', 'production'), 10_000);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(resolveStatementTimeoutMs('5000', 'production'), 5000);
  assert.equal(warn.mock.callCount(), 1);
  assert.throws(() => resolveStatementTimeoutMs('999', 'production'));
});

test('resolveConnectionTimeoutMs defaults to 5 seconds and rejects out-of-range values', () => {
  assert.equal(resolveConnectionTimeoutMs(undefined), 5000);
  assert.equal(resolveConnectionTimeoutMs(''), 5000);
  assert.equal(resolveConnectionTimeoutMs('30000'), 30000);
  for (const bad of ['999', '120001', 'abc', '1.5']) {
    assert.throws(() => resolveConnectionTimeoutMs(bad), /DATABASE_CONNECT_TIMEOUT_MS/);
  }
});

test('production caps the connect timeout at 5000 and logs a warning', (context) => {
  const warn = context.mock.method(logger, 'warn', () => undefined);
  assert.equal(resolveConnectionTimeoutMs('60000', 'production'), 5000);
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(resolveConnectionTimeoutMs('2000', 'production'), 2000);
  assert.equal(resolveConnectionTimeoutMs('60000', 'development'), 60_000);
  assert.equal(warn.mock.callCount(), 1);
});

async function poolOptions(env: Record<string, string>) {
  const keys = [
    'DEPLOYMENT_ENVIRONMENT',
    'NODE_ENV',
    'DATABASE_STATEMENT_TIMEOUT_MS',
    'DATABASE_CONNECT_TIMEOUT_MS',
  ];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, env);
  const database = new Database('postgres://localhost:1/unused');
  try {
    return database.pool.options as unknown as Record<string, number>;
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await database.close();
  }
}

test('pool applies the production caps and keeps idle-in-transaction fixed at 10000', async (context) => {
  context.mock.method(logger, 'warn', () => undefined);
  const production = await poolOptions({
    DEPLOYMENT_ENVIRONMENT: 'production',
    DATABASE_STATEMENT_TIMEOUT_MS: '60000',
    DATABASE_CONNECT_TIMEOUT_MS: '60000',
  });
  assert.equal(production.statement_timeout, 10_000);
  assert.equal(production.connectionTimeoutMillis, 5000);
  assert.equal(production.idle_in_transaction_session_timeout, 10_000);
  // An empty DEPLOYMENT_ENVIRONMENT falls back to NODE_ENV and must not bypass the caps.
  const empty = await poolOptions({
    DEPLOYMENT_ENVIRONMENT: '',
    NODE_ENV: 'production',
    DATABASE_STATEMENT_TIMEOUT_MS: '60000',
    DATABASE_CONNECT_TIMEOUT_MS: '60000',
  });
  assert.equal(empty.statement_timeout, 10_000);
  assert.equal(empty.connectionTimeoutMillis, 5000);
  // Outside production the statement override applies but idle-in-transaction stays fixed.
  const development = await poolOptions({
    DEPLOYMENT_ENVIRONMENT: 'development',
    DATABASE_STATEMENT_TIMEOUT_MS: '60000',
    DATABASE_CONNECT_TIMEOUT_MS: '30000',
  });
  assert.equal(development.statement_timeout, 60_000);
  assert.equal(development.connectionTimeoutMillis, 30_000);
  assert.equal(development.idle_in_transaction_session_timeout, 10_000);
});

test('an empty statement timeout uses the default, not an unbounded value', async () => {
  const options = await poolOptions({
    DEPLOYMENT_ENVIRONMENT: 'production',
    DATABASE_STATEMENT_TIMEOUT_MS: '',
  });
  assert.equal(options.statement_timeout, 10_000);
});
