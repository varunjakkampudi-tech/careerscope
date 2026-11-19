import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database } from './database.js';
import { MarketRepository } from './market.js';
import type { CollectedJobInput, SourceOutcome } from './jobs.js';

// Proves the evidence is written by the production search settlement path:
// sightings accumulate once per run, refreshed postings are recorded, and
// nothing is visible across owners.
test('posting evidence accumulates across searches and detects a refreshed listing', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured);
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  const root = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await root.pool.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const owner = randomUUID();
    const stranger = randomUUID();
    for (const id of [owner, stranger]) {
      await database.pool.query(
        'INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)',
        [id, `${id}@example.test`, 'synthetic-not-a-login'],
      );
    }

    const outcomesFor = (accepted: number): SourceOutcome[] => [
      { source: 'remoteok', status: 'completed', accepted, limited: false, errorCode: null },
    ];
    const job = (fingerprint: string, postedAt: string | null): CollectedJobInput => ({
      fingerprint,
      title: 'Backend Engineer',
      company: 'Acme',
      location: 'Remote',
      description: 'Synthetic integration fixture',
      source: 'remoteok',
      sourceUrl: `https://remoteok.com/jobs/${fingerprint}`,
      applyUrl: `https://remoteok.com/jobs/${fingerprint}`,
      postedAt,
      match: null,
    });
    let runSequence = 0;
    const observe = async (
      ownerId: string,
      jobs: CollectedJobInput[],
      outcomes = outcomesFor(jobs.length),
      duplicateInRun = false,
    ) => {
      runSequence += 1;
      const run = await database.createSearch(ownerId, `market-evidence-${runSequence}`, {
        query: 'Backend Engineer',
        sources: ['remoteok'],
      });
      const { rows } = await database.pool.query<{ id: string }>(
        "SELECT id FROM outbox_events WHERE command->>'aggregateId' = $1",
        [run.id],
      );
      assert.equal(rows.length, 1);
      const command = await database.command(rows[0]!.id);
      assert.ok(command);
      const fence = await database.claim(command.id);
      assert.ok(fence);
      assert.equal(await database.startSearch(command, fence), true);
      assert.equal(await database.completeCollection(command, fence, jobs, outcomes), true);
      if (duplicateInRun) {
        assert.equal(await database.completeCollection(command, fence, jobs, outcomes), false);
      }
      return run;
    };

    const market = new MarketRepository(database.pool);
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString();
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();

    // Seen in four searches over five weeks, still claiming the same old date.
    await database.pool.query(
      `INSERT INTO job_sightings
         (owner_id, fingerprint, title, company, first_posted_at, last_posted_at,
          first_seen_at, last_seen_at)
       VALUES ($1, 'long-open', 'Backend Engineer', 'Acme', $2, $2,
               now() - interval '35 days', now() - interval '35 days')`,
      [owner, ninetyDaysAgo],
    );
    // One provider may emit the same fingerprint twice in a run. It is one
    // posting sighting for that run, even though both source rows are retained
    // in the worker result before persistence de-duplication.
    await observe(
      owner,
      [job('long-open', ninetyDaysAgo), job('long-open', ninetyDaysAgo)],
      outcomesFor(2),
      true,
    );
    for (let i = 0; i < 2; i += 1) await observe(owner, [job('long-open', ninetyDaysAgo)]);

    const longOpen = await market.posting(owner, 'long-open');
    assert.ok(longOpen);
    assert.equal(longOpen.sightings, 4);
    assert.equal(longOpen.repostCount, 0);
    assert.ok(
      longOpen.daysOpen !== null && longOpen.daysOpen >= 89,
      `daysOpen=${longOpen.daysOpen}`,
    );
    assert.ok(longOpen.signals.includes('long_open'));
    assert.ok(longOpen.signals.includes('persistent'));
    assert.ok(!longOpen.signals.includes('recently_posted'));

    // The same posting returns claiming a newer date. That is a refresh of an
    // old role, and it is the signal a job board will never surface.
    await observe(owner, [job('long-open', yesterday)]);
    const refreshed = await market.posting(owner, 'long-open');
    assert.ok(refreshed);
    assert.equal(refreshed.repostCount, 1, 'a newer claimed date must count as a repost');
    assert.ok(refreshed.signals.includes('reposted'));

    // A genuinely new posting must not be tarred with the same brush.
    await observe(owner, [job('fresh', yesterday)]);
    const fresh = await market.posting(owner, 'fresh');
    assert.ok(fresh);
    assert.deepEqual(fresh.signals.sort(), ['first_sighting', 'recently_posted']);
    assert.equal(fresh.repostCount, 0);

    // A posting with no date at all must not be guessed at.
    await observe(owner, [job('undated', null)]);
    const undated = await market.posting(owner, 'undated');
    assert.ok(undated);
    assert.equal(undated.daysOpen, null, 'a missing posting date must stay null, not be invented');
    assert.ok(!undated.signals.includes('long_open'));

    // Owner isolation: the stranger's identical fingerprint is a separate row
    // and never appears in the owner's evidence.
    await observe(stranger, [job('long-open', ninetyDaysAgo)]);
    const strangerView = await market.posting(stranger, 'long-open');
    assert.equal(strangerView?.sightings, 1, "another owner's history must not be shared");
    assert.equal(await market.posting(owner, 'not-a-real-fingerprint'), null);

    const stale = await market.stalePostings(owner);
    const fingerprints = stale.map((row) => row.fingerprint);
    assert.ok(fingerprints.includes('long-open'));
    assert.ok(!fingerprints.includes('fresh'), 'a fresh single sighting is not a stale posting');

    const companies = await market.companies(owner);
    assert.equal(companies.length, 1);
    assert.equal(companies[0].company, 'Acme');
    assert.equal(companies[0].reposts, 1);

    // Bounds are not negotiable from the caller.
    assert.ok((await market.stalePostings(owner, { limit: 100000 })).length <= 200);
  } finally {
    await database.pool.end();
    // A plain drop is intentional: FORCE would terminate a leaked query and
    // turn teardown into the misleading "administrator command" failure.
    // If ownership is incomplete, PostgreSQL must fail cleanup diagnostically.
    await root.pool.query(`DROP DATABASE IF EXISTS "${name}"`);
    await root.pool.end();
  }
});

test('the pipeline distinguishes neglected work from finished work', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured);
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  const root = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await root.pool.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const owner = randomUUID();
    await database.pool.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [
      owner,
      `${owner}@example.test`,
      'synthetic-not-a-login',
    ]);

    const lead = (status: string, changedDaysAgo: number) =>
      database.pool.query(
        `INSERT INTO saved_leads (id, owner_id, fingerprint, data, status, status_changed_at)
         VALUES (gen_random_uuid(), $1, $2, $3::jsonb, $4, now() - ($5 || ' days')::interval)`,
        [
          owner,
          randomUUID(),
          JSON.stringify({ title: 'Backend Engineer', company: 'Acme' }),
          status,
          changedDaysAgo,
        ],
      );

    await lead('applied', 40); // cold
    await lead('interviewing', 30); // cold
    await lead('saved', 1); // fresh
    await lead('rejected', 90); // finished, not neglected
    await lead('archived', 90); // finished, not neglected

    const market = new MarketRepository(database.pool);
    const pipeline = await market.pipeline(owner);
    assert.equal(
      pipeline.stalledActive,
      2,
      'rejected and archived are finished work and must not be counted as stalled',
    );

    const stalled = await market.stalled(owner);
    const statuses = stalled.map((row) => row.status).sort();
    assert.deepEqual(statuses, ['applied', 'interviewing']);
    assert.ok(stalled[0].daysSinceChange >= 39);
    // Oldest neglect first: that is the one costing the most.
    assert.ok(stalled[0].daysSinceChange >= stalled[1].daysSinceChange);
    assert.equal(stalled[0].title, 'Backend Engineer');

    assert.equal((await market.stalled(owner, { days: 365 })).length, 0);
  } finally {
    await database.pool.end();
    // Keep teardown diagnostic; never hide an in-flight query with FORCE.
    await root.pool.query(`DROP DATABASE IF EXISTS "${name}"`);
    await root.pool.end();
  }
});
