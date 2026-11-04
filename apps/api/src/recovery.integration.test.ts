import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { FastifyInstance } from 'fastify';
import {
  Auth,
  Database,
  refreshCookie,
  sessionCookie,
  type EmailNoticeMessage,
  type EmailOtpDeliveryMessage,
} from '@careerscope/core';
import { createApp } from './app.js';

test(
  'lost-email recovery: confirm a recovery address, cooldown, recovery sign-in and rejections',
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
    const secret = Buffer.alloc(32, 41);
    const delivered: EmailOtpDeliveryMessage[] = [];
    const notices: EmailNoticeMessage[] = [];
    const provider = {
      async send(message: EmailOtpDeliveryMessage) {
        delivered.push(message);
      },
      async sendNotice(notice: EmailNoticeMessage) {
        notices.push(notice);
      },
    };
    let app: FastifyInstance | undefined;

    try {
      await migrate(database.db, {
        migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
      });
      const primary = 'recovery-owner@example.test';
      const recovery = 'recovery-backup@example.test';
      const other = 'recovery-other@example.test';
      await database.pool.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [
        randomUUID(),
        primary,
        randomUUID(),
        other,
      ]);
      const auth = new Auth(database);
      const credentials = await auth.loginWithVerifiedEmail(primary);
      assert.ok(credentials);
      app = await createApp(database, origin, async () => true, {
        testAccess: { mode: 'disabled' },
        emailOtp: { secret, provider },
      });
      const cookie = `${sessionCookie}=${credentials.accessToken}; ${refreshCookie}=${credentials.refreshToken}`;
      const csrf = (
        await app.inject({ method: 'GET', url: '/api/session', headers: { origin, cookie } })
      ).json().csrf as string;
      const authed = { origin, cookie, 'x-csrf-token': csrf };
      const anonymous = { origin };
      const last = () => delivered[delivered.length - 1]!;
      const wrongCode = (code: string) => (code === '000000' ? '111111' : '000000');

      // Not configured yet.
      const status = await app.inject({
        method: 'GET',
        url: '/api/account/recovery-email',
        headers: { cookie },
      });
      assert.deepEqual(status.json(), {
        configured: false,
        verifiedAt: null,
        cooldownEndsAt: null,
        available: false,
      });

      // A recovery address that is another account's sign-in address is never sent a code.
      await app.inject({
        method: 'POST',
        url: '/api/account/recovery-email/request',
        headers: authed,
        payload: { email: other },
      });
      assert.equal(delivered.length, 0);

      // Confirm the recovery address with its code.
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/account/recovery-email/request',
            headers: authed,
            payload: { email: recovery },
          })
        ).statusCode,
        202,
      );
      assert.equal(last().purpose, 'recovery-setup');
      assert.equal(last().email, recovery);
      const setupCode = last().code;
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/account/recovery-email/verify',
            headers: authed,
            payload: { email: recovery, code: wrongCode(setupCode) },
          })
        ).statusCode,
        401,
      );
      const confirmed = await app.inject({
        method: 'POST',
        url: '/api/account/recovery-email/verify',
        headers: authed,
        payload: { email: recovery, code: setupCode },
      });
      assert.equal(confirmed.statusCode, 200);
      assert.equal(confirmed.json().configured, true);
      assert.ok(notices.some((notice) => notice.email === primary));

      // During the cooldown, recovery sign-in sends nothing and the reply is the same.
      const cooling = await app.inject({
        method: 'POST',
        url: '/api/recovery/request',
        headers: anonymous,
        payload: { email: primary },
      });
      assert.equal(cooling.statusCode, 202);
      assert.equal(delivered.filter((m) => m.purpose === 'recovery-sign-in').length, 0);

      // After the cooldown, a recovery code goes to the recovery address and signs the account in.
      await database.pool.query(
        `UPDATE users SET recovery_email_verified_at = now() - interval '73 hours' WHERE email = $1`,
        [primary],
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/recovery/request',
            headers: anonymous,
            payload: { email: primary },
          })
        ).statusCode,
        202,
      );
      assert.equal(last().purpose, 'recovery-sign-in');
      assert.equal(last().email, recovery);
      const recoveryCode = last().code;
      const rejected = await app.inject({
        method: 'POST',
        url: '/api/recovery/verify',
        headers: anonymous,
        payload: { email: primary, code: wrongCode(recoveryCode) },
      });
      assert.equal(rejected.statusCode, 401);
      const signedIn = await app.inject({
        method: 'POST',
        url: '/api/recovery/verify',
        headers: anonymous,
        payload: { email: primary, code: recoveryCode },
      });
      assert.equal(signedIn.statusCode, 200);
      assert.equal(signedIn.json().authenticated, true);
      assert.ok(String(signedIn.headers['set-cookie']).includes(sessionCookie));
      assert.ok(notices.some((notice) => notice.subject.includes('recovered')));
      // A code is single use.
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/recovery/verify',
            headers: anonymous,
            payload: { email: primary, code: recoveryCode },
          })
        ).statusCode,
        401,
      );

      // Removing the recovery address turns recovery off again.
      const removed = await app.inject({
        method: 'DELETE',
        url: '/api/account/recovery-email',
        headers: authed,
      });
      assert.equal(removed.statusCode, 200);
      assert.equal(removed.json().configured, false);
      const sentBefore = delivered.length;
      await app.inject({
        method: 'POST',
        url: '/api/recovery/request',
        headers: anonymous,
        payload: { email: primary },
      });
      assert.equal(delivered.length, sentBefore);
    } finally {
      await app?.close();
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.close();
    }
  },
);
