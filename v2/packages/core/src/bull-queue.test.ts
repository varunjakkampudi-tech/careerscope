import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { QueueEvents, Worker, UnrecoverableError } from 'bullmq';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database, users } from '@careerscope/core';
import { BullSearchQueue, executeBullCommand, queueConnection } from './bull-queue.js';
import { publishPending } from './dispatch.js';

test('BullMQ rejects remote endpoints and unsafe queue configuration', async () => {
  for (const url of [
    'redis://example.com',
    'http://localhost',
    'redis://localhost/1',
    'redis://user:secret@localhost',
    'redis://localhost?host=remote',
  ]) {
    assert.throws(() => queueConnection(url));
  }
  const database = new Database(process.env.DATABASE_URL!);
  const unsafe = new BullSearchQueue(database, process.env.REDIS_URL!, `test-${randomUUID()}`);
  try {
    await assert.rejects(unsafe.initialize(), /noeviction and AOF/);
  } finally {
    await unsafe.close();
    const cleanup = new BullSearchQueue(database, process.env.REDIS_URL!, unsafe.name);
    try {
      await cleanup.queue.obliterate();
    } finally {
      await cleanup.close();
      await database.close();
    }
  }
});

test(
  'BullMQ preserves durable completion, recovery, retry budgets and cancellation',
  { timeout: 60_000 },
  async () => {
    const configured = process.env.DATABASE_URL;
    assert.ok(configured);
    const url = new URL(configured);
    assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
    const admin = new Database(configured);
    const name = `test_${randomUUID().replaceAll('-', '')}`;
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    url.pathname = `/${name}`;
    const database = new Database(url.href);
    const endpoint = process.env.QUEUE_REDIS_URL ?? 'redis://127.0.0.1:56480';
    const queue = new BullSearchQueue(database, endpoint, `test-${randomUUID()}`);
    const events = new QueueEvents(queue.name, {
      connection: { ...queueConnection(endpoint), maxRetriesPerRequest: null },
    });
    const workerErrors: string[] = [];
    events.on('error', () => workerErrors.push('queue-events'));
    const shutdown = new AbortController();
    let worker: Worker | undefined;
    try {
      await migrate(database.db, {
        migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
      });
      await queue.initialize();
      await events.waitUntilReady();
      const ownerId = randomUUID();
      await database.db
        .insert(users)
        .values({ id: ownerId, email: `${ownerId}@example.test`, passwordHash: 'synthetic' });
      const create = async () => {
        const run = await database.createSearch(ownerId, randomUUID(), {
          query: 'React',
          sources: ['remoteok'],
        });
        const record = (await database.unpublished()).find(
          (entry) => entry.command.aggregateId === run.id,
        );
        assert.ok(record);
        return record.command;
      };
      const command = await create();
      await Promise.all([queue.send(command), queue.send(command)]);
      assert.equal(await queue.queue.getWaitingCount(), 1);
      await database.published(command.id);
      await (await queue.queue.getJob(command.id))!.remove();
      await database.pool.query(
        "UPDATE outbox_events SET published_at = now() - interval '3 minutes' WHERE id = $1",
        [command.id],
      );
      assert.equal(await publishPending(database, { 'search.collect': queue }), 1);
      let executions = 0;
      worker = queue.worker(async (delivered, fence, signal) => {
        signal.throwIfAborted();
        executions++;
        return database.complete(delivered, fence);
      }, shutdown.signal);
      const job = (await queue.queue.getJob(command.id))!;
      await job.waitUntilFinished(events, 10_000);
      assert.equal(executions, 1);
      assert.equal(await database.executionStatus(command.id), 'completed');
      await queue.send(command);
      await job.retry('completed');
      await job.waitUntilFinished(events, 10_000);
      assert.equal(executions, 1);
      assert.equal(
        (
          await database.pool.query(
            "SELECT id FROM run_events WHERE run_id = $1 AND type = 'SearchCompleted'",
            [command.aggregateId],
          )
        ).rowCount,
        1,
      );
      await worker.close();
      worker = undefined;

      const recover = await create();
      await queue.send(recover);
      const premature = new Worker(
        queue.name,
        async () => {
          throw new UnrecoverableError('transport-only');
        },
        { connection: { ...queueConnection(endpoint), maxRetriesPerRequest: null } },
      );
      premature.on('error', () => workerErrors.push('premature-worker'));
      try {
        await assert.rejects(
          (await queue.queue.getJob(recover.id))!.waitUntilFinished(events, 10_000),
          /transport-only/,
        );
      } finally {
        await premature.close();
      }
      assert.equal(await database.executionStatus(recover.id), undefined);
      await queue.send(recover);
      worker = queue.worker(
        (delivered, fence) => database.complete(delivered, fence),
        shutdown.signal,
      );
      await (await queue.queue.getJob(recover.id))!.waitUntilFinished(events, 10_000);
      assert.equal(await database.executionStatus(recover.id), 'completed');
      await worker.close();
      worker = undefined;

      const failure = await create();
      let failedAttempts = 0;
      worker = queue.worker(async () => {
        failedAttempts++;
        throw new Error('PRIVATE fixture body');
      }, shutdown.signal);
      await queue.send(failure);
      const failed = (await queue.queue.getJob(failure.id))!;
      await assert.rejects(failed.waitUntilFinished(events, 25_000), /attempt budget exhausted/);
      assert.equal(failedAttempts, 5);
      assert.equal(await database.executionStatus(failure.id), 'failed');
      const retained = (await queue.queue.getJob(failure.id))!;
      assert.ok(!JSON.stringify([retained.failedReason, retained.stacktrace]).includes('PRIVATE'));
      await queue.send(failure);
      assert.equal(await retained.getState(), 'failed');
      await worker.close();
      worker = undefined;

      const pending = await create();
      const neverRun = async () => {
        throw new Error('Should not run');
      };
      await assert.rejects(
        executeBullCommand(
          database,
          { ...pending, ownerId: randomUUID() },
          neverRun,
          shutdown.signal,
        ),
        UnrecoverableError,
      );
      assert.equal(await database.executionStatus(pending.id), undefined);
      const firstFence = await database.claim(pending.id);
      assert.ok(firstFence);
      assert.equal(await executeBullCommand(database, pending, neverRun, shutdown.signal), 'busy');
      await database.release(pending.id, firstFence);
      const abort = new AbortController();
      await assert.rejects(
        executeBullCommand(
          database,
          pending,
          async (_command, _fence, signal) => {
            abort.abort();
            signal.throwIfAborted();
            return false;
          },
          abort.signal,
        ),
        /interrupted/,
      );
      assert.equal(await database.executionStatus(pending.id), 'running');
      assert.equal(await database.complete(pending, firstFence), false);
      assert.equal(
        await executeBullCommand(
          database,
          pending,
          (delivered, fence) => database.complete(delivered, fence),
          shutdown.signal,
        ),
        'completed',
      );
      const interrupted = await create();
      const started = Promise.withResolvers<void>();
      const cancelled = Promise.withResolvers<void>();
      const lockQueue = new BullSearchQueue(database, endpoint, queue.name, () => {});
      try {
        worker = lockQueue.worker(async (_command, _fence, signal) => {
          started.resolve();
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          cancelled.resolve();
          signal.throwIfAborted();
          return false;
        }, shutdown.signal);
        await queue.send(interrupted);
        await started.promise;
        worker.emit('lockRenewalFailed', [interrupted.id]);
        await cancelled.promise;
        await worker.close();
        worker = undefined;
        assert.equal(
          (await database.getSearch(ownerId, interrupted.aggregateId))?.status,
          'queued',
        );
        assert.notEqual(await database.executionStatus(interrupted.id), 'completed');
      } finally {
        await lockQueue.close();
      }
      assert.deepEqual(workerErrors, []);
    } finally {
      shutdown.abort();
      await worker?.close();
      await events.close();
      await queue.queue.obliterate();
      await queue.close();
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.close();
    }
  },
);
