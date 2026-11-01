import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Auth } from './auth.js';
import { Database } from './database.js';
import {
  changeEmailWithSupportCase,
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

test(
  'an open case changes a locked-out address once, ends every session and refuses a taken address',
  {
    timeout: 60_000,
  },
  async () => {
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
      const ownerId = randomUUID();
      const otherId = randomUUID();
      await database.pool.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [
        ownerId,
        'locked-out@example.test',
        otherId,
        'taken@example.test',
      ]);
      const auth = new Auth(database);
      assert.ok(await auth.loginWithVerifiedEmail('locked-out@example.test'));

      const opened = await openSupportCase(
        database,
        'locked-out@example.test',
        'Mailbox lost, identity checked',
        'ops',
      );
      assert.ok(opened);

      assert.equal(
        await changeEmailWithSupportCase(database, opened.caseId, 'taken@example.test'),
        'conflict',
        'an address another account uses is refused',
      );
      assert.equal(
        await hasActiveSupportCase(database, ownerId),
        true,
        'a refused change keeps the case open',
      );

      assert.equal(
        await changeEmailWithSupportCase(database, opened.caseId, 'new-address@example.test'),
        'changed',
      );
      const owner = await database.pool.query<{ email: string }>(
        'SELECT email FROM users WHERE id = $1',
        [ownerId],
      );
      assert.equal(owner.rows[0]!.email, 'new-address@example.test');
      const sessions = await database.pool.query('SELECT 1 FROM sessions WHERE owner_id = $1', [
        ownerId,
      ]);
      assert.equal(sessions.rowCount, 0, 'every session of the account is ended');
      assert.equal(
        await hasActiveSupportCase(database, ownerId),
        false,
        'the case is closed by the change',
      );

      assert.equal(
        await changeEmailWithSupportCase(database, opened.caseId, 'again@example.test'),
        'no-active-case',
        'a closed case cannot change the address again',
      );
    } finally {
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.close();
    }
  },
);
