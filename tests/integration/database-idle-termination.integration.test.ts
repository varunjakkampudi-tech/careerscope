import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Database } from '../../packages/core/src/database.js';

// The server can end an idle pooled connection at any time: on a restart, a failover, or an
// administrator's DROP DATABASE ... WITH (FORCE). The pool must absorb that. Without an error listener,
// the pool's 'error' event becomes an uncaught exception, which crashes the process or fails whichever
// test is running.
test('an idle pooled connection ended by the server is absorbed and the pool recovers', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require the isolated v2 DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests require local PostgreSQL');
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  process.on('uncaughtException', onUncaught);
  try {
    // Leave one connection idle in the pool.
    await database.pool.query('SELECT 1');
    const terminated = await admin.pool.query(
      `SELECT count(*) AS count FROM (
         SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = $1 AND pid <> pg_backend_pid()) ended`,
      [name],
    );
    assert.ok(Number(terminated.rows[0]!.count) >= 1, 'the idle connection should have been ended');
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(
      uncaught,
      [],
      'the pool must not turn the ended connection into an uncaught error',
    );
    const after = await database.pool.query<{ ok: number }>('SELECT 1 AS ok');
    assert.equal(after.rows[0]!.ok, 1, 'the pool recovers with a new connection');
  } finally {
    process.off('uncaughtException', onUncaught);
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.close();
  }
});
