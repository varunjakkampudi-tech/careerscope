import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Auth, Database } from '@careerscope/core';

test(
  'a sign-in is a new device only when the account has sessions and none came from that device',
  { timeout: 60_000 },
  async () => {
    const configuredDatabase = process.env.DATABASE_URL;
    assert.ok(configuredDatabase, 'integration test requires an isolated DATABASE_URL');
    const databaseUrl = new URL(configuredDatabase);
    assert.ok(['127.0.0.1', 'localhost'].includes(databaseUrl.hostname));
    const admin = new Database(configuredDatabase);
    const name = `test_${randomUUID().replaceAll('-', '')}`;
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    databaseUrl.pathname = `/${name}`;
    const database = new Database(databaseUrl.href);

    try {
      await migrate(database.db, {
        migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
      });
      const auth = new Auth(database);
      const email = 'new-device@example.test';

      // No account: nothing to alert about.
      assert.equal(await auth.isNewDevice(email, 'Chrome on Windows'), false);

      await database.pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        randomUUID(),
        email,
      ]);
      // First sign-in on an account is not a new device.
      assert.ok(await auth.loginWithVerifiedEmail(email, undefined, 'Chrome on Windows'));
      assert.equal(await auth.isNewDevice(email, 'Chrome on Windows'), false);
      // A device label the account has used before is not new.
      assert.equal(await auth.isNewDevice(email, 'Chrome on Windows'), false);
      // A different device is new.
      assert.equal(await auth.isNewDevice(email, 'Firefox on Linux'), true);
      // Without a label, an account with only labelled sessions is still a new device.
      assert.equal(await auth.isNewDevice(email, undefined), true);
    } finally {
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.close();
    }
  },
);
