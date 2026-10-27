import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Auth } from './auth.js';
import { Database } from './database.js';
import { createEmailOtp } from './email-otp.js';
import { EmailOtpChallenges } from './email-otp-challenges.js';

// Stage 01 item 1.10: credentials are stored only as digests. The assertions read the database
// the way an attacker with a leaked dump would, as text of every row of every table.

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

async function everything(database: Database) {
  const tables = await database.pool.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const dump = new Map<string, string>();
  for (const { table_name } of tables.rows) {
    const rows = await database.pool.query<{ row: string }>(
      `SELECT t::text AS row FROM "${table_name}" t`,
    );
    dump.set(table_name, rows.rows.map((row) => row.row).join('\n'));
  }
  return dump;
}

test('session tokens, passwords and OTP codes never reach the database in plaintext', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests require local PostgreSQL');
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const auth = new Auth(database);
    const email = `sensitive-${randomUUID()}@example.test`;
    const password = `correct-${randomUUID()}`;
    await auth.register(email, password);
    const credentials = await auth.loginSession(email, password, undefined, 'unit test');
    assert.ok(credentials);

    // Sessions: the row key is the SHA-256 of the token, and the token itself is stored nowhere.
    const session = await database.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM sessions WHERE id = $1',
      [credentials.sessionId],
    );
    assert.equal(session.rows[0]?.token_hash, sha256(credentials.accessToken));
    const refresh = await database.pool.query<{ token_hash: string }>(
      'SELECT token_hash FROM session_refresh_tokens WHERE session_id = $1',
      [credentials.sessionId],
    );
    assert.equal(refresh.rows[0]?.token_hash, sha256(credentials.refreshToken));
    assert.notEqual(credentials.accessToken, credentials.refreshToken);

    // Passwords: an Argon2 hash, never the password.
    const user = await database.pool.query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE email = $1',
      [email],
    );
    assert.match(user.rows[0]!.password_hash, /^\$argon2id\$/);

    // One-time codes: only an HMAC digest and a hash of the address are kept.
    const secret = Buffer.alloc(32, 9);
    const challenges = new EmailOtpChallenges(database.pool);
    const challengeEmail = `otp-${randomUUID()}@example.test`;
    const challengeId = randomUUID();
    const otp = createEmailOtp(challengeId, secret);
    await challenges.replaceActive(
      { id: challengeId, email: challengeEmail, digest: otp.digest, expiresAt: otp.expiresAt },
      secret,
    );
    const stored = await database.pool.query<{ email_hash: string; digest: string }>(
      'SELECT email_hash, digest FROM email_otp_challenges WHERE id = $1',
      [challengeId],
    );
    assert.match(stored.rows[0]!.email_hash, /^[a-f0-9]{64}$/);
    assert.notEqual(stored.rows[0]!.digest, otp.code);
    assert.equal(stored.rows[0]!.digest.includes(otp.code), false);

    // The whole database, as text: no secret appears anywhere, and addresses only where documented.
    const dump = await everything(database);
    const all = [...dump.values()].join('\n');
    for (const secretValue of [
      credentials.accessToken,
      credentials.refreshToken,
      password,
      Buffer.from(secret).toString('hex'),
    ]) {
      assert.equal(all.includes(secretValue), false);
    }
    assert.equal(all.includes(` ${otp.code} `), false);
    assert.equal(dump.get('email_otp_challenges')!.includes(challengeEmail), false);
    const holders = [...dump].filter(([, text]) => text.includes(email)).map(([table]) => table);
    assert.deepEqual(holders, ['users'], 'the account address lives only in users');
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});
