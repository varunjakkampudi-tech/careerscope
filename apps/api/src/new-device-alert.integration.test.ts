import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  Auth,
  Database,
  type EmailNoticeMessage,
  type EmailOtpDeliveryMessage,
} from '@careerscope/core';
import { createApp, type RateLimit } from './app.js';

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
    await admin.pool.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
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

      const origin = 'https://careerscope.test';
      const secret = Buffer.alloc(32, 7);
      const apiEmail = 'new-device-alert-route@example.test';
      await database.pool.query('INSERT INTO users (id, email) VALUES ($1, $2)', [
        randomUUID(),
        apiEmail,
      ]);
      const delivered: EmailOtpDeliveryMessage[] = [];
      const notices: EmailNoticeMessage[] = [];
      const counts = new Map<string, number>();
      const rateLimit: RateLimit = async (key, limit, _seconds, peek) => {
        if (peek) return (counts.get(key) ?? 0) < limit;
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        return count <= limit;
      };
      const provider = {
        async send(message: EmailOtpDeliveryMessage) {
          delivered.push(message);
        },
        async sendNotice(notice: EmailNoticeMessage) {
          notices.push(notice);
        },
      };
      const app = await createApp(database, origin, rateLimit, {
        emailOtp: { secret, provider },
      });
      try {
        const signIn = async (userAgent: string) => {
          counts.clear();
          const requested = await app.inject({
            method: 'POST',
            url: '/api/otp/request',
            headers: { origin },
            payload: { email: apiEmail },
          });
          assert.equal(requested.statusCode, 202);
          const code = delivered.at(-1);
          assert.ok(code);
          const verified = await app.inject({
            method: 'POST',
            url: '/api/otp/verify',
            headers: { origin, 'user-agent': userAgent },
            payload: { email: apiEmail, code: code.code },
          });
          assert.equal(verified.statusCode, 200);
        };

        // The first device establishes a session and should not generate a suspicious-activity notice.
        await signIn('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0');
        assert.equal(notices.length, 0);

        // A later sign-in from a previously unseen browser/platform sends one code-free notice.
        await signIn('Mozilla/5.0 (X11; Linux x86_64) Firefox/132.0');
        assert.equal(notices.length, 1);
        assert.equal(notices[0]?.email, apiEmail);
        assert.equal(notices[0]?.subject, 'New sign-in to your CareerScope account');
        assert.match(notices[0]?.text ?? '', /Firefox on Linux/);
        assert.doesNotMatch(notices[0]?.text ?? '', /\b\d{6}\b/);

        // Repeating the same known device label does not send another alert.
        await signIn('Mozilla/5.0 (X11; Linux x86_64) Firefox/132.0');
        assert.equal(notices.length, 1);
      } finally {
        await app.close();
      }
    } finally {
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.close();
    }
  },
);
