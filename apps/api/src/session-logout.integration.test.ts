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
    await admin.pool.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
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

test(
  'session inventory is owner-scoped and device revocation preserves only the chosen session',
  { timeout: 60_000 },
  async () => {
    const configuredDatabase = process.env.DATABASE_URL;
    assert.ok(configuredDatabase, 'integration test requires an isolated DATABASE_URL');
    const databaseUrl = new URL(configuredDatabase);
    assert.ok(['127.0.0.1', 'localhost'].includes(databaseUrl.hostname));
    const admin = new Database(configuredDatabase);
    const name = `test_${randomUUID().replaceAll('-', '')}`;
    await admin.pool.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    databaseUrl.pathname = `/${name}`;
    const database = new Database(databaseUrl.href);
    const origin = 'https://careerscope.test';
    let app: FastifyInstance | undefined;

    try {
      await migrate(database.db, {
        migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
      });
      const ownerId = randomUUID();
      const foreignOwnerId = randomUUID();
      await database.pool.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [
        ownerId,
        'session-owner@example.test',
        foreignOwnerId,
        'session-foreign@example.test',
      ]);

      const auth = new Auth(database);
      const current = await auth.loginWithVerifiedEmail(
        'session-owner@example.test',
        undefined,
        'Current browser',
      );
      const phone = await auth.loginWithVerifiedEmail(
        'session-owner@example.test',
        undefined,
        'Phone',
      );
      const foreign = await auth.loginWithVerifiedEmail(
        'session-foreign@example.test',
        undefined,
        'Other account',
      );
      assert.ok(current);
      assert.ok(phone);
      assert.ok(foreign);
      app = await createApp(database, origin, async () => true, {
        testAccess: { mode: 'disabled' },
      });

      const currentCookie = `careerscope_v2_session=${current.accessToken}`;
      const currentSession = await app.inject({
        method: 'GET',
        url: '/api/session',
        headers: { cookie: currentCookie },
      });
      assert.equal(currentSession.json().authenticated, true);
      const csrf = currentSession.json().csrf as string;

      const inventory = await app.inject({
        method: 'GET',
        url: '/api/account/sessions',
        headers: { cookie: currentCookie },
      });
      assert.equal(inventory.statusCode, 200);
      assert.deepEqual(
        inventory
          .json()
          .sessions.map((session: { deviceLabel: string }) => session.deviceLabel)
          .sort(),
        ['Current browser', 'Phone'],
        'the inventory lists only the caller’s active devices',
      );
      assert.equal(
        inventory
          .json()
          .sessions.find((session: { id: string }) => session.id === current.sessionId)?.current,
        true,
      );
      assert.equal(
        inventory.json().sessions.find((session: { id: string }) => session.id === phone.sessionId)
          ?.current,
        false,
      );

      const revokePhone = await app.inject({
        method: 'DELETE',
        url: `/api/account/sessions/${phone.sessionId}`,
        headers: { origin, cookie: currentCookie, 'x-csrf-token': csrf },
      });
      assert.equal(revokePhone.statusCode, 204);
      const revokedPhone = await app.inject({
        method: 'GET',
        url: '/api/session',
        headers: { cookie: `careerscope_v2_session=${phone.accessToken}` },
      });
      assert.equal(revokedPhone.json().authenticated, false);

      const revokeForeign = await app.inject({
        method: 'DELETE',
        url: `/api/account/sessions/${foreign.sessionId}`,
        headers: { origin, cookie: currentCookie, 'x-csrf-token': csrf },
      });
      assert.equal(revokeForeign.statusCode, 404);
      const foreignStillActive = await app.inject({
        method: 'GET',
        url: '/api/session',
        headers: { cookie: `careerscope_v2_session=${foreign.accessToken}` },
      });
      assert.equal(foreignStillActive.json().authenticated, true);

      const tablet = await auth.loginWithVerifiedEmail(
        'session-owner@example.test',
        undefined,
        'Tablet',
      );
      assert.ok(tablet);
      const revokeOthers = await app.inject({
        method: 'POST',
        url: '/api/account/sessions/revoke-others',
        headers: { origin, cookie: currentCookie, 'x-csrf-token': csrf },
        payload: {},
      });
      assert.equal(revokeOthers.statusCode, 204);
      assert.equal(
        (await app.inject({ url: '/api/session', headers: { cookie: currentCookie } })).json()
          .authenticated,
        true,
        'revoking other devices preserves the current session',
      );
      assert.equal(
        (
          await app.inject({
            url: '/api/session',
            headers: { cookie: `careerscope_v2_session=${tablet.accessToken}` },
          })
        ).json().authenticated,
        false,
      );
      assert.equal(
        (
          await database.pool.query(
            'SELECT id FROM sessions WHERE owner_id = $1 AND revoked_at IS NULL',
            [ownerId],
          )
        ).rows.length,
        1,
        'only the selected current device remains active',
      );
      assert.equal(
        (
          await database.pool.query(
            'SELECT id FROM sessions WHERE owner_id = $1 AND revoked_at IS NULL',
            [foreignOwnerId],
          )
        ).rows.length,
        1,
        'session cleanup never affects another owner',
      );
    } finally {
      await app?.close();
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.close();
    }
  },
);
