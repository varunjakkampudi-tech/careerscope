/**
 * Mixed-load soak for the single-host target. Proves stability, consistency,
 * cleanup and bounded resource behaviour under sustained concurrent use. It is
 * not a throughput benchmark and defines no latency objective.
 *
 * Deterministic local fixtures only: no live provider, owner data or network
 * acquisition takes part. Discovery is published by the real outbox publisher
 * through a disposable queue and consumed by the real dispatch path, so an
 * outbox or publisher defect cannot be hidden by the harness.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  Database,
  LeadRepository,
  LocalQueue,
  PrivateFileResumeStorage,
  ProfileRepository,
  ResumeStorageLimit,
  ResumeUploadCancelled,
  consumeMessage,
  publishPending,
  writableProfileSchema,
} from '@careerscope/core';
import type { ResumeObject } from '@careerscope/core';

const argument = (name: string) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.split('=')[1];
const durationMs = Number(argument('duration') ?? process.env.SOAK_DURATION_MS ?? 1800000);
const burstIntervalMs = Number(argument('burst') ?? process.env.SOAK_BURST_INTERVAL_MS ?? 300000);
const warmUpMs = Math.min(Number(argument('warmup') ?? 120000), Math.floor(durationMs / 3));
const baselineWindowMs = Math.min(45000, Math.max(Math.floor(durationMs / 6), 5000));
const restartAtMs = Math.floor(durationMs / 2);

const configured = process.env.DATABASE_URL;
assert.ok(configured);
const base = new URL(configured);
assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
const endpoint = process.env.LOCAL_AWS_ENDPOINT;
assert.ok(endpoint);
const admin = new Database(configured);
const name = `soak_${randomUUID().replaceAll('-', '')}`;
await admin.pool.query(`CREATE DATABASE "${name}"`);
base.pathname = `/${name}`;
const database = new Database(base.href);
const directory = await mkdtemp(join(tmpdir(), 'careerscope-soak-'));
const storage = new PrivateFileResumeStorage({
  directory,
  encryptionKey: randomBytes(32).toString('hex'),
});
const queueName = `soak-${randomUUID()}`;
const queue = new LocalQueue(endpoint);

const failures: string[] = [];
const operations = { started: 0, completed: 0, failed: 0 };
const counts = {
  uploads: 0,
  reads: 0,
  deletes: 0,
  cancellations: 0,
  cancellationRaces: 0,
  searches: 0,
  leadWrites: 0,
  profileReads: 0,
  capacityRefusals: 0,
  published: 0,
  consumed: 0,
  restarts: 0,
};
type Sample = {
  at: number;
  rss: number;
  temporaries: number;
  freeBytes: number;
  unpublished: number;
  running: number;
  expiredLeases: number;
  queueReady: number;
  queueInFlight: number;
  deadLetter: number;
};
const samples: Sample[] = [];
const rejections: unknown[] = [];
const onRejection = (reason: unknown) => rejections.push(reason);
const onException = (error: unknown) => rejections.push(error);
process.on('unhandledRejection', onRejection);
process.on('uncaughtException', onException);
const started = Date.now();
const progress = (stage: string) =>
  console.error(`[soak ${((Date.now() - started) / 1000).toFixed(0)}s] ${stage}`);

try {
  await migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
  });
  await storage.initialize();
  await queue.initialize(queueName);
  const ownerId = randomUUID();
  await database.pool.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [
    ownerId,
    `${ownerId}@example.test`,
    'synthetic-not-a-login',
  ]);
  const profiles = new ProfileRepository(database);
  const leads = new LeadRepository(database);
  const unrelated = join(directory, 'operator-note.txt');
  await writeFile(unrelated, 'must survive the soak');
  await profiles.save(ownerId, {
    revision: 0,
    profile: writableProfileSchema.parse({
      candidate: { fullName: 'Soak Candidate', email: 'soak@example.test', location: 'Remote' },
      preferences: { titles: ['React Engineer'], techStack: ['React', 'TypeScript'] },
      application: {},
    }),
  });

  const deadline = started + durationMs;
  const track = async (work: () => Promise<void>) => {
    operations.started += 1;
    try {
      await work();
      operations.completed += 1;
    } catch (error) {
      operations.failed += 1;
      failures.push(`operation: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const body = (size: number) => {
    const data = randomBytes(size);
    return {
      data,
      object: {
        ownerId,
        resumeId: randomUUID(),
        sha256: createHash('sha256').update(data).digest('hex'),
        bytes: data.length,
        contentType: 'application/pdf',
      } satisfies ResumeObject,
    };
  };

  const uploadReadDelete = () =>
    track(async () => {
      const { data, object } = body(1024 * 1024 + Math.floor(Math.random() * 4 * 1024 * 1024));
      let version: string;
      try {
        version = await storage.put(object, data);
      } catch (error) {
        if (error instanceof ResumeStorageLimit) {
          counts.capacityRefusals += 1;
          return;
        }
        throw error;
      }
      counts.uploads += 1;
      const stored = await storage.get(object, version);
      counts.reads += 1;
      if (Buffer.compare(Buffer.from(stored), data) !== 0)
        failures.push('stored object did not match the written bytes');
      if ((await storage.recoverVersion(object)) !== version)
        failures.push('published object could not be recovered');
      await storage.delete(object, version);
      counts.deletes += 1;
    });

  const uploadThenCancel = (concurrent: number) =>
    track(async () => {
      const { data, object } = body(512 * 1024);
      try {
        await storage.put(object, data);
        counts.uploads += 1;
      } catch (error) {
        if (!(error instanceof ResumeStorageLimit)) throw error;
        counts.capacityRefusals += 1;
      }
      const results = await Promise.allSettled(
        Array.from({ length: concurrent }, () => storage.cancelUpload(object)),
      );
      for (const result of results) {
        if (result.status === 'rejected')
          failures.push(
            `cancellation rejected: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
          );
      }
      counts.cancellations += concurrent;
      if (concurrent > 1) counts.cancellationRaces += 1;
      await storage
        .recoverVersion(object)
        .then(() => failures.push('cancelled object became readable'))
        .catch((error: unknown) => {
          if (!(error instanceof ResumeUploadCancelled))
            failures.push('cancelled object did not report cancellation');
        });
    });

  const discovery = () =>
    track(async () => {
      await database.createSearch(ownerId, randomUUID(), {
        query: 'React',
        sources: ['remoteok'],
      });
      counts.searches += 1;
    });

  const leadWork = (jobId: string) =>
    track(async () => {
      const lead = await leads.save(ownerId, { jobId });
      if (!lead) {
        failures.push('saving a collected job returned no lead');
        return;
      }
      const archived = await leads.update(ownerId, lead.id, {
        revision: lead.revision,
        notes: `soak ${new Date().toISOString()}`,
        status: 'archived',
      });
      if (archived?.revision !== lead.revision + 1) {
        failures.push('lead revision did not advance');
        return;
      }
      const reopened = await leads.update(ownerId, lead.id, {
        revision: archived.revision,
        notes: archived.notes,
        status: 'saved',
      });
      if (reopened?.status !== 'saved') failures.push('archived lead did not reopen');
      counts.leadWrites += 3;
      await profiles.get(ownerId);
      counts.profileReads += 1;
    });

  // The real publisher and dispatch paths, as separate loops mirroring the
  // separate production processes, restartable together during the run.
  const runPublisher = async (signal: AbortSignal) => {
    while (!signal.aborted) {
      try {
        counts.published += await publishPending(database, { 'search.collect': queue });
      } catch (error) {
        if (signal.aborted) break;
        failures.push(`publisher: ${error instanceof Error ? error.message : String(error)}`);
      }
      await delay(200, undefined, { signal }).catch(() => {});
    }
  };
  const runWorker = async (signal: AbortSignal) => {
    while (!signal.aborted) {
      try {
        const message = await queue.receive(signal, 1);
        if (!message) continue;
        await consumeMessage(
          database,
          queue,
          message,
          'search.collect',
          async (command, fence) => {
            await database.completeCollection(
              command,
              fence,
              [
                {
                  fingerprint: `soak-${command.aggregateId}`,
                  title: 'React engineer',
                  company: 'Synthetic Systems',
                  location: 'Remote',
                  description: 'Deterministic soak fixture',
                  source: 'remoteok' as const,
                  sourceUrl: 'https://remoteok.com/remote-jobs/soak',
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
            counts.consumed += 1;
            return true;
          },
          signal,
        );
      } catch (error) {
        if (signal.aborted) break;
        failures.push(`worker: ${error instanceof Error ? error.message : String(error)}`);
        await delay(200).catch(() => {});
      }
    }
  };
  const startPipeline = (signal: AbortSignal) =>
    Promise.all([runPublisher(signal), ...Array.from({ length: 4 }, () => runWorker(signal))]);

  let pipelineControl = new AbortController();
  let pipeline = startPipeline(pipelineControl.signal);
  progress('workload started');

  const actor = async (work: () => Promise<void>, pace = 50) => {
    while (Date.now() < deadline && !failures.length) {
      await work();
      await delay(pace);
    }
  };
  const settledJob = async () => {
    const { rows } = await database.pool.query<{ id: string }>(
      `SELECT j.id FROM search_jobs j
         JOIN search_runs r ON r.id = j.run_id
        WHERE r.owner_id = $1 AND r.status = 'completed'
        ORDER BY random() LIMIT 1`,
      [ownerId],
    );
    if (rows[0]) await leadWork(rows[0].id);
  };

  let nextBurst = started + burstIntervalMs;
  let restarted = false;
  const sampler = (async () => {
    while (Date.now() < deadline && !failures.length) {
      const inventory = await storage.inventory().catch(() => null);
      const backlog = await database.backlog().catch(() => null);
      const depth = await queue.depth().catch(() => null);
      if (inventory && backlog && depth) {
        samples.push({
          at: Date.now() - started,
          rss: process.memoryUsage().rss,
          temporaries: inventory.temporaries,
          freeBytes: inventory.freeBytes,
          unpublished: backlog.unpublished,
          running: backlog.running,
          expiredLeases: backlog.expiredLeases,
          queueReady: depth.ready,
          queueInFlight: depth.inFlight,
          deadLetter: depth.deadLetter,
        });
        progress(
          `uploads=${counts.uploads} searches=${counts.searches} consumed=${counts.consumed} cancels=${counts.cancellations} unpublished=${backlog.unpublished} queue=${depth.ready}/${depth.inFlight} dlq=${depth.deadLetter} temporaries=${inventory.temporaries}`,
        );
        if (inventory.belowReserve) failures.push('volume fell below the reserved headroom');
        if (depth.deadLetter > 0) failures.push('durable work reached the dead-letter queue');
      }
      if (!restarted && Date.now() - started >= restartAtMs) {
        restarted = true;
        progress('restarting publisher and worker under load');
        pipelineControl.abort();
        await pipeline;
        await delay(1000);
        pipelineControl = new AbortController();
        pipeline = startPipeline(pipelineControl.signal);
        counts.restarts += 1;
        progress('pipeline restarted');
      }
      if (Date.now() >= nextBurst) {
        nextBurst += burstIntervalMs;
        progress('burst started');
        await Promise.all([
          uploadThenCancel(8),
          ...Array.from({ length: 6 }, () => discovery()),
          ...Array.from({ length: 3 }, () => settledJob()),
        ]);
        progress('burst finished');
      }
      await delay(5000);
    }
    progress('sampler finished');
  })();

  await Promise.all([
    actor(uploadReadDelete),
    actor(() => uploadThenCancel(1)),
    actor(() => uploadThenCancel(4)),
    actor(discovery, 250),
    actor(settledJob, 250),
    sampler,
  ]);
  progress('actors finished');

  // Let the real pipeline drain rather than only stopping production.
  const drainDeadline = Date.now() + 30000;
  let drained = await database.backlog();
  let queued = await queue.depth();
  while (
    Date.now() < drainDeadline &&
    (drained.unpublished > 0 ||
      drained.running > 0 ||
      drained.expiredLeases > 0 ||
      queued.ready > 0 ||
      queued.inFlight > 0)
  ) {
    await delay(1000);
    drained = await database.backlog();
    queued = await queue.depth();
  }
  pipelineControl.abort();
  await pipeline;
  progress('pipeline stopped');

  const finalInventory = await storage.inventory();
  const finalRss = process.memoryUsage().rss;
  const warmSamples = samples.filter(
    (sample) => sample.at >= warmUpMs && sample.at < warmUpMs + baselineWindowMs,
  );
  const ordered = [...warmSamples].sort((left, right) => left.rss - right.rss);
  const warmMedianRss = ordered[Math.floor(ordered.length / 2)]?.rss ?? samples[0]?.rss ?? finalRss;
  const peakRss = samples
    .filter((sample) => sample.at >= warmUpMs)
    .reduce((peak, sample) => Math.max(peak, sample.rss), finalRss);
  const settled = await database.pool.query<{ total: string; completed: string; jobs: string }>(
    `SELECT count(*) AS total,
            count(*) FILTER (WHERE r.status = 'completed') AS completed,
            count(*) FILTER (WHERE j.collected = 1) AS jobs
       FROM search_runs r
       LEFT JOIN LATERAL (
         SELECT count(*) AS collected FROM search_jobs s WHERE s.run_id = r.id
       ) j ON true`,
  );
  const orphans = await database.pool.query<{ orphaned: string }>(
    `SELECT count(*) AS orphaned FROM command_executions e
      WHERE NOT EXISTS (SELECT 1 FROM outbox_events o WHERE o.id = e.id)`,
  );
  const report = {
    durationMs: Date.now() - started,
    counts,
    operations,
    finalBacklog: drained,
    finalQueue: queued,
    finalInventory,
    warmMedianRss,
    peakRss,
    finalRss,
    samples: samples.length,
    searchRuns: settled.rows[0],
    orphanedExecutions: orphans.rows[0]?.orphaned,
  };
  console.error(JSON.stringify(report, null, 2));
  await writeFile(
    fileURLToPath(new URL('../test-results/soak-report.json', import.meta.url)),
    JSON.stringify({ ...report, samples }, null, 2),
  );

  assert.deepEqual(failures, [], 'the soak recorded application failures');
  assert.deepEqual(rejections, [], 'unhandled rejections or uncaught exceptions occurred');
  assert.equal(operations.failed, 0);
  assert.equal(operations.started, operations.completed + operations.failed);
  assert.equal(drained.unpublished, 0, 'the outbox must drain');
  assert.equal(drained.running, 0, 'no execution may remain leased');
  assert.equal(drained.expiredLeases, 0, 'no durable work may remain stuck');
  assert.equal(queued.ready + queued.inFlight, 0, 'the queue must drain');
  assert.equal(queued.deadLetter, 0, 'no command may be dead-lettered');
  assert.equal(Number(orphans.rows[0]?.orphaned ?? -1), 0, 'no orphaned execution records');
  assert.equal(
    settled.rows[0]?.completed,
    settled.rows[0]?.total,
    'every search must reach a terminal collected state',
  );
  assert.equal(
    settled.rows[0]?.jobs,
    settled.rows[0]?.total,
    'every completed search must hold its collected job',
  );
  assert.equal(counts.searches, Number(settled.rows[0]?.total ?? -1));
  assert.equal(finalInventory.temporaries, 0, 'completed operations must leave no temporaries');
  assert.equal(finalInventory.belowReserve, false);
  assert.equal(counts.restarts, 1, 'the pipeline must be restarted once under load');
  assert.ok(counts.uploads > 0 && counts.consumed > 0 && counts.cancellationRaces > 0);
  assert.ok(
    peakRss <= warmMedianRss * 1.25 + 64 * 1024 * 1024,
    `resident memory grew beyond the bound: warm ${warmMedianRss} peak ${peakRss}`,
  );
  progress('soak passed');
} finally {
  process.off('unhandledRejection', onRejection);
  process.off('uncaughtException', onException);
  for (const url of [queue.url, queue.deadLetterUrl]) {
    if (url) await queue.client.send(new DeleteQueueCommand({ QueueUrl: url })).catch(() => {});
  }
  queue.close();
  storage.close();
  await database.close();
  await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.close();
  await rm(directory, { recursive: true, force: true });
}
