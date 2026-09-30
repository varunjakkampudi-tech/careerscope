import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database, LeadRepository, users } from '@careerscope/core';
import { enforceRetention } from './enforce-search-retention.ts';

test('enforceRetention rejects a nonsense window rather than silently deleting nothing or everything', async () => {
  await assert.rejects(enforceRetention({} as Database, 0), /Invalid retention window/);
  await assert.rejects(enforceRetention({} as Database, -5), /Invalid retention window/);
  await assert.rejects(enforceRetention({} as Database, Number.NaN), /Invalid retention window/);
});

test('enforceRetention deletes only old, settled runs and their jobs - never leads, never in-flight work', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured, 'Integration tests require the isolated CareerScope DATABASE_URL');
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

    const makeRun = async (status: string, ageDays: number) => {
      const id = randomUUID();
      await database.pool.query(
        `INSERT INTO search_runs (id, owner_id, request, request_hash, idempotency_key, status, created_at)
         VALUES ($1, $2, '{}'::jsonb, $3, $3, $4, now() - ($5 || ' days')::interval)`,
        [id, ownerId, `key-${id}`, status, ageDays],
      );
      await database.pool.query(
        `INSERT INTO search_jobs (id, run_id, owner_id, fingerprint, data)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          randomUUID(),
          id,
          ownerId,
          `fp-${id}`,
          JSON.stringify({
            fingerprint: `fp-${id}`,
            title: 'Engineer',
            company: 'Example',
            location: 'Remote',
            isRemote: true,
            description: 'x',
            hasFullDescription: true,
            source: 'himalayas',
            sourceUrl: 'https://himalayas.app/jobs/' + id,
            applyUrl: 'https://example.test/apply/' + id,
            postedAt: null,
            sourceLinks: [],
          }),
        ],
      );
      await database.pool.query(
        `INSERT INTO run_events (id, sequence, run_id, owner_id, type) VALUES ($1, DEFAULT, $2, $3, 'SearchCompleted')`,
        [randomUUID(), id, ownerId],
      );
      return id;
    };

    const oldSettled = await makeRun('completed', 45);
    const oldStillRunning = await makeRun('running', 45);
    const recentSettled = await makeRun('completed', 2);

    // The old-but-still-running run must be protected even though it is old
    // enough by date alone - retention must never race active processing.
    // Simulate its command still being unpublished/running in the outbox.
    await database.pool.query(
      `INSERT INTO outbox_events (id, command, created_at)
       VALUES ($1, $2::jsonb, now())`,
      [
        randomUUID(),
        JSON.stringify({
          id: randomUUID(),
          type: 'search.collect',
          version: 1,
          aggregateId: oldStillRunning,
          ownerId,
          occurredAt: new Date().toISOString(),
          correlationId: randomUUID(),
        }),
      ],
    );

    // A saved lead from the old settled run must survive - it is its own
    // independent snapshot, not a foreign-keyed view of search_jobs.
    const { rows: oldJobRows } = await database.pool.query<{ id: string }>(
      'SELECT id FROM search_jobs WHERE run_id = $1',
      [oldSettled],
    );
    const leads = new LeadRepository(database);
    const savedLead = await leads.save(ownerId, { jobId: oldJobRows[0]!.id });
    assert.ok(savedLead);

    const result = await enforceRetention(database, 30);
    assert.equal(result.deletedJobs, 1); // only oldSettled's job
    assert.equal(result.deletedRuns, 1); // only oldSettled itself

    const remainingRuns = (
      await database.pool.query<{ id: string }>('SELECT id FROM search_runs ORDER BY id')
    ).rows.map((row) => row.id);
    assert.deepEqual(remainingRuns.sort(), [oldStillRunning, recentSettled].sort());

    const remainingJobs = (
      await database.pool.query<{ run_id: string }>('SELECT run_id FROM search_jobs')
    ).rows.map((row) => row.run_id);
    assert.deepEqual(remainingJobs.sort(), [oldStillRunning, recentSettled].sort());

    // The lead born from the deleted run's job is completely unaffected.
    const stillSaved = await leads.get(ownerId, savedLead!.id);
    assert.ok(stillSaved);
    assert.equal(stillSaved!.data.fingerprint, savedLead!.data.fingerprint);
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.close();
  }
});
