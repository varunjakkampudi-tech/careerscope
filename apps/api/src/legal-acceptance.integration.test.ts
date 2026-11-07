import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FastifyInstance } from 'fastify';
import { Auth, Database, refreshCookie, sessionCookie } from '@careerscope/core';
import { createApp } from './app.js';

test(
  'changed terms must be accepted before an account can change anything; reads stay open',
  { timeout: 90_000 },
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
      const stale = 'legal-stale@example.test';
      const fresh = 'legal-fresh@example.test';
      const staleId = randomUUID();
      const freshId = randomUUID();
      await database.pool.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [
        staleId,
        stale,
        freshId,
        fresh,
      ]);
      // The stale account accepted version 1. The fresh account has no record at all.
      for (const [document, version] of [
        ['terms', 'terms-1'],
        ['privacy_notice', 'privacy-1'],
      ] as const)
        await database.pool.query(
          `INSERT INTO account_acceptances (id, owner_id, document, version, accepted)
           VALUES ($1, $2, $3, $4, true)`,
          [randomUUID(), staleId, document, version],
        );

      const auth = new Auth(database);
      const staleSession = await auth.loginWithVerifiedEmail(stale);
      const freshSession = await auth.loginWithVerifiedEmail(fresh);
      assert.ok(staleSession && freshSession);
      app = await createApp(database, origin, async () => true, {
        testAccess: { mode: 'disabled' },
        registrationPolicy: {
          termsVersion: 'terms-2',
          termsUrl: 'https://careerscope.test/terms',
          privacyVersion: 'privacy-2',
          privacyUrl: 'https://careerscope.test/privacy',
          marketingVersion: 'marketing-1',
        },
      });
      const sessionFor = (credentials: { accessToken: string; refreshToken: string }) => {
        const cookie = `${sessionCookie}=${credentials.accessToken}; ${refreshCookie}=${credentials.refreshToken}`;
        return { cookie };
      };
      const csrfFor = async (cookie: string) =>
        (
          await app!.inject({ method: 'GET', url: '/api/session', headers: { origin, cookie } })
        ).json().csrf as string;
      const staleCookie = sessionFor(staleSession).cookie;
      const staleCsrf = await csrfFor(staleCookie);
      const freshCookie = sessionFor(freshSession).cookie;
      const freshCsrf = await csrfFor(freshCookie);

      // The stale account sees that it must accept, and its reads still work.
      const status = await app.inject({
        method: 'GET',
        url: '/api/account/legal',
        headers: { cookie: staleCookie },
      });
      assert.equal(status.json().acceptanceRequired, true);
      assert.equal(status.json().acceptedTermsVersion, 'terms-1');
      assert.equal(
        (
          await app.inject({
            method: 'GET',
            url: '/api/session',
            headers: { origin, cookie: staleCookie },
          })
        ).statusCode,
        200,
      );

      // Any change is refused until acceptance.
      const blocked = await app.inject({
        method: 'POST',
        url: '/api/account/marketing-consent',
        headers: { origin, cookie: staleCookie, 'x-csrf-token': staleCsrf },
        payload: { optIn: true },
      });
      assert.equal(blocked.statusCode, 403);
      assert.equal(blocked.json().message, 'Accept the updated terms to continue');

      // Accepting an out-of-date version is refused, and the current one is recorded.
      const stalePolicy = await app.inject({
        method: 'POST',
        url: '/api/account/legal/accept',
        headers: { origin, cookie: staleCookie, 'x-csrf-token': staleCsrf },
        payload: { termsVersion: 'terms-1', privacyVersion: 'privacy-1' },
      });
      assert.equal(stalePolicy.statusCode, 409);
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/account/legal/accept',
        headers: { origin, cookie: staleCookie, 'x-csrf-token': staleCsrf },
        payload: { termsVersion: 'terms-2', privacyVersion: 'privacy-2' },
      });
      assert.equal(accepted.statusCode, 200);
      assert.equal(accepted.json().acceptanceRequired, false);
      const acceptedAgain = await app.inject({
        method: 'POST',
        url: '/api/account/legal/accept',
        headers: { origin, cookie: staleCookie, 'x-csrf-token': staleCsrf },
        payload: { termsVersion: 'terms-2', privacyVersion: 'privacy-2' },
      });
      assert.equal(acceptedAgain.statusCode, 200);
      assert.equal(acceptedAgain.json().acceptanceRequired, false);
      const after = await app.inject({
        method: 'POST',
        url: '/api/account/marketing-consent',
        headers: { origin, cookie: staleCookie, 'x-csrf-token': staleCsrf },
        payload: { optIn: true },
      });
      assert.notEqual(after.statusCode, 403);

      // An account with no record is not forced, because it predates the record.
      const freshStatus = await app.inject({
        method: 'GET',
        url: '/api/account/legal',
        headers: { cookie: freshCookie },
      });
      assert.equal(freshStatus.json().acceptanceRequired, false);
      const freshChange = await app.inject({
        method: 'POST',
        url: '/api/account/marketing-consent',
        headers: { origin, cookie: freshCookie, 'x-csrf-token': freshCsrf },
        payload: { optIn: true },
      });
      assert.notEqual(freshChange.statusCode, 403);

      // The ledger grows once per accepted version, not on every acceptance.
      const rows = await database.pool.query(
        `SELECT document, count(*) FROM account_acceptances
         WHERE owner_id = $1 AND document IN ('terms', 'privacy_notice')
         GROUP BY document`,
        [staleId],
      );
      assert.deepEqual(
        Object.fromEntries(rows.rows.map((row) => [row.document, Number(row.count)])),
        { privacy_notice: 2, terms: 2 },
        're-accepting current versions must not duplicate ledger entries',
      );
    } finally {
      await app?.close();
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.close();
    }
  },
);
