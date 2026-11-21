import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { Auth, Database, refreshCookie, sessionCookie } from '@careerscope/core';
import { createApp } from './app.js';

test(
  'saved searches are validated, capped, and scoped to their owner',
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
      const otherOwnerId = randomUUID();
      await database.pool.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [
        ownerId,
        `${ownerId}@example.test`,
        otherOwnerId,
        `${otherOwnerId}@example.test`,
      ]);
      const auth = new Auth(database);
      const credentials = await auth.loginWithVerifiedEmail(`${ownerId}@example.test`);
      const otherCredentials = await auth.loginWithVerifiedEmail(`${otherOwnerId}@example.test`);
      assert.ok(credentials);
      assert.ok(otherCredentials);
      const session = await auth.session(credentials.accessToken);
      const otherSession = await auth.session(otherCredentials.accessToken);
      assert.ok(session);
      assert.ok(otherSession);
      const cookie = `${sessionCookie}=${credentials.accessToken}; ${refreshCookie}=${credentials.refreshToken}`;
      const otherCookie = `${sessionCookie}=${otherCredentials.accessToken}; ${refreshCookie}=${otherCredentials.refreshToken}`;
      const appServer = await createApp(database, origin, async () => true, {
        testAccess: { mode: 'disabled' },
      });
      app = appServer;

      const created = await appServer.inject({
        method: 'POST',
        url: '/api/saved-searches',
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: { name: 'React roles', request: { query: 'React', sources: ['remoteok'] } },
      });
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(created.json().request.origin, 'manual');

      const ownList = await appServer.inject({ url: '/api/saved-searches', headers: { cookie } });
      assert.equal(ownList.statusCode, 200);
      assert.equal(ownList.json().items.length, 1);
      assert.equal(ownList.json().items[0].name, 'React roles');
      const foreignList = await appServer.inject({
        url: '/api/saved-searches',
        headers: { cookie: otherCookie },
      });
      assert.deepEqual(foreignList.json().items, []);

      const duplicate = await appServer.inject({
        method: 'POST',
        url: '/api/saved-searches',
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: { name: 'react ROLES', request: { query: 'React', sources: ['remoteok'] } },
      });
      assert.equal(duplicate.statusCode, 409);

      const invalid = await appServer.inject({
        method: 'POST',
        url: '/api/saved-searches',
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: { name: 'Invalid query', request: { query: 'x', sources: ['remoteok'] } },
      });
      assert.equal(invalid.statusCode, 400);

      const foreignDelete = await appServer.inject({
        method: 'DELETE',
        url: `/api/saved-searches/${created.json().id}`,
        headers: { origin, cookie: otherCookie, 'x-csrf-token': otherSession.csrf },
      });
      assert.equal(foreignDelete.statusCode, 404);

      for (let index = 1; index < 25; index += 1) {
        assert.equal(
          (
            await appServer.inject({
              method: 'POST',
              url: '/api/saved-searches',
              headers: { origin, cookie, 'x-csrf-token': session.csrf },
              payload: {
                name: `Role search ${index}`,
                request: { query: `Role ${index}`, sources: ['remoteok'] },
              },
            })
          ).statusCode,
          201,
        );
      }
      const capped = await appServer.inject({
        method: 'POST',
        url: '/api/saved-searches',
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: {
          name: 'One too many',
          request: { query: 'Another role', sources: ['remoteok'] },
        },
      });
      assert.equal(capped.statusCode, 409);

      const deleted = await appServer.inject({
        method: 'DELETE',
        url: `/api/saved-searches/${created.json().id}`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
      });
      assert.equal(deleted.statusCode, 204);
      assert.equal(
        (await appServer.inject({ url: '/api/saved-searches', headers: { cookie } })).json().items
          .length,
        24,
      );
    } finally {
      await app?.close();
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.close();
    }
  },
);
