import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Pool } from 'pg';
import { createEmailOtp } from './email-otp.js';
import { EmailOtpChallenges } from './email-otp-challenges.js';
import { EmailChangeRequests } from './email-change-requests.js';

const secret = Buffer.alloc(32, 13);

function recordingPool(respond: (sql: string) => { rows: unknown[] }) {
  const queries: string[] = [];
  const pool = {
    connect: async () => ({
      query: async (sql: string) => {
        queries.push(sql.replace(/\s+/g, ' ').trim());
        return respond(sql);
      },
      release: () => undefined,
    }),
  } as unknown as Pool;
  return { pool, queries };
}

test('replaceActive leaves a recently issued unexpired challenge untouched during cooldown', async () => {
  const id = randomUUID();
  const otp = createEmailOtp(id, secret);
  const { pool, queries } = recordingPool((sql) => ({
    rows: sql.includes('created_at >') ? [{}] : [],
  }));
  const stored = await new EmailOtpChallenges(pool).replaceActive(
    { id, email: 'candidate@example.test', digest: otp.digest, expiresAt: otp.expiresAt },
    secret,
    { cooldownMs: 60_000 },
  );

  assert.equal(stored, false);
  assert.ok(!queries.some((query) => query.startsWith('INSERT INTO email_otp_challenges')));
  assert.ok(
    !queries.some((query) => query.includes('WHERE email_hash = $1') && query.startsWith('DELETE')),
  );
  assert.equal(queries.at(-1), 'COMMIT');
});

test('replaceActive replaces the challenge when no recent one exists or no cooldown is given', async () => {
  const id = randomUUID();
  const otp = createEmailOtp(id, secret);
  const input = {
    id,
    email: 'candidate@example.test',
    digest: otp.digest,
    expiresAt: otp.expiresAt,
  };
  const withCooldown = recordingPool(() => ({ rows: [] }));
  assert.equal(
    await new EmailOtpChallenges(withCooldown.pool).replaceActive(input, secret, {
      cooldownMs: 60_000,
    }),
    true,
  );
  assert.ok(
    withCooldown.queries.some((query) => query.startsWith('INSERT INTO email_otp_challenges')),
  );

  // Without a cooldown the recent-challenge probe is never issued (legacy behavior).
  const without = recordingPool(() => ({ rows: [{}] }));
  assert.equal(await new EmailOtpChallenges(without.pool).replaceActive(input, secret), true);
  assert.ok(!without.queries.some((query) => query.includes('created_at >')));
});

test('begin deletes the owner expired pending rows before upserting the new request', async () => {
  const now = Date.now();
  const { pool, queries } = recordingPool((sql) => ({
    rows: sql.includes('FROM users')
      ? [{ email: 'owner@example.test', email_verified_at: new Date(now) }]
      : [],
  }));
  const codes = await new EmailChangeRequests(pool).begin(
    randomUUID(),
    'new@example.test',
    secret,
    now,
  );

  assert.ok(codes);
  const deleteIndex = queries.findIndex(
    (query) =>
      query.startsWith('DELETE FROM email_change_requests') && query.includes('expires_at <='),
  );
  const insertIndex = queries.findIndex((query) =>
    query.startsWith('INSERT INTO email_change_requests'),
  );
  assert.ok(deleteIndex >= 0 && insertIndex > deleteIndex);
  assert.ok(queries[insertIndex]!.includes('ON CONFLICT (owner_id)'));
});
