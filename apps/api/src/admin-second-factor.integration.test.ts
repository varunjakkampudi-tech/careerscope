import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  Auth,
  Database,
  decodeBase32,
  hashOtpEmail,
  hotp,
  setAccountRole,
  timeStep,
  type EmailOtpDeliveryMessage,
} from '@careerscope/core';
import { createApp } from './app.js';

const sessionCookie = 'careerscope_v2_session';
const refreshCookie = 'careerscope_v2_refresh';

// An admin needs an authenticator code as well as the email code, and a code can be used only once
// (V12-4.1-012). The database refuses an admin role on an account with no confirmed authenticator.
test(
  'an admin signs in only with the email code and a fresh authenticator code, and no code is reused',
  { timeout: 120_000 },
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
    const secret = Buffer.alloc(32, 41);
    const origin = 'https://careerscope.test';
    const email = 'admin-owner@example.test';
    const delivered: EmailOtpDeliveryMessage[] = [];
    const provider = {
      async send(message: EmailOtpDeliveryMessage) {
        delivered.push(message);
      },
    };
    let app: FastifyInstance | undefined;

    try {
      await migrate(database.db, {
        migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
      });
      const ownerId = randomUUID();
      await database.pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [ownerId, email]);
      const auth = new Auth(database);
      const credentials = await auth.loginWithVerifiedEmail(email);
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

      // Setup returns the secret once, and a wrong confirmation code is refused.
      const setup = await app.inject({
        method: 'POST',
        url: '/api/account/totp/setup',
        headers: authed,
      });
      assert.equal(setup.statusCode, 200);
      const secretText = setup.json().secret as string;
      assert.match(setup.json().otpauthUri, /^otpauth:\/\/totp\/CareerScope/);
      const authenticatorSecret = decodeBase32(secretText);
      const wrong = await app.inject({
        method: 'POST',
        url: '/api/account/totp/confirm',
        headers: authed,
        payload: { code: '000000' },
      });
      assert.equal(wrong.statusCode, 400);

      // The right code confirms enrolment. The admin role is still refused until it is confirmed.
      const confirmStep = timeStep(Date.now());
      const confirmed = await app.inject({
        method: 'POST',
        url: '/api/account/totp/confirm',
        headers: authed,
        payload: { code: hotp(authenticatorSecret, confirmStep) },
      });
      assert.equal(confirmed.statusCode, 200, confirmed.body);
      const again = await app.inject({
        method: 'POST',
        url: '/api/account/totp/setup',
        headers: authed,
      });
      assert.equal(again.statusCode, 409, 'a confirmed authenticator cannot be replaced by setup');

      // The database refuses an admin role for an account that has no confirmed authenticator.
      await database.pool.query('UPDATE users SET totp_enabled_at = NULL WHERE id = $1', [ownerId]);
      await assert.rejects(
        database.pool.query("UPDATE users SET role = 'admin' WHERE id = $1", [ownerId]),
        (error: { code?: string }) => error.code === '23514',
      );
      await database.pool.query('UPDATE users SET totp_enabled_at = now() WHERE id = $1', [
        ownerId,
      ]);
      assert.equal(await setAccountRole(database, email, 'admin'), true);

      // Sign-in: the email code alone is refused; a wrong authenticator code is refused; a fresh code works.
      // Each call must send a new email code, so a refusal is about the authenticator, not a spent code.
      const requestCode = async () => {
        // The sign-in cooldown would refuse a second code inside a minute. Removing the earlier challenge
        // keeps the test about the authenticator, not the cooldown.
        await database.pool.query('DELETE FROM email_otp_challenges WHERE email_hash = $1', [
          hashOtpEmail(email, secret),
        ]);
        const before = delivered.length;
        const response = await app!.inject({
          method: 'POST',
          url: '/api/otp/request',
          headers: { origin },
          payload: { email },
        });
        assert.equal(response.statusCode, 202);
        assert.equal(delivered.length, before + 1, 'a new code must be sent');
        return delivered[delivered.length - 1]!.code;
      };
      const emailCode = await requestCode();
      const withoutAuthenticator = await app.inject({
        method: 'POST',
        url: '/api/otp/verify',
        headers: { origin },
        payload: { email, code: emailCode },
      });
      assert.equal(withoutAuthenticator.statusCode, 401);

      const emailCodeWrongTotp = await requestCode();
      const wrongAuthenticator = await app.inject({
        method: 'POST',
        url: '/api/otp/verify',
        headers: { origin },
        payload: { email, code: emailCodeWrongTotp, totpCode: '000000' },
      });
      assert.equal(wrongAuthenticator.statusCode, 401);

      // The next time step is inside the drift window and newer than the confirmed step, so it is fresh.
      const freshCode = hotp(authenticatorSecret, confirmStep + 1);
      const emailCodeOk = await requestCode();
      const accepted = await app.inject({
        method: 'POST',
        url: '/api/otp/verify',
        headers: { origin },
        payload: { email, code: emailCodeOk, totpCode: freshCode },
      });
      assert.equal(accepted.statusCode, 200);
      assert.ok(String(accepted.headers['set-cookie']).includes(sessionCookie));

      // The same authenticator code cannot be used a second time, even with a new email code.
      const emailCodeReplay = await requestCode();
      const replay = await app.inject({
        method: 'POST',
        url: '/api/otp/verify',
        headers: { origin },
        payload: { email, code: emailCodeReplay, totpCode: freshCode },
      });
      assert.equal(replay.statusCode, 401);

      // A code from before the confirmed step is also refused.
      const emailCodeOld = await requestCode();
      const older = await app.inject({
        method: 'POST',
        url: '/api/otp/verify',
        headers: { origin },
        payload: { email, code: emailCodeOld, totpCode: hotp(authenticatorSecret, confirmStep) },
      });
      assert.equal(older.statusCode, 401);
    } finally {
      if (app) await app.close();
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.close();
    }
  },
);
