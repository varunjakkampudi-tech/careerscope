import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveConnectionTimeoutMs, resolveStatementTimeoutMs } from './database.ts';
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
