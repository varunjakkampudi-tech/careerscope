import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { createEmailOtp } from './email-otp.js';
import { EmailOtpChallenges } from './email-otp-challenges.js';

test('OTP expiry is evaluated after the challenge row lock is acquired', async () => {
  const id = randomUUID();
  const email = 'candidate@example.test';
  const secret = Buffer.alloc(32, 11);
  const issuedAt = Date.now();
  const otp = createEmailOtp(id, secret, issuedAt);
  let now = issuedAt + 1;
  const queries: string[] = [];

  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        queries.push(sql.trim());
        if (sql.includes('SELECT digest, attempts, expires_at')) {
          // Model another transaction holding the row until the OTP's exact
          // expiry boundary has passed.
          now = otp.expiresAt;
          return {
            rows: [
              {
                digest: otp.digest,
                attempts: 0,
                expires_at: new Date(otp.expiresAt),
                intent: 'sign-in',
                terms_version: null,
                privacy_version: null,
                marketing_opt_in: false,
                marketing_version: null,
              },
            ],
          };
        }
        return { rows: [] };
      },
      release: () => undefined,
    }),
  } as unknown as Pool;

  const challenges = new EmailOtpChallenges(pool, () => now);
  const result = await challenges.consume({ id, email, code: otp.code, secret });

  assert.equal(result, 'expired');
  assert.ok(queries.some((query) => query.includes('FOR UPDATE')));
  assert.ok(queries.some((query) => query.startsWith('DELETE FROM email_otp_challenges')));
  assert.equal(queries.at(-1), 'COMMIT');
});
