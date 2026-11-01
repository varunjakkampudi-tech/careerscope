import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createClient } from 'redis';
import { Database } from './database.js';
import { consumeMessage, publishPending } from './dispatch.js';
import { LocalQueue } from './queue.js';
import { users } from './schema.js';
import type { Command } from './commands.js';

// Stage 01 item 1.06: failure injection for the transactional outbox and the Redis queue.
// Guarantees under test are documented in docs/architecture/OUTBOX.md.

const request = { query: 'React', sources: ['remoteok' as const] };
const job = {
  fingerprint: 'outbox-fixture',
  sourceJobId: 'outbox-fixture',
  title: 'React engineer',
  company: 'Example',
  location: 'Remote',
  description: 'Synthetic outbox fixture',
  source: 'remoteok' as const,
  sourceUrl: 'https://remoteok.com/remote-jobs/synthetic',
  applyUrl: 'https://example.test/apply',
  postedAt: null,
};
const shutdown = new AbortController().signal;

/** A loopback TCP forwarder in front of Redis that can be switched off and on to model an outage. */
class RedisOutage {
  private server?: Server;
  private readonly sockets = new Set<Socket>();
  constructor(
    readonly port: number,
    private readonly target: { host: string; port: number },
  ) {}

  async up() {
    const server = createServer((client) => {
      const upstream = connect(this.target.port, this.target.host);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => socket.destroy());
      }
      client.pipe(upstream);
      upstream.pipe(client);
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', resolve);
    });
    this.server = server;
  }

  async down() {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    if (server) await new Promise((resolve) => server.close(resolve));
  }
}

async function freePort() {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const address = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  assert.ok(address && typeof address === 'object');
  return address.port;
}

function redisUrl() {
  const configured = process.env.QUEUE_REDIS_URL;
  assert.ok(configured, 'Integration tests require QUEUE_REDIS_URL');
  return new URL(configured);
}

async function withDatabase(run: (database: Database, ownerId: string) => Promise<void>) {
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
    const ownerId = randomUUID();
    await database.db
      .insert(users)
      .values({ id: ownerId, email: `${ownerId}@example.test`, passwordHash: 'synthetic' });
    await run(database, ownerId);
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
}

async function queued(database: Database, ownerId: string, key: string) {
  const search = await database.createSearch(ownerId, key, request);
  const record = (await database.unpublished()).find(
    (entry) => entry.command.aggregateId === search.id,
  );
  assert.ok(record, 'createSearch must leave a durable outbox row');
  return { search, command: record.command };
}

const completeWith =
  (database: Database, counter: { runs: number }) => async (command: Command, fence: number) => {
    counter.runs += 1;
    return database.complete(command, fence, [job]);
  };

test('a delivery that was claimed but never acknowledged is redelivered after the worker dies', async () => {
  const url = redisUrl();
  const name = `test-${randomUUID()}`;
  const dead = new LocalQueue(url.href);
  const survivor = new LocalQueue(url.href);
  const probe = createClient({ url: url.href });
  await probe.connect();
  try {
    await dead.initialize(name);
    const command: Command = {
      id: randomUUID(),
      type: 'search.collect',
      version: 1,
      ownerId: randomUUID(),
      aggregateId: randomUUID(),
      correlationId: randomUUID(),
      occurredAt: new Date().toISOString(),
    };
    await dead.send(command);
    const first = await dead.receive(undefined, 1);
    assert.ok(first?.ReceiptHandle);
    assert.equal(first.Attributes?.ApproximateReceiveCount, '1');
    assert.equal(await dead.receive(undefined, 0), undefined, 'an in-flight job is not handed out');

    // The worker process vanishes: no acknowledge, no visibility change. Its Redis lock would
    // lapse after the 60 s lock duration; deleting it models that lapse without waiting for it.
    await dead.close();
    assert.equal(await probe.del(`bull:${name}:${first.MessageId}:lock`), 1);

    // The stalled-job check of a surviving worker (every 15 s, two passes) returns the job to waiting.
    await survivor.initialize(name);
    const deadline = Date.now() + 60_000;
    let again;
    while (!again && Date.now() < deadline) again = await survivor.receive(undefined, 2);
    assert.ok(again?.ReceiptHandle, 'the unacknowledged command must be redelivered');
    assert.equal(again.MessageId, first.MessageId);
    assert.equal(again.Body, first.Body);
    assert.equal(again.Attributes?.ApproximateReceiveCount, '2');
    assert.notEqual(again.ReceiptHandle, first.ReceiptHandle);
    await survivor.acknowledge(again.ReceiptHandle);
    assert.equal(await survivor.receive(undefined, 1), undefined, 'an acknowledged job stays gone');
    assert.deepEqual(await survivor.depth(), { ready: 0, inFlight: 0, deadLetter: 0 });
  } finally {
    await survivor.destroy();
    await survivor.close();
    await probe.quit();
  }
});

test('a worker crash mid-command leaves the outbox row recoverable and fences the dead worker out', async () => {
  await withDatabase(async (database, ownerId) => {
    const { search, command } = await queued(database, ownerId, 'crash');
    const queue = new LocalQueue(redisUrl().href);
    try {
      await queue.initialize(`test-${randomUUID()}`);
      assert.equal(await publishPending(database, { 'search.collect': queue }), 1);
      const stale = await queue.receive(undefined, 1);
      assert.ok(stale?.ReceiptHandle);
      await queue.acknowledge(stale.ReceiptHandle);

      // The worker claims the command and starts the run, then dies: nothing settles, nothing renews.
      const deadFence = await database.claim(command.id);
      assert.equal(deadFence, 1);
      assert.equal(await database.startSearch(command, deadFence!), true);
      await database.pool.query(
        "UPDATE outbox_events SET published_at = now() - interval '3 minutes' WHERE id = $1",
        [command.id],
      );
      assert.deepEqual(
        await database.unpublished(),
        [],
        'a live lease must keep the row out of the publisher',
      );
      assert.equal((await database.getSearch(ownerId, search.id))?.status, 'running');

      // The lease lapses. The row is still there and the publisher picks it up again.
      await database.pool.query(
        "UPDATE command_executions SET lease_until = now() - interval '1 second' WHERE id = $1",
        [command.id],
      );
      assert.equal((await database.backlog()).expiredLeases, 1);
      assert.deepEqual(
        (await database.unpublished()).map((row) => row.id),
        [command.id],
      );
      assert.equal(await publishPending(database, { 'search.collect': queue }), 1);

      const counter = { runs: 0 };
      const message = await queue.receive(undefined, 1);
      assert.ok(message);
      assert.equal(
        await consumeMessage(
          database,
          queue,
          message,
          'search.collect',
          completeWith(database, counter),
          shutdown,
        ),
        'completed',
      );
      assert.equal(counter.runs, 1);
      // The dead worker comes back late with its old fence and cannot change anything.
      assert.equal(await database.complete(command, deadFence!, [job]), false);
      assert.equal(await database.renew(command.id, deadFence!), false);
      assert.equal((await database.getSearch(ownerId, search.id))?.status, 'completed');
      const jobs = await database.pool.query('SELECT 1 FROM search_jobs WHERE run_id = $1', [
        search.id,
      ]);
      assert.equal(jobs.rowCount, 1);
      const execution = await database.pool.query<{ fence: number; attempts: number }>(
        'SELECT fence, attempts FROM command_executions WHERE id = $1',
        [command.id],
      );
      assert.deepEqual(execution.rows[0], { fence: 2, attempts: 2 });
    } finally {
      await queue.destroy();
      await queue.close();
    }
  });
});

test('duplicate deliveries never apply a command twice', async () => {
  await withDatabase(async (database, ownerId) => {
    const { search, command } = await queued(database, ownerId, 'duplicate');
    const queue = new LocalQueue(redisUrl().href);
    try {
      await queue.initialize(`test-${randomUUID()}`);
      // The publisher crashes after sending but before marking the row published, so the next
      // run sends the same command again. Two messages for one durable command now exist.
      const crashing: Database = Object.create(database, {
        published: {
          value: async () => {
            throw new Error('publisher crashed after send');
          },
        },
      });
      await assert.rejects(
        publishPending(crashing, { 'search.collect': queue }),
        /publisher crashed after send/,
      );
      assert.equal((await database.unpublished()).length, 1, 'the row is still pending');
      assert.equal(await publishPending(database, { 'search.collect': queue }), 1);
      assert.equal((await queue.depth()).ready, 2);

      const counter = { runs: 0 };
      const outcomes: string[] = [];
      for (let delivery = 0; delivery < 2; delivery += 1) {
        const message = await queue.receive(undefined, 1);
        assert.ok(message);
        outcomes.push(
          await consumeMessage(
            database,
            queue,
            message,
            'search.collect',
            completeWith(database, counter),
            shutdown,
          ),
        );
      }
      assert.deepEqual(outcomes, ['completed', 'duplicate']);
      assert.equal(counter.runs, 1, 'the handler must run exactly once');
      const jobs = await database.pool.query('SELECT 1 FROM search_jobs WHERE run_id = $1', [
        search.id,
      ]);
      assert.equal(jobs.rowCount, 1);
      const events = await database.pool.query(
        "SELECT 1 FROM run_events WHERE run_id = $1 AND type = 'SearchCompleted'",
        [search.id],
      );
      assert.equal(events.rowCount, 1);
      assert.deepEqual(await queue.depth(), { ready: 0, inFlight: 0, deadLetter: 0 });
      assert.equal(await database.claim(command.id), null);
    } finally {
      await queue.destroy();
      await queue.close();
    }
  });
});

test('a duplicate that arrives while the first delivery is still running is refused as busy', async () => {
  await withDatabase(async (database, ownerId) => {
    const { search, command } = await queued(database, ownerId, 'concurrent');
    const queue = new LocalQueue(redisUrl().href);
    try {
      await queue.initialize(`test-${randomUUID()}`);
      await queue.send(command);
      await queue.send(command);
      const first = await queue.receive(undefined, 1);
      const second = await queue.receive(undefined, 1);
      assert.ok(first && second);
      const counter = { runs: 0 };
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const running = consumeMessage(
        database,
        queue,
        first,
        'search.collect',
        async (current, fence) => {
          await gate;
          return completeWith(database, counter)(current, fence);
        },
        shutdown,
      );
      const runningDeadline = Date.now() + 15_000;
      while ((await database.executionStatus(command.id)) !== 'running') {
        assert.ok(Date.now() < runningDeadline, 'the first delivery did not reach running in 15 s');
        await delay(20);
      }
      assert.equal(
        await consumeMessage(
          database,
          queue,
          second,
          'search.collect',
          completeWith(database, counter),
          shutdown,
        ),
        'busy',
      );
      assert.equal(counter.runs, 0);
      release();
      assert.equal(await running, 'completed');
      assert.equal(counter.runs, 1);
      const jobs = await database.pool.query('SELECT 1 FROM search_jobs WHERE run_id = $1', [
        search.id,
      ]);
      assert.equal(jobs.rowCount, 1);
    } finally {
      await queue.destroy();
      await queue.close();
    }
  });
});

test('a Redis outage never loses committed outbox rows and the next run reconciles them', async () => {
  await withDatabase(async (database, ownerId) => {
    const real = redisUrl();
    const port = await freePort();
    const outage = new RedisOutage(port, { host: real.hostname, port: Number(real.port || 6379) });
    const through = new URL(real.href);
    through.port = String(port);
    const queue = new LocalQueue(through.href);
    const name = `test-${randomUUID()}`;
    try {
      await outage.up();
      await queue.initialize(name);
      await outage.down();

      // The API keeps accepting work: the command is committed with the run, Redis or not.
      const first = await queued(database, ownerId, 'outage-1');
      const second = await queued(database, ownerId, 'outage-2');
      // LocalQueue sets maxRetriesPerRequest: 1, so with Redis unreachable the send fails with
      // BullMQ's ioredis MaxRetriesPerRequestError (observed on three consecutive runs). Matching the
      // class and message, not a broad connection regex, means an unrelated failure cannot pass here.
      await assert.rejects(
        publishPending(database, { 'search.collect': queue }),
        (error: unknown) =>
          error instanceof Error &&
          error.name === 'MaxRetriesPerRequestError' &&
          /Reached the max retries per request limit \(which is 1\)/.test(error.message),
      );
      const pending = await database.pool.query<{ id: string; published_at: Date | null }>(
        'SELECT id, published_at FROM outbox_events ORDER BY created_at',
      );
      assert.deepEqual(
        pending.rows.map((row) => row.id),
        [first.command.id, second.command.id],
      );
      assert.ok(
        pending.rows.every((row) => row.published_at === null),
        'a failed send must not mark the row published',
      );
      assert.equal((await database.backlog()).unpublished, 2);

      // Redis returns. The next publisher runs drain both rows.
      await outage.up();
      let published = 0;
      const deadline = Date.now() + 30_000;
      while (published < 2 && Date.now() < deadline) {
        try {
          published += await publishPending(database, { 'search.collect': queue });
        } catch {
          await delay(500);
        }
      }
      assert.equal(published, 2);
      assert.equal((await database.backlog()).unpublished, 0);

      const counter = { runs: 0 };
      const seen = new Set<string>();
      for (let index = 0; index < 2; index += 1) {
        const message = await queue.receive(undefined, 2);
        assert.ok(message);
        assert.equal(
          await consumeMessage(
            database,
            queue,
            message,
            'search.collect',
            completeWith(database, counter),
            shutdown,
          ),
          'completed',
        );
        seen.add(JSON.parse(message.Body!).id);
      }
      assert.deepEqual(seen, new Set([first.command.id, second.command.id]));
      assert.equal(counter.runs, 2);
    } finally {
      await outage.down();
      await queue.destroy().catch(() => undefined);
      await queue.close().catch(() => undefined);
    }
  });
});

test('a message lost from Redis after publication is re-sent from the outbox', async () => {
  await withDatabase(async (database, ownerId) => {
    const queue = new LocalQueue(redisUrl().href);
    try {
      await queue.initialize(`test-${randomUUID()}`);
      const { search, command } = await queued(database, ownerId, 'lost');
      assert.equal(await publishPending(database, { 'search.collect': queue }), 1);
      assert.equal(await publishPending(database, { 'search.collect': queue }), 0);

      // Redis loses its data (restart without persistence, manual flush, failover to a stale replica).
      const message = await queue.receive(undefined, 1);
      assert.ok(message?.ReceiptHandle);
      await queue.acknowledge(message.ReceiptHandle);
      await database.pool.query(
        "UPDATE outbox_events SET published_at = now() - interval '3 minutes' WHERE id = $1",
        [command.id],
      );
      assert.equal(await publishPending(database, { 'search.collect': queue }), 1);
      const resent = await queue.receive(undefined, 2);
      assert.ok(resent);
      const counter = { runs: 0 };
      assert.equal(
        await consumeMessage(
          database,
          queue,
          resent,
          'search.collect',
          completeWith(database, counter),
          shutdown,
        ),
        'completed',
      );
      assert.equal((await database.getSearch(ownerId, search.id))?.status, 'completed');
      assert.equal(counter.runs, 1);
      assert.equal(await publishPending(database, { 'search.collect': queue }), 0);
    } finally {
      await queue.destroy();
      await queue.close();
    }
  });
});
