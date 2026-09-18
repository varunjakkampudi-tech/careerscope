import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  Auth,
  Database,
  LeadRepository,
  ProfileRepository,
  passwordHash,
  users,
} from '@careerscope/core';
import { createApp } from '../apps/api/src/app.js';

/**
 * Establishes measured latency for the authenticated read paths a user waits on.
 * It records percentiles rather than asserting an invented target, and fails only
 * on limits that would be user-visible regressions.
 */
const configured = process.env.DATABASE_URL;
assert.ok(configured);
const url = new URL(configured);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
const admin = new Database(configured);
const name = `perf_${randomUUID().replaceAll('-', '')}`;
await admin.pool.query(`CREATE DATABASE "${name}"`);
url.pathname = `/${name}`;
const database = new Database(url.href);
const origin = 'http://localhost:5280';
const ownerId = randomUUID();
const password = randomUUID();
const app = await createApp(database, origin, async () => true);

const percentile = (values: number[], fraction: number) =>
  values.slice().sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor(values.length * fraction))
  ]!;

try {
  await migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
  });
  await database.db.insert(users).values({
    id: ownerId,
    email: `${ownerId}@example.test`,
    passwordHash: await passwordHash(password),
  });
  const token = await new Auth(database).login(`${ownerId}@example.test`, password);
  assert.ok(token);
  const cookies = { careerscope_v2_session: token };

  await new ProfileRepository(database).save(ownerId, {
    revision: 0,
    profile: {
      candidate: { fullName: 'Perf Candidate', email: 'perf@example.test', location: 'Remote' },
      preferences: { titles: ['React Engineer'], techStack: ['React', 'TypeScript'] },
      application: { yearsOfExperience: 4 },
    },
  });

  // A realistic amount of history so reads are not measured against an empty table.
  const leads = new LeadRepository(database);
  for (let index = 0; index < 40; index += 1) {
    const search = await database.createSearch(ownerId, `perf-${index}-${randomUUID()}`, {
      query: 'React',
      sources: ['remoteok'],
    });
    const outbox = await database.pool.query<{ id: string }>(
      "SELECT id FROM outbox_events WHERE command->>'aggregateId' = $1",
      [search.id],
    );
    const command = (await database.command(outbox.rows[0]!.id))!;
    const fence = await database.claim(command.id);
    await database.completeCollection(
      command,
      fence!,
      [
        {
          fingerprint: `perf-${index}`,
          title: 'React engineer',
          company: 'Synthetic Systems',
          location: 'Remote',
          description: 'Deterministic performance fixture',
          source: 'remoteok' as const,
          sourceUrl: 'https://remoteok.com/remote-jobs/perf',
          applyUrl: 'https://example.test/apply',
          postedAt: null,
        },
      ],
      [
        {
          source: 'remoteok' as const,
          status: 'completed' as const,
          accepted: 1,
          limited: false,
          errorCode: null,
        },
      ],
    );
    const job = await database.pool.query<{ id: string }>(
      'SELECT id FROM search_jobs WHERE run_id = $1',
      [search.id],
    );
    await leads.save(ownerId, { jobId: job.rows[0]!.id });
  }

  const routes = {
    'GET /api/searches': '/api/searches',
    'GET /api/leads': '/api/leads',
    'GET /api/profile': '/api/profile',
    'GET /api/preparation': '/api/preparation',
  };
  const report: Record<string, { p50: number; p95: number; max: number; samples: number }> = {};
  for (const [label, path] of Object.entries(routes)) {
    const timings: number[] = [];
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const started = performance.now();
      const response = await app.inject({ url: path, cookies });
      assert.equal(response.statusCode, 200, `${label} returned ${response.statusCode}`);
      timings.push(performance.now() - started);
    }
    report[label] = {
      p50: Number(percentile(timings, 0.5).toFixed(2)),
      p95: Number(percentile(timings, 0.95).toFixed(2)),
      max: Number(Math.max(...timings).toFixed(2)),
      samples: timings.length,
    };
  }

  // Deliberately loose: this guards against an order-of-magnitude regression on a
  // developer machine, not a production service-level objective.
  for (const [label, measured] of Object.entries(report)) {
    assert.ok(measured.p95 < 750, `${label} p95 ${measured.p95}ms exceeds the regression ceiling`);
  }

  // Sustained concurrent load against a declared workload and thresholds, rather
  // than single-request timings. Eight concurrent readers is well above the
  // single-owner design point, so it is a deliberate safety margin.
  const concurrency = 8;
  const durationMs = Number(process.env.PERF_DURATION_MS ?? 30_000);
  const paths = Object.values(routes);
  const latencies: number[] = [];
  const deadline = Date.now() + durationMs;
  let requests = 0;
  let failures = 0;
  const baselineRss = process.memoryUsage().rss;
  const client = async (slot: number) => {
    for (let index = 0; Date.now() < deadline; index += 1) {
      const path = paths[(slot + index) % paths.length]!;
      const started = performance.now();
      try {
        const response = await app.inject({ url: path, cookies });
        if (response.statusCode !== 200) failures += 1;
      } catch {
        failures += 1;
      }
      latencies.push(performance.now() - started);
      requests += 1;
    }
  };
  await Promise.all(Array.from({ length: concurrency }, (_, slot) => client(slot)));
  const peakRss = process.memoryUsage().rss;
  const sustained = {
    concurrency,
    durationMs,
    requests,
    failures,
    throughputPerSecond: Number((requests / (durationMs / 1000)).toFixed(1)),
    p50: Number(percentile(latencies, 0.5).toFixed(2)),
    p95: Number(percentile(latencies, 0.95).toFixed(2)),
    p99: Number(percentile(latencies, 0.99).toFixed(2)),
    baselineRss,
    peakRss,
  };

  // Declared acceptance for this workload on a single host.
  assert.equal(sustained.failures, 0, 'Sustained load produced failed responses');
  assert.ok(sustained.p95 < 500, `Sustained p95 ${sustained.p95}ms exceeds 500ms`);
  assert.ok(sustained.p99 < 1000, `Sustained p99 ${sustained.p99}ms exceeds 1000ms`);
  assert.ok(
    peakRss < baselineRss * 1.5 + 128 * 1024 * 1024,
    `Resident memory grew from ${baselineRss} to ${peakRss} under sustained load`,
  );

  process.stdout.write(`${JSON.stringify({ singleRequest: report, sustained }, null, 2)}\n`);
} finally {
  await app.close();
  await database.close();
  await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.close();
}
