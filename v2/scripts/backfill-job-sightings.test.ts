import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { users, type SourceOutcome } from '@careerscope/core';
// Deliberately the SAME specifier backfill-job-sightings.ts itself uses, not
// '@careerscope/core'. That script is one of only two files in v2/scripts that
// import Database from source rather than from the package, so importing the
// package's Database here would hand `rebuildJobSightings` a different class
// than the one its own parameter type names — two Database declarations in one
// process, which type-checks as an error and duck-types silently at runtime.
// Aligning the test with its subject is the minimal correct fix; the
// inconsistency in the script itself is recorded separately, because changing
// it would make `db:backfill-job-sightings` depend on a built dist that it does
// not currently need.
import { Database } from '../packages/core/src/database.js';
import { replay, rebuildJobSightings } from './backfill-job-sightings.js';

const owner = 'owner-1';

test('replay accumulates sightings and repost_count in run order, matching the live upsert', () => {
  const result = replay([
    {
      ownerId: owner,
      fingerprint: 'fp-1',
      title: 'Backend Engineer',
      company: 'Acme',
      postedAt: '2026-01-01T00:00:00.000Z',
      runId: 'run-1',
      runCreatedAt: '2026-01-05T00:00:00.000Z',
    },
    {
      ownerId: owner,
      fingerprint: 'fp-1',
      title: 'Backend Engineer',
      company: 'Acme',
      // A later run claiming an *earlier* date is not a repost.
      postedAt: '2025-12-01T00:00:00.000Z',
      runId: 'run-2',
      runCreatedAt: '2026-01-12T00:00:00.000Z',
    },
    {
      ownerId: owner,
      fingerprint: 'fp-1',
      title: 'Backend Engineer',
      company: 'Acme',
      // A later run claiming a *newer* date is a repost.
      postedAt: '2026-01-20T00:00:00.000Z',
      runId: 'run-3',
      runCreatedAt: '2026-01-19T00:00:00.000Z',
    },
  ]);

  const row = result.get(`${owner}:fp-1`);
  assert.ok(row);
  assert.equal(row.sightings, 3);
  assert.equal(row.repostCount, 1);
  assert.equal(row.firstSeenAt, '2026-01-05T00:00:00.000Z');
  assert.equal(row.lastSeenAt, '2026-01-19T00:00:00.000Z');
  assert.equal(row.firstPostedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(row.lastPostedAt, '2026-01-20T00:00:00.000Z');
  assert.equal(row.lastRunId, 'run-3');
});

test('a run with a null postedAt keeps the previous claimed date rather than clearing it', () => {
  const result = replay([
    {
      ownerId: owner,
      fingerprint: 'fp-2',
      title: 'Frontend Engineer',
      company: 'Globex',
      postedAt: '2026-01-01T00:00:00.000Z',
      runId: 'run-1',
      runCreatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      ownerId: owner,
      fingerprint: 'fp-2',
      title: 'Frontend Engineer',
      company: 'Globex',
      postedAt: null,
      runId: 'run-2',
      runCreatedAt: '2026-01-08T00:00:00.000Z',
    },
  ]);

  const row = result.get(`${owner}:fp-2`);
  assert.ok(row);
  assert.equal(row.lastPostedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(row.repostCount, 0);
});

// Independent Reviewer finding CS28-6: the mirror-image direction (non-null
// then null) was covered above, but not this one - a first sighting with no
// claimed date at all, followed by a real one.
test('a first sighting with no claimed date at all never counts a later real date as a repost', () => {
  const result = replay([
    {
      ownerId: owner,
      fingerprint: 'fp-2b',
      title: 'Frontend Engineer',
      company: 'Globex',
      postedAt: null,
      runId: 'run-1',
      runCreatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      ownerId: owner,
      fingerprint: 'fp-2b',
      title: 'Frontend Engineer',
      company: 'Globex',
      postedAt: '2026-01-10T00:00:00.000Z',
      runId: 'run-2',
      runCreatedAt: '2026-01-08T00:00:00.000Z',
    },
  ]);

  const row = result.get(`${owner}:fp-2b`);
  assert.ok(row);
  // first_posted_at is never touched after the first insert, even when that
  // first insert had nothing to record - matches Database.settle()'s own
  // ON CONFLICT DO UPDATE, which never lists first_posted_at.
  assert.equal(row.firstPostedAt, null);
  assert.equal(row.lastPostedAt, '2026-01-10T00:00:00.000Z');
  // There was no previous claimed date to compare against, so this cannot be
  // "the same role refreshed" - a repost needs a prior date to be later than.
  assert.equal(row.repostCount, 0);
});

test('keeps a genuinely split posting as its own row, not folded into its sibling', () => {
  // CS-28: after the identity fix, two distinct reqs from one source carry
  // different (disambiguated) fingerprints, so a replay of search_jobs must
  // never merge them back together just because they share an owner.
  const result = replay([
    {
      ownerId: owner,
      fingerprint: 'fp-split-a',
      title: 'Senior Backend Engineer',
      company: 'Acme',
      postedAt: null,
      runId: 'run-1',
      runCreatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      ownerId: owner,
      fingerprint: 'fp-split-b',
      title: 'Senior Backend Engineer',
      company: 'Acme',
      postedAt: null,
      runId: 'run-1',
      runCreatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);

  assert.equal(result.size, 2);
  assert.equal(result.get(`${owner}:fp-split-a`)?.sightings, 1);
  assert.equal(result.get(`${owner}:fp-split-b`)?.sightings, 1);
});

test('scopes sightings per owner even when two owners share a fingerprint', () => {
  const result = replay([
    {
      ownerId: 'owner-a',
      fingerprint: 'shared',
      title: 'Backend Engineer',
      company: 'Acme',
      postedAt: null,
      runId: 'run-1',
      runCreatedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      ownerId: 'owner-b',
      fingerprint: 'shared',
      title: 'Backend Engineer',
      company: 'Acme',
      postedAt: null,
      runId: 'run-2',
      runCreatedAt: '2026-01-01T00:00:00.000Z',
    },
  ]);

  assert.equal(result.size, 2);
  assert.equal(result.get('owner-a:shared')?.sightings, 1);
  assert.equal(result.get('owner-b:shared')?.sightings, 1);
});

test('returns an empty map for no history', () => {
  assert.equal(replay([]).size, 0);
});

// CS-28: rebuildJobSightings must re-derive job_sightings from search_jobs,
// not trust whatever job_sightings currently holds — proving the "market
// evidence" recompute the ticket calls for is real, not a no-op.
test('rebuildJobSightings replaces drifted job_sightings state with a fresh replay of search_jobs', async () => {
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
    const ownerId = randomUUID();
    await database.db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.test`,
      passwordHash: 'synthetic-not-a-login',
    });
    // `origin` is required by the real createSearch contract. The fixture omitted
    // it and nothing noticed, because no v2 test file was type-checked — the same
    // class of defect as the ai-provider fixture that was missing seven fields.
    const request = {
      query: 'React',
      origin: 'manual' as const,
      sources: ['remoteok'] as ['remoteok'],
    };
    const outcomeFor = (accepted: number): SourceOutcome => ({
      source: 'remoteok',
      status: 'completed',
      accepted,
      limited: false,
      errorCode: null,
    });
    // Two genuinely different reqs, same title/company/city, as CS-28's
    // dedup fix now assigns them distinct (disambiguated) fingerprints.
    const reqOne = {
      fingerprint: 'split-a',
      sourceJobId: 'req-1',
      title: 'Senior Backend Engineer',
      company: 'Acme',
      location: 'Bangalore',
      description: 'Owns the payments platform.',
      source: 'remoteok' as const,
      sourceUrl: 'https://remoteok.com/remote-jobs/req-1',
      applyUrl: 'https://example.test/apply',
      postedAt: null,
    };
    const reqTwo = {
      ...reqOne,
      fingerprint: 'split-b',
      sourceJobId: 'req-2',
      description: 'Owns the fraud-detection platform.',
      sourceUrl: 'https://remoteok.com/remote-jobs/req-2',
    };
    const runOnce = async (key: string, jobs: (typeof reqOne)[]) => {
      const search = await database.createSearch(ownerId, key, request);
      const command = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === search.id,
      )!.command;
      const fence = await database.claim(command.id);
      await database.completeCollection(command, fence!, jobs, [outcomeFor(jobs.length)]);
    };
    // Run 1 sees both reqs; run 2 only sees req-1 still open (req-2 has
    // since closed) - split-a should end up with 2 sightings, split-b 1.
    await runOnce('run-1', [reqOne, reqTwo]);
    await runOnce('run-2', [reqOne]);

    const correct = (
      await database.pool.query<{ fingerprint: string; sightings: number }>(
        'SELECT fingerprint, sightings FROM job_sightings WHERE owner_id = $1 ORDER BY fingerprint',
        [ownerId],
      )
    ).rows;
    assert.deepEqual(correct, [
      { fingerprint: 'split-a', sightings: 2 },
      { fingerprint: 'split-b', sightings: 1 },
    ]);

    // Simulate drift: corrupt job_sightings directly, as if the old
    // incremental upsert (or a pre-fix false merge) had left stale state
    // that no longer matches search_jobs.
    await database.pool.query(
      `UPDATE job_sightings SET sightings = 99, repost_count = 7
         WHERE owner_id = $1 AND fingerprint = 'split-a'`,
      [ownerId],
    );
    await database.pool.query(
      `INSERT INTO job_sightings (owner_id, fingerprint, title, company, sightings)
         VALUES ($1, 'phantom-row-with-no-search-jobs-history', 'Ghost', 'Nobody', 40)`,
      [ownerId],
    );
    const drifted = (
      await database.pool.query<{ fingerprint: string }>(
        'SELECT fingerprint FROM job_sightings WHERE owner_id = $1 ORDER BY fingerprint',
        [ownerId],
      )
    ).rows;
    assert.equal(drifted.length, 3, 'drift must actually be present before the rebuild');

    const summary = await rebuildJobSightings(database);
    assert.equal(summary.before, 3);
    assert.equal(summary.rebuiltRows, 2);
    assert.equal(summary.historicalPostings, 3);

    const rebuilt = (
      await database.pool.query<{ fingerprint: string; sightings: number }>(
        'SELECT fingerprint, sightings FROM job_sightings WHERE owner_id = $1 ORDER BY fingerprint',
        [ownerId],
      )
    ).rows;
    // The drift is gone and the two real postings are back to what
    // search_jobs actually recorded - the phantom row did not survive, and
    // split-a's corrupted counters were replaced, not merely reduced.
    assert.deepEqual(rebuilt, [
      { fingerprint: 'split-a', sightings: 2 },
      { fingerprint: 'split-b', sightings: 1 },
    ]);

    // Idempotent: running it again against unchanged search_jobs history
    // reproduces the exact same result.
    const again = await rebuildJobSightings(database);
    assert.equal(again.rebuiltRows, 2);
    const rebuiltAgain = (
      await database.pool.query<{ fingerprint: string; sightings: number }>(
        'SELECT fingerprint, sightings FROM job_sightings WHERE owner_id = $1 ORDER BY fingerprint',
        [ownerId],
      )
    ).rows;
    assert.deepEqual(rebuiltAgain, rebuilt);
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});
