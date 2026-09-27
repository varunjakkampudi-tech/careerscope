import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database, Auth, ProfileRepository, Conflict } from '@careerscope/core';
import {
  dayKey,
  isMissingTitlesConflict,
  pollUntilTerminal,
  runForOwner,
} from './run-scheduled-discovery.js';

test('dayKey is stable within a UTC calendar day and changes across days', () => {
  const a = dayKey(new Date('2026-09-23T00:00:00.000Z'));
  const b = dayKey(new Date('2026-09-23T23:59:59.999Z'));
  const c = dayKey(new Date('2026-09-24T00:00:00.000Z'));
  assert.equal(a, 'scheduled-2026-09-23');
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test('isMissingTitlesConflict recognizes only the specific expected Conflict code', () => {
  // CS-35: matches by Conflict.code now, not by comparing message strings -
  // this positive case previously did not exist at all, so the function
  // could never actually be proven to return true, only false.
  assert.equal(
    isMissingTitlesConflict(
      new Conflict('Save target roles before starting profile discovery', 'MISSING_TARGET_ROLES'),
    ),
    true,
  );
  class FakeConflict extends Error {}
  assert.equal(
    isMissingTitlesConflict(new Error('Save target roles before starting profile discovery')),
    false,
  );
  assert.equal(
    isMissingTitlesConflict(
      new FakeConflict('Save target roles before starting profile discovery'),
    ),
    false,
  );
  assert.equal(
    isMissingTitlesConflict(new Conflict('Idempotency key reused', 'IDEMPOTENCY_KEY_REUSED')),
    false,
  );
  // Same message text, wrong/default code - proves this now genuinely
  // checks the code, not the message, unlike the string comparison it
  // replaced.
  assert.equal(
    isMissingTitlesConflict(new Conflict('Save target roles before starting profile discovery')),
    false,
  );
  assert.equal(isMissingTitlesConflict('not an error at all'), false);
});

test('pollUntilTerminal returns as soon as a terminal status appears', async () => {
  const statuses = ['queued', 'running', 'completed'];
  let calls = 0;
  const result = await pollUntilTerminal(
    async () => {
      // `noUncheckedIndexedAccess` is right to object: the clamp keeps the
      // index in range, but nothing in the type says so. Failing loudly beats
      // asserting it away — if this ever returns undefined the harness is
      // broken, and that should not look like the subject under test failing.
      const index = Math.min(calls++, statuses.length - 1);
      const status = statuses[index];
      if (status === undefined) throw new Error(`no fixture status at index ${index}`);
      return status;
    },
    { deadlineMs: 10_000, intervalMs: 1, wait: async () => {} },
  );
  assert.deepEqual(result, { status: 'completed', timedOut: false });
  assert.equal(calls, 3);
});

test('pollUntilTerminal reports a timeout rather than polling forever', async () => {
  const result = await pollUntilTerminal(async () => 'running', {
    deadlineMs: 5,
    intervalMs: 1,
    wait: async () => {},
  });
  assert.deepEqual(result, { status: 'running', timedOut: true });
});

// runForOwner needs a real Postgres (createSearch/ProfileRepository both
// issue real queries) - same disposable-per-test-database pattern as the
// rest of packages/core/src/database.test.ts.
test('runForOwner: disabled, missing-titles, and a settled run are all classified correctly', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require the isolated v2 DATABASE_URL');
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname), 'Tests require local PostgreSQL');
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
    });
    const auth = new Auth(database);
    await auth.register('scheduled@example.test', randomUUID());
    // Destructuring `rows: [{ id }]` throws a TypeError when the query returns
    // nothing, so a missing precondition would surface as an unrelated crash
    // rather than as "the owner was not registered". Assert the precondition
    // instead: a test that dies before reaching its claim proves nothing.
    const { rows } = await database.pool.query<{ id: string }>('SELECT id FROM users LIMIT 1');
    const owner = rows[0];
    assert.ok(owner, 'the registered owner must exist before the scheduled run is exercised');
    const ownerId = owner.id;
    const profiles = new ProfileRepository(database);
    const alerts: string[] = [];
    const alert = async (message: string) => {
      alerts.push(message);
    };

    // 1. No profile saved at all yet - never enabled, never alerts.
    assert.equal(
      await runForOwner(database, ownerId, new Date(), alert, { deadlineMs: 10, intervalMs: 1 }),
      'disabled',
    );
    assert.equal(alerts.length, 0);

    const validProfile = {
      candidate: {
        fullName: 'Test Owner',
        email: 'scheduled@example.test',
        phone: '',
        location: 'Remote',
        linkedin: '',
        github: '',
        portfolio: '',
      },
      preferences: {
        titles: ['a'], // single-char title: schema-valid (min length 1), but
        // fails createSearch's own 2-160-char usability check - this is the
        // real, reachable shape of "missing usable titles", not an empty array.
        techStack: ['JavaScript'],
        locations: [],
        remoteOnly: false,
        minSalary: null,
        employmentTypes: ['fulltime'] as const,
        excludeKeywords: [],
        excludeCompanies: [],
      },
      application: {
        currentCtc: '',
        expectedCtc: '',
        noticePeriodDays: 0,
        willingToRelocate: true,
        yearsOfExperience: 2,
      },
    };
    await profiles.save(ownerId, { revision: 0, profile: validProfile });

    // 2. Saved profile, but discovery not yet enabled (the default) - still
    // must not run or alert.
    assert.equal(
      await runForOwner(database, ownerId, new Date(), alert, { deadlineMs: 10, intervalMs: 1 }),
      'disabled',
    );
    assert.equal(alerts.length, 0);

    await profiles.setScheduledDiscoveryEnabled(ownerId, true);

    // 3. Enabled, but the only saved title is unusable - a real, expected,
    // non-alertable skip, not a crash and not a silent success claim.
    assert.equal(
      await runForOwner(database, ownerId, new Date(), alert, { deadlineMs: 10, intervalMs: 1 }),
      'skipped-no-titles',
    );
    assert.equal(alerts.length, 0);

    // 4. A usable title: enqueue succeeds. Nothing consumes the outbox in
    // this test, so simulate the worker settling the run, then confirm the
    // poll picks up the real row via a real query, not a mock.
    await profiles.save(ownerId, {
      revision: 1,
      profile: {
        ...validProfile,
        preferences: { ...validProfile.preferences, titles: ['Backend Engineer'] },
      },
    });
    // Keyed on the exact idempotency key this call will use, and polls for
    // its existence, rather than "whatever is newest" - the latter races
    // against runForOwner's own createSearch() call once more than one row
    // can exist for this owner, and would silently mutate the wrong row.
    const settleWhenCreated = async (idempotencyKey: string, status: 'completed' | 'failed') => {
      for (;;) {
        const { rows } = await database.pool.query<{ id: string }>(
          `SELECT id FROM search_runs WHERE owner_id = $1 AND idempotency_key = $2`,
          [ownerId, idempotencyKey],
        );
        if (rows[0]) {
          await database.pool.query(`UPDATE search_runs SET status = $2 WHERE id = $1`, [
            rows[0].id,
            status,
          ]);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    const [outcome] = await Promise.all([
      runForOwner(database, ownerId, new Date('2026-09-23T00:00:00.000Z'), alert, {
        deadlineMs: 5_000,
        intervalMs: 10,
      }),
      settleWhenCreated('scheduled-2026-09-23', 'completed'),
    ]);
    assert.equal(outcome, 'completed');
    assert.equal(alerts.length, 0);
    const { rows: created } = await database.pool.query<{ request: { origin?: string } }>(
      `SELECT request FROM search_runs WHERE owner_id = $1 AND idempotency_key = $2`,
      [ownerId, 'scheduled-2026-09-23'],
    );
    assert.equal(created[0]!.request.origin, 'scheduled');

    // 5. Same calendar day, called again: createSearch's own idempotency
    // returns the existing row rather than enqueuing a second one - already
    // 'completed', so the poll resolves immediately without re-running
    // anything.
    const repeat = await runForOwner(
      database,
      ownerId,
      new Date('2026-09-23T12:00:00.000Z'),
      alert,
      {
        deadlineMs: 10,
        intervalMs: 1,
      },
    );
    assert.equal(repeat, 'completed');
    const { rows: countRows } = await database.pool.query<{ count: string }>(
      `SELECT count(*) FROM search_runs WHERE owner_id = $1`,
      [ownerId],
    );
    assert.equal(countRows[0]!.count, '1');

    // 6. A run that fails is alerted, not silently absorbed.
    const [failOutcome] = await Promise.all([
      runForOwner(database, ownerId, new Date('2026-09-24T00:00:00.000Z'), alert, {
        deadlineMs: 5_000,
        intervalMs: 10,
      }),
      settleWhenCreated('scheduled-2026-09-24', 'failed'),
    ]);
    assert.equal(failOutcome, 'alerted');
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]!, /failed/);
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.close();
  }
});
