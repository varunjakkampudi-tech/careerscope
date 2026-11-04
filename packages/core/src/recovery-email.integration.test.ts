import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database } from './database.js';
import { recoveryTarget, setRecoveryEmail } from './recovery-email.js';

// A recovery address must never point at another account's sign-in address, and case must not
// change that answer (V12 item 2.17). Addresses are stored lower-case.
test(
  'a recovery address is refused when another account uses it in any letter case',
  { timeout: 60_000 },
  async () => {
    const configured = process.env.DATABASE_URL;
    assert.ok(configured, 'integration test requires an isolated DATABASE_URL');
    const url = new URL(configured);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
    const admin = new Database(configured);
    const name = `test_${randomUUID().replaceAll('-', '')}`;
    await admin.pool.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    url.pathname = `/${name}`;
    const database = new Database(url.href);
    try {
      await migrate(database.db, {
        migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
      });
      const ownerId = randomUUID();
      await database.pool.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [
        ownerId,
        'owner@example.test',
        randomUUID(),
        'other@example.test',
      ]);

      assert.equal(
        await setRecoveryEmail(database, ownerId, 'Other@Example.test'),
        false,
        'a case variant of another account address is refused',
      );
      assert.equal(
        await setRecoveryEmail(database, ownerId, 'OWNER@example.test'),
        false,
        'the account own sign-in address is refused as well',
      );
      assert.equal(await setRecoveryEmail(database, ownerId, 'Backup@Example.test'), true);

      // Recovery is allowed only after the cooldown: move the confirmation back 73 hours.
      await database.pool.query(
        "UPDATE users SET recovery_email_verified_at = now() - interval '73 hours' WHERE id = $1",
        [ownerId],
      );
      assert.deepEqual(await recoveryTarget(database, 'OWNER@Example.test'), {
        ownerId,
        recoveryEmail: 'backup@example.test',
      });
    } finally {
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.close();
    }
  },
);
