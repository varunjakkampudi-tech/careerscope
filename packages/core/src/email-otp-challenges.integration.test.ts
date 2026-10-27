import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { Database } from './database.js';
import { createEmailOtp } from './email-otp.js';
import { EmailOtpChallenges } from './email-otp-challenges.js';

test('OTP challenges replace, atomically consume, expire, and enforce a single-use attempt budget', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'integration test requires an isolated DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));

  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  const challenges = new EmailOtpChallenges(database.pool);
  const migrationsFolder = fileURLToPath(new URL('../../../migrations', import.meta.url));
  const secret = Buffer.alloc(32, 7);
  const now = Date.now();

  try {
    await migrate(database.db, { migrationsFolder });

    const firstId = randomUUID();
    const first = createEmailOtp(firstId, secret, now);
    await challenges.replaceActive(
      {
        id: firstId,
        email: '  Candidate@Example.Test ',
        digest: first.digest,
        expiresAt: first.expiresAt,
      },
      secret,
    );

    const secondId = randomUUID();
    const second = createEmailOtp(secondId, secret, now);
    await challenges.replaceActive(
      {
        id: secondId,
        email: 'candidate@example.test',
        digest: second.digest,
        expiresAt: second.expiresAt,
      },
      secret,
    );
    const stored = await database.pool.query<{ email_hash: string }>(
      'SELECT email_hash FROM email_otp_challenges WHERE id = $1',
      [secondId],
    );
    assert.equal(stored.rows[0]?.email_hash.length, 64);
    assert.equal('email' in (stored.rows[0] ?? {}), false);
    assert.equal(
      await challenges.consume({
        id: firstId,
        email: 'candidate@example.test',
        code: first.code,
        secret,
        now,
      }),
      'invalid',
    );
    assert.equal(
      await challenges.consume({
        id: secondId,
        email: 'other@example.test',
        code: second.code,
        secret,
        now,
      }),
      'invalid',
    );
    assert.equal(
      await challenges.consume({
        id: secondId,
        email: 'candidate@example.test',
        code: second.code,
        secret,
        now,
      }),
      'accepted',
    );
    assert.equal(
      await challenges.consume({
        id: secondId,
        email: 'candidate@example.test',
        code: second.code,
        secret,
        now,
      }),
      'invalid',
    );

    const exhaustedId = randomUUID();
    const exhausted = createEmailOtp(exhaustedId, secret, now);
    await challenges.replaceActive(
      {
        id: exhaustedId,
        email: 'attempts@example.test',
        digest: exhausted.digest,
        expiresAt: exhausted.expiresAt,
      },
      secret,
    );
    const wrongCode = exhausted.code === '000000' ? '000001' : '000000';
    const concurrent = await Promise.all(
      Array.from({ length: 8 }, () =>
        challenges.consume({
          id: exhaustedId,
          email: 'attempts@example.test',
          code: wrongCode,
          secret,
          now,
        }),
      ),
    );
    assert.equal(concurrent.filter((result) => result === 'incorrect').length, 4);
    assert.equal(concurrent.filter((result) => result === 'exhausted').length, 1);
    assert.equal(concurrent.filter((result) => result === 'invalid').length, 3);
    const exhaustedRow = await database.pool.query<{ attempts: number }>(
      'SELECT attempts FROM email_otp_challenges WHERE id = $1',
      [exhaustedId],
    );
    assert.deepEqual(exhaustedRow.rows, []);

    const expiredId = randomUUID();
    const expired = createEmailOtp(expiredId, secret, now);
    await challenges.replaceActive(
      {
        id: expiredId,
        email: 'expired@example.test',
        digest: expired.digest,
        expiresAt: expired.expiresAt,
      },
      secret,
    );
    assert.equal(
      await challenges.consume({
        id: expiredId,
        email: 'expired@example.test',
        code: expired.code,
        secret,
        now: expired.expiresAt,
      }),
      'expired',
    );
    assert.deepEqual(
      (await database.pool.query('SELECT id FROM email_otp_challenges WHERE id = $1', [expiredId]))
        .rows,
      [],
    );
  } finally {
    await database.close();
    try {
      await admin.pool.query(`DROP DATABASE "${name}"`);
    } finally {
      await admin.close();
    }
  }
});
