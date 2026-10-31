import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import { Database } from './database.js';
import { createEmailOtp } from './email-otp.js';
import { EmailOtpChallenges } from './email-otp-challenges.js';
import { EmailChangeRequests } from './email-change-requests.js';

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

test('email change (API-06) needs both address codes, bounds attempts and expiry, and never takes another account email', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'integration test requires an isolated DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));

  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  const changes = new EmailChangeRequests(database.pool);
  const migrationsFolder = fileURLToPath(new URL('../../../migrations', import.meta.url));
  const secret = Buffer.alloc(32, 9);
  const now = Date.now();
  const owner = randomUUID();
  const other = randomUUID();
  const unverified = randomUUID();
  const emailOf = async (id: string) =>
    (await database.pool.query<{ email: string }>('SELECT email FROM users WHERE id = $1', [id]))
      .rows[0]?.email;
  const pending = async (id: string) =>
    (await database.pool.query('SELECT id FROM email_change_requests WHERE owner_id = $1', [id]))
      .rowCount;
  const wrong = (code: string) => (code === '000000' ? '111111' : '000000');

  try {
    await migrate(database.db, { migrationsFolder });
    await database.pool.query(
      `INSERT INTO users (id, email, email_verified_at) VALUES
        ($1, 'owner@example.test', now()), ($2, 'taken@example.test', now()), ($3, 'unverified@example.test', NULL)`,
      [owner, other, unverified],
    );

    // Preconditions: unverified current email, or the same address, cannot start a change.
    assert.equal(await changes.begin(unverified, 'new-unverified@example.test', secret, now), null);
    assert.equal(await changes.begin(owner, ' OWNER@example.test ', secret, now), null);
    assert.equal(await pending(owner), 0);
    await assert.rejects(changes.begin(owner, 'not-an-email', secret, now));

    // Codes are not persisted, and each address has its own code.
    const first = (await changes.begin(owner, 'New@Example.Test', secret, now))!;
    assert.equal(first.newEmail, 'new@example.test');
    assert.equal(first.currentEmail, 'owner@example.test');
    const stored = await database.pool.query<{ current_digest: string; new_digest: string }>(
      'SELECT current_digest, new_digest FROM email_change_requests WHERE owner_id = $1',
      [owner],
    );
    assert.ok(
      ![stored.rows[0]!.current_digest, stored.rows[0]!.new_digest].includes(first.currentCode),
    );

    // One verified address alone never changes the email; the codes are not interchangeable.
    const verify = (address: 'current' | 'new', code: unknown, at = now + 1000, id = owner) =>
      changes.verify({ ownerId: id, address, code, secret, now: at });
    assert.equal(await verify('current', wrong(first.currentCode)), 'incorrect');
    assert.equal(await verify('current', first.currentCode), 'accepted');
    assert.equal(await verify('current', first.currentCode), 'already-verified');
    assert.equal(await emailOf(owner), 'owner@example.test');
    assert.equal(await verify('new', first.newCode), 'completed');
    assert.equal(await emailOf(owner), 'new@example.test');
    assert.equal(await pending(owner), 0);
    assert.equal(
      await verify('new', first.newCode),
      'invalid',
      'a completed request cannot be replayed',
    );

    // Five wrong codes delete the request.
    const second = (await changes.begin(owner, 'second@example.test', secret, now))!;
    for (let attempt = 1; attempt < 5; attempt += 1)
      assert.equal(await verify('new', wrong(second.newCode)), 'incorrect');
    assert.equal(await verify('new', wrong(second.newCode)), 'exhausted');
    assert.equal(await pending(owner), 0);
    assert.equal(await verify('new', second.newCode), 'invalid');

    // Expiry deletes the request; non-string codes are rejected without consuming it as success.
    const third = (await changes.begin(owner, 'third@example.test', secret, now))!;
    assert.notEqual(await verify('new', 123456 as unknown), 'accepted');
    assert.equal(await verify('new', third.newCode, now + 5 * 60 * 1000), 'expired');
    assert.equal(await pending(owner), 0);

    // Replacing a request invalidates the earlier codes and resets state.
    const fourth = (await changes.begin(owner, 'fourth@example.test', secret, now))!;
    assert.equal(await verify('current', fourth.currentCode), 'accepted');
    const fifth = (await changes.begin(owner, 'fifth@example.test', secret, now))!;
    assert.equal(await pending(owner), 1);
    assert.equal(await verify('current', fourth.currentCode), 'incorrect');
    assert.equal(await verify('current', fifth.currentCode), 'accepted');

    // Another user cannot cancel or verify this request; the owner can cancel.
    await changes.cancel(other, fifth.requestId);
    assert.equal(await pending(owner), 1);
    assert.equal(await verify('new', fifth.newCode, now + 1000, other), 'invalid');
    await changes.cancel(owner, fifth.requestId);
    assert.equal(await pending(owner), 0);

    // An address taken by another account yields a conflict and no change.
    const taken = (await changes.begin(owner, 'taken@example.test', secret, now))!;
    assert.equal(await verify('current', taken.currentCode), 'accepted');
    assert.equal(await verify('new', taken.newCode), 'conflict');
    assert.equal(await emailOf(owner), 'new@example.test');
    assert.equal(await emailOf(other), 'taken@example.test');
    assert.equal(await pending(owner), 0);
  } finally {
    await database.close();
    try {
      await admin.pool.query(`DROP DATABASE "${name}"`);
    } finally {
      await admin.close();
    }
  }
});
