import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FastifyInstance } from 'fastify';
import { Auth, Database, refreshCookie } from '@careerscope/core';
import { createApp } from './app.js';

test(
  'sign-out with only the refresh cookie revokes the family after the access cookie expired',
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
    const origin = 'https://careerscope.test';
    let app: FastifyInstance | undefined;

    try {
      await migrate(database.db, {
        migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
      });
      const email = 'session-logout@example.test';
      await database.pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        randomUUID(),
        email,
      ]);
      const auth = new Auth(database);
      const credentials = await auth.loginWithVerifiedEmail(email);
      assert.ok(credentials);
      app = await createApp(database, origin, async () => true, {
        testAccess: { mode: 'disabled' },
      });
      const refresh = `${refreshCookie}=${credentials.refreshToken}`;

      // The access cookie has expired in the browser, so only the refresh cookie is sent.
      await database.pool.query(
        `UPDATE sessions SET access_expires_at = now() - interval '1 minute'`,
      );
      const signOut = await app.inject({
        method: 'POST',
        url: '/api/session/logout',
        headers: { origin, cookie: refresh },
      });
      assert.equal(signOut.statusCode, 200);

      const revoked = await database.pool.query<{ revoked: boolean }>(
        'SELECT revoked_at IS NOT NULL AS revoked FROM sessions',
      );
      assert.deepEqual(
        revoked.rows.map((row) => row.revoked),
        [true],
      );
      const replay = await app.inject({
        method: 'POST',
        url: '/api/session/refresh',
        headers: { origin, cookie: refresh },
      });
      assert.equal(replay.statusCode, 401);
    } finally {
      await app?.close();
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.close();
    }
  },
);
