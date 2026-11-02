import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database } from './database.js';
import { EmailChangeRequests } from './email-change-requests.js';

// Completing an email change ends every session and creates the replacement in one transaction
// (owner decision, Stage 01). A failure in that work must leave the old address, the old sessions
// and the pending request untouched, and a completed change must not be replayable.
test(
  'a completed email change is atomic with session revocation and replacement, and failures roll back',
  { timeout: 60_000 },
  async () => {
    const configured = process.env.DATABASE_URL;
    assert.ok(configured, 'integration test requires an isolated DATABASE_URL');
    const url = new URL(configured);
    assert.ok(['127.0.0.1', 'localhost'].includes(url.hostname));
    const admin = new Database(configured);
    const name = `test_${randomUUID().replaceAll('-', '')}`;
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    const database = new Database(url.href);
    const secret = randomBytes(32);
    try {
      await migrate(database.db, {
        migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
      });
      const ownerId = randomUUID();
      await database.pool.query(
        'INSERT INTO users (id, email, email_verified_at) VALUES ($1, $2, now())',
        [ownerId, 'old@example.test'],
      );
      await database.pool.query(
        "INSERT INTO sessions (id, token_hash, owner_id, expires_at, access_expires_at) VALUES ($1, $2, $3, now() + interval '1 day', now() + interval '1 hour')",
        [randomUUID(), randomBytes(32).toString('hex'), ownerId],
      );
      const requests = new EmailChangeRequests(database.pool);
      const pending = await requests.begin(ownerId, 'new@example.test', secret);
      assert.ok(pending);
      const verify = (
        address: 'current' | 'new',
        code: string,
        onCompleted?: () => Promise<void>,
      ) =>
        requests.verify({
          ownerId,
          address,
          code,
          secret,
          onCompleted: onCompleted ? async () => onCompleted() : undefined,
        });
      assert.equal(await verify('current', pending.currentCode), 'accepted');

      // The second verification completes the change. Its replacement step fails, so nothing commits.
      await assert.rejects(
        verify('new', pending.newCode, async () => {
          throw new Error('replacement session could not be created');
        }),
      );
      const unchanged = await database.pool.query<{ email: string }>(
        'SELECT email FROM users WHERE id = $1',
        [ownerId],
      );
      assert.equal(unchanged.rows[0]!.email, 'old@example.test', 'the address does not change');
      assert.equal(
        (
          await database.pool.query(
            'SELECT 1 FROM sessions WHERE owner_id = $1 AND revoked_at IS NULL',
            [ownerId],
          )
        ).rowCount,
        1,
        'the existing session survives a failed change',
      );
      assert.equal(
        (
          await database.pool.query('SELECT 1 FROM email_change_requests WHERE owner_id = $1', [
            ownerId,
          ])
        ).rowCount,
        1,
        'the pending request survives a failed change',
      );

      // A successful completion revokes every session and runs the replacement inside the transaction.
      let replaced = false;
      assert.equal(
        await verify('new', pending.newCode, async () => {
          replaced = true;
        }),
        'completed',
      );
      assert.equal(replaced, true);
      assert.equal(
        (
          await database.pool.query(
            'SELECT 1 FROM sessions WHERE owner_id = $1 AND revoked_at IS NULL',
            [ownerId],
          )
        ).rowCount,
        0,
        'every session is revoked by the completed change',
      );
      // Replay of the completed request's codes is refused.
      assert.equal(await verify('new', pending.newCode), 'invalid');
      assert.equal(await verify('current', pending.currentCode), 'invalid');
    } finally {
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.close();
    }
  },
);
