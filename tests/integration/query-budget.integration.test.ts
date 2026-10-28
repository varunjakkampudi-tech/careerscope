import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database } from '@careerscope/core';

// CI raises the database timeouts for the BullMQ suite only. This run proves the rest of the
// system still works inside the production defaults: the pool must come up with a 10 s statement
// timeout and a 5 s connect timeout, and a representative query (the outbox backlog read the
// publisher issues every cycle, against a freshly migrated schema) must finish well inside 10 s.

const budgetMs = 10_000;

test('a representative query completes within the production 10 s statement budget', async () => {
  // Remove any override so the defaults, not the environment, are what is measured.
  for (const name of ['DATABASE_STATEMENT_TIMEOUT_MS', 'DATABASE_CONNECT_TIMEOUT_MS']) {
    delete process.env[name];
  }
  process.env.DEPLOYMENT_ENVIRONMENT = 'production';

  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests require local PostgreSQL');
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    const options = database.pool.options as unknown as Record<string, number>;
    assert.equal(options.statement_timeout, 10_000, 'statement timeout is the production default');
    assert.equal(
      options.connectionTimeoutMillis,
      5000,
      'connect timeout is the production default',
    );

    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../migrations', import.meta.url)),
    });

    const setting = await database.pool.query<{ statement_timeout: string }>(
      'SHOW statement_timeout',
    );
    assert.equal(setting.rows[0]?.statement_timeout, '10s');

    const started = performance.now();
    const backlog = await database.backlog();
    const elapsed = performance.now() - started;
    assert.equal(backlog.unpublished, 0);
    assert.ok(
      elapsed < budgetMs,
      `backlog query took ${Math.round(elapsed)} ms, budget ${budgetMs} ms`,
    );
    process.stdout.write(`query budget: backlog read took ${Math.round(elapsed)} ms\n`);
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});
