import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database } from './database.js';
import {
  closeSupportCase,
  hasActiveSupportCase,
  openSupportCase,
  supportCaseWindowMs,
} from './support-cases.js';

// V12-4.1-014: a support case records who opened it and why, expires after its window, and can be closed.
test('a support case is logged, time-limited and closable', { timeout: 60_000 }, async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'integration test requires an isolated DATABASE_URL');
  const url = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const database = new Database(url.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const email = 'inaccessible@example.test';
    const ownerId = randomUUID();
    await database.pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [ownerId, email]);

    assert.equal(
      await openSupportCase(database, 'nobody@example.test', 'account unreachable', 'ops'),
      null,
      'an unknown address opens nothing',
    );

    const opened = await openSupportCase(database, email, 'Lost access to the mailbox', 'ops');
    assert.ok(opened);
    assert.ok(opened.expiresAt.getTime() - Date.now() > supportCaseWindowMs - 60_000);
    assert.equal(await hasActiveSupportCase(database, ownerId), true);

    const row = await database.pool.query<{ reason: string; opened_by: string }>(
      'SELECT reason, opened_by FROM support_cases WHERE id = $1',
      [opened.caseId],
    );
    assert.equal(row.rows[0]!.reason, 'Lost access to the mailbox');
    assert.equal(row.rows[0]!.opened_by, 'ops');

    // The database refuses a reason too short to explain the case.
    await assert.rejects(
      database.pool.query(
        "INSERT INTO support_cases (id, owner_id, reason, opened_by, expires_at) VALUES ($1, $2, $3, $4, now() + interval '1 day')",
        [randomUUID(), ownerId, 'short', 'ops'],
      ),
      (error: { code?: string }) => error.code === '23514',
    );

    // A case opened outside its window is not active.
    const stale = await openSupportCase(
      database,
      email,
      'Opened a day and a half ago',
      'ops',
      Date.now() - supportCaseWindowMs - 12 * 60 * 60 * 1000,
    );
    assert.ok(stale);
    await closeSupportCase(database, opened.caseId);
    assert.equal(await hasActiveSupportCase(database, ownerId), false);

    // A closed case cannot be closed again.
    assert.equal(await closeSupportCase(database, opened.caseId), false);
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.close();
  }
});
