import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database, Conflict, users, LeadRepository } from '@careerscope/core';
import { DeleteQueueCommand } from '@aws-sdk/client-sqs';
import { LocalQueue } from './queue.js';
import { executeBullCommand } from './bull-queue.js';
import { consumeMessage, publishPending, reconcileDeadLetter } from './dispatch.js';
import { Auth, passwordHash } from './auth.js';
import { createApp } from '../../../apps/api/src/app.js';
import type { SourceOutcome } from './jobs.js';
import { searchHandler } from '../../../apps/workers/search/src/collect.js';
import {
  createRemoteOkProvider,
  createHimalayasProvider,
} from '../../../../packages/providers/dist/index.js';

test('partial search outcomes are atomic, owner-scoped, terminal and usable through the API', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured);
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  const admin = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  const previousMigrations = await mkdtemp(join(tmpdir(), 'careerscope-migration-'));
  try {
    const migrationsFolder = new URL('../../../migrations', import.meta.url).pathname;
    const journal = JSON.parse(
      await readFile(join(migrationsFolder, 'meta/_journal.json'), 'utf8'),
    ) as { entries: { idx: number; tag: string }[] };
    journal.entries = journal.entries.filter((entry) => entry.idx <= 6);
    await mkdir(join(previousMigrations, 'meta'));
    await writeFile(join(previousMigrations, 'meta/_journal.json'), JSON.stringify(journal));
    for (const entry of journal.entries)
      await copyFile(
        join(migrationsFolder, `${entry.tag}.sql`),
        join(previousMigrations, `${entry.tag}.sql`),
      );
    await migrate(database.db, { migrationsFolder: previousMigrations });
    const historicalOwner = randomUUID();
    const historicalRun = randomUUID();
    await database.pool.query('INSERT INTO users (id, email, password_hash) VALUES ($1, $2, $3)', [
      historicalOwner,
      `${historicalOwner}@example.test`,
      'synthetic',
    ]);
    await database.pool.query(
      `INSERT INTO search_runs (id, owner_id, request, request_hash, idempotency_key, status)
      VALUES ($1, $2, $3::jsonb, 'synthetic', 'historical', 'completed')`,
      [historicalRun, historicalOwner, JSON.stringify({ query: 'React', sources: ['remoteok'] })],
    );
    await migrate(database.db, { migrationsFolder });
    await migrate(database.db, { migrationsFolder });
    const historical = await database.getSearch(historicalOwner, historicalRun);
    assert.equal(historical?.status, 'completed');
    assert.equal(historical?.sourceOutcomes, null);
    const ownerId = randomUUID();
    const otherOwner = randomUUID();
    const password = randomUUID();
    const hash = await passwordHash(password);
    await database.db.insert(users).values(
      [ownerId, otherOwner].map((id) => ({
        id,
        email: `${id}@example.test`,
        passwordHash: hash,
      })),
    );
    const request = {
      query: 'React',
      sources: ['remoteok', 'himalayas'] as ['remoteok', 'himalayas'],
    };
    const search = await database.createSearch(ownerId, 'partial-result-test', request);
    const command = (await database.unpublished())[0]!.command;
    const first = await database.claim(command.id);
    assert.ok(first);
    await database.release(command.id, first);
    const fence = await database.claim(command.id);
    assert.ok(fence);
    const job = {
      fingerprint: 'partial-test',
      title: 'React Engineer',
      company: 'Synthetic',
      location: 'Remote',
      description: 'Validated partial result',
      source: 'remoteok' as const,
      sourceUrl: 'https://remoteok.com/remote-jobs/synthetic',
      applyUrl: 'https://example.test/apply',
      postedAt: null,
    };
    const outcomes: SourceOutcome[] = [
      { source: 'remoteok', status: 'completed', accepted: 1, limited: false, errorCode: null },
      {
        source: 'himalayas',
        status: 'failed',
        accepted: 0,
        limited: false,
        errorCode: 'source_failed',
      },
    ];
    assert.equal(await database.completeCollection(command, first, [job], outcomes), false);
    assert.equal(await database.startSearch(command, first), false);
    assert.equal(await database.startSearch({ ...command, ownerId: otherOwner }, fence), false);
    assert.equal(await database.startSearch(command, fence), true);
    assert.equal(await database.startSearch(command, fence), true);
    assert.equal(
      await database.completeCollection(
        { ...command, ownerId: otherOwner },
        fence,
        [job],
        outcomes,
      ),
      false,
    );
    await assert.rejects(
      database.completeCollection(command, fence, [job], outcomes.slice(0, 1)),
      Conflict,
    );
    await assert.rejects(
      database.completeCollection(
        command,
        fence,
        [job, { ...job, fingerprint: 'second' }],
        [outcomes[0]!, { ...outcomes[1]!, accepted: 1 }],
      ),
      Conflict,
    );
    await assert.rejects(
      database.completeCollection(command, fence, [job], [outcomes[0]!, outcomes[0]!]),
      /./,
    );
    await database.pool
      .query(`CREATE FUNCTION reject_partial_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.type = 'SearchPartial' THEN RAISE EXCEPTION 'synthetic rollback'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_partial_event BEFORE INSERT ON run_events FOR EACH ROW EXECUTE FUNCTION reject_partial_event()`);
    await assert.rejects(
      database.completeCollection(command, fence, [job], outcomes),
      /synthetic rollback/,
    );
    assert.equal((await database.getSearch(ownerId, search.id))?.status, 'running');
    assert.equal((await database.getSearch(ownerId, search.id))?.sourceOutcomes, null);
    assert.equal(
      (await database.pool.query('SELECT id FROM search_jobs WHERE run_id = $1', [search.id]))
        .rowCount,
      0,
    );
    assert.equal(await database.executionStatus(command.id), 'running');
    await database.pool.query(
      'DROP TRIGGER reject_partial_event ON run_events; DROP FUNCTION reject_partial_event()',
    );
    assert.equal(await database.completeCollection(command, fence, [job], outcomes), true);
    assert.equal(await database.executionStatus(command.id), 'completed');
    assert.deepEqual((await database.getSearch(ownerId, search.id))?.sourceOutcomes, outcomes);
    assert.equal((await database.cancelSearch(ownerId, search.id))?.status, 'partial');
    assert.equal(await database.fail(command, fence), false);
    assert.equal(await database.claim(command.id), null);
    const terminal = await database.pool.query(
      "SELECT type FROM run_events WHERE run_id = $1 AND type <> 'SearchQueued'",
      [search.id],
    );
    assert.deepEqual(terminal.rows, [{ type: 'SearchStarted' }, { type: 'SearchPartial' }]);
    const origin = 'http://localhost:5280';
    const app = await createApp(database, origin, async () => true);
    try {
      const otherToken = await new Auth(database).login(`${otherOwner}@example.test`, password);
      assert.ok(otherToken);
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin },
        payload: { email: `${ownerId}@example.test`, password },
      });
      const sessionCookie = login.cookies[0]!;
      const cookies = { [sessionCookie.name]: sessionCookie.value };
      const detail = await app.inject({ url: `/api/searches/${search.id}`, cookies });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().status, 'partial');
      assert.deepEqual(detail.json().sourceOutcomes, outcomes);
      const exported = await app.inject({ url: `/api/searches/${search.id}/export`, cookies });
      assert.equal(exported.statusCode, 200);
      assert.equal(exported.json().status, 'partial');
      assert.deepEqual(exported.json().sourceOutcomes, outcomes);
      assert.equal(exported.json().jobs.length, 1);
      for (const suffix of ['', '/export']) {
        const url = `/api/searches/${search.id}${suffix}`;
        assert.equal((await app.inject(url)).statusCode, 401);
        assert.equal(
          (await app.inject({ url, cookies: { [sessionCookie.name]: otherToken } })).statusCode,
          404,
        );
      }
      const jobId = detail.json().jobs[0].id;
      const leads = new LeadRepository(database);
      assert.ok(await leads.save(ownerId, { jobId }));
      assert.equal(await leads.save(otherOwner, { jobId }), null);
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const eventUrl = `${address}/api/searches/${search.id}/events`;
      const eventHeaders = { cookie: `${sessionCookie.name}=${sessionCookie.value}` };
      const stream = await fetch(eventUrl, {
        headers: eventHeaders,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get('content-type')!, /^text\/event-stream/);
      assert.equal(stream.headers.get('x-accel-buffering'), 'no');
      const replay = await stream.text();
      assert.match(replay, /SearchQueued/);
      assert.match(replay, /SearchPartial/);
      assert.match(replay, /event: settled/);
      assert.doesNotMatch(replay, /Validated partial result|example\.test|sourceOutcomes/);
      const queuedCursor = detail.json().events[0].cursor;
      const terminalCursor = detail.json().events.at(-1).cursor;
      const resumed = await fetch(`${eventUrl}?after=0`, {
        headers: { ...eventHeaders, 'Last-Event-ID': queuedCursor },
        signal: AbortSignal.timeout(5000),
      });
      const resumedText = await resumed.text();
      assert.doesNotMatch(resumedText, /SearchQueued/);
      assert.match(resumedText, /SearchPartial/);
      const caughtUp = await fetch(`${eventUrl}?after=${terminalCursor}`, {
        headers: eventHeaders,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(await caughtUp.text(), 'retry: 2000\n\nevent: settled\ndata: {}\n\n');
      for (const invalid of ['-1', '9223372036854775808', '99999999', '1e2']) {
        assert.equal(
          (await app.inject({ url: `/api/searches/${search.id}/events?after=${invalid}`, cookies }))
            .statusCode,
          400,
        );
      }
      assert.equal(
        (
          await app.inject({
            url: `/api/searches/${search.id}/events`,
            cookies: { [sessionCookie.name]: otherToken },
          })
        ).statusCode,
        404,
      );
      assert.equal((await app.inject(`/api/searches/${search.id}/events`)).statusCode, 401);
      const live = await database.createSearch(ownerId, 'live-stream-revocation', request);
      const liveUrl = `${address}/api/searches/${live.id}/events`;
      const concurrentStreams = await Promise.all(
        Array.from({ length: 3 }, () =>
          fetch(liveUrl, { headers: eventHeaders, signal: AbortSignal.timeout(5000) }),
        ),
      );
      assert.deepEqual(
        concurrentStreams.map((response) => response.status).sort(),
        [200, 200, 429],
      );
      const liveStreams = concurrentStreams.filter((response) => response.status === 200);
      await concurrentStreams.find((response) => response.status === 429)!.text();
      assert.ok(liveStreams.every((response) => response.status === 200));
      const denied = await fetch(liveUrl, {
        headers: eventHeaders,
        signal: AbortSignal.timeout(5000),
      });
      assert.equal(denied.status, 429);
      await denied.text();
      await new Auth(database).logout(sessionCookie.value);
      for (const response of liveStreams)
        assert.match(await response.text(), /event: session-expired/);
    } finally {
      await app.close();
    }
    const failed = await database.createSearch(ownerId, 'all-failed-result', request);
    const failedCommand = (await database.unpublished()).find(
      (entry) => entry.command.aggregateId === failed.id,
    )!.command;
    const failedFence = await database.claim(failedCommand.id);
    assert.ok(failedFence);
    const failedOutcomes: SourceOutcome[] = outcomes.map((outcome) => ({
      ...outcome,
      status: 'failed',
      accepted: 0,
      errorCode: 'source_failed',
    }));
    assert.equal(
      await database.completeCollection(failedCommand, failedFence, [], failedOutcomes),
      true,
    );
    assert.equal((await database.getSearch(ownerId, failed.id))?.status, 'failed');
    assert.equal(await database.executionStatus(failedCommand.id), 'completed');
    const cancelled = await database.createSearch(ownerId, 'partial-cancelled', request);
    const cancelledCommand = (await database.unpublished()).find(
      (entry) => entry.command.aggregateId === cancelled.id,
    )!.command;
    const cancelledFence = await database.claim(cancelledCommand.id);
    assert.ok(cancelledFence);
    await database.cancelSearch(ownerId, cancelled.id);
    assert.equal(
      await database.completeCollection(cancelledCommand, cancelledFence, [job], outcomes),
      false,
    );
    assert.equal((await database.getSearch(ownerId, cancelled.id))?.sourceOutcomes, null);
    const handler = searchHandler(database, [
      {
        ...createRemoteOkProvider(),
        async *search() {
          yield {
            source: 'remoteok' as const,
            sourceJobId: 'queue-partial',
            title: job.title,
            companyName: job.company,
            location: job.location,
            description: job.description,
            sourceUrl: job.sourceUrl,
            applyUrl: job.applyUrl,
          };
        },
      },
      {
        ...createHimalayasProvider(),
        async *search() {
          yield* [];
          throw new Error('Synthetic provider outage; must not reach events');
        },
      },
    ]);
    const queue = new LocalQueue(process.env.LOCAL_AWS_ENDPOINT!);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const racing = await database.createSearch(ownerId, `event-order-${attempt}`, request);
      const racingCommand = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === racing.id,
      )!.command;
      const racingFence = await database.claim(racingCommand.id);
      assert.ok(racingFence);
      await Promise.all([
        database.startSearch(racingCommand, racingFence),
        database.completeCollection(racingCommand, racingFence, [job], outcomes),
      ]);
      const ordered = await database.pool.query(
        'SELECT type FROM run_events WHERE owner_id = $1 AND run_id = $2 ORDER BY sequence',
        [ownerId, racing.id],
      );
      assert.equal(ordered.rows[0].type, 'SearchQueued');
      assert.equal(ordered.rows.at(-1).type, 'SearchPartial');
      assert.ok(ordered.rowCount === 2 || ordered.rowCount === 3);
      if (ordered.rowCount === 3) assert.equal(ordered.rows[1].type, 'SearchStarted');
    }
    try {
      await queue.initialize(`test-partial-${randomUUID()}`);
      for (const [transport, allFailed] of [
        ['sqs', false],
        ['bullmq', false],
        ['sqs', true],
        ['bullmq', true],
      ] as const) {
        const execute = allFailed
          ? searchHandler(
              database,
              [createRemoteOkProvider(), createHimalayasProvider()].map((provider) => ({
                ...provider,
                async *search() {
                  yield* [];
                  throw new Error('Synthetic total source outage');
                },
              })),
            )
          : handler;
        const queued = await database.createSearch(
          ownerId,
          `partial-${transport}-${allFailed}`,
          request,
        );
        const queuedCommand = (await database.unpublished()).find(
          (entry) => entry.command.aggregateId === queued.id,
        )!.command;
        if (transport === 'sqs') {
          await queue.send(queuedCommand);
          const message = await queue.receive(undefined, 1);
          assert.ok(message);
          assert.equal(
            await consumeMessage(
              database,
              queue,
              message,
              'search.collect',
              execute,
              new AbortController().signal,
            ),
            'completed',
          );
        } else {
          assert.equal(
            await executeBullCommand(
              database,
              queuedCommand,
              execute,
              new AbortController().signal,
            ),
            'completed',
          );
        }
        const result = await database.getSearch(ownerId, queued.id);
        assert.equal(result?.status, allFailed ? 'failed' : 'partial');
        assert.deepEqual(result?.sourceOutcomes, allFailed ? failedOutcomes : outcomes);
        assert.equal(await database.executionStatus(queuedCommand.id), 'completed');
        assert.equal(
          await executeBullCommand(database, queuedCommand, execute, new AbortController().signal),
          'duplicate',
        );
      }
    } finally {
      for (const url of [queue.url, queue.deadLetterUrl].filter(Boolean))
        await queue.client.send(new DeleteQueueCommand({ QueueUrl: url }));
      queue.close();
    }
  } finally {
    await rm(previousMigrations, { recursive: true, force: true });
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.close();
  }
});

test('PostgreSQL atomic outbox, owner isolation and stale-worker fencing', async () => {
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
      migrationsFolder: new URL('../../../migrations', import.meta.url).pathname,
    });
    const ownerId = randomUUID();
    await database.db.insert(users).values({
      id: ownerId,
      email: `${ownerId}@example.test`,
      passwordHash: 'synthetic-not-a-login',
    });
    const request = { query: 'React', sources: ['remoteok'] as ['remoteok'] };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => database.createSearch(ownerId, 'same-key', request)),
    );
    assert.equal(new Set(results.map((result) => result.id)).size, 1);
    assert.equal((await database.unpublished()).length, 1);
    await assert.rejects(
      database.createSearch(ownerId, 'same-key', { ...request, query: 'Python' }),
      Conflict,
    );
    assert.equal(await database.getSearch(randomUUID(), results[0]!.id), undefined);
    const record = (await database.unpublished())[0]!;
    const { command } = record;
    assert.equal(await database.claim(randomUUID()), null);
    const claims = await Promise.all(Array.from({ length: 8 }, () => database.claim(command.id)));
    assert.equal(claims.filter((value) => value !== null).length, 1);
    assert.equal(await database.complete({ ...command, ownerId: randomUUID() }, 1), false);
    assert.equal(await database.renew(command.id, 99), false);
    assert.equal(await database.renew(command.id, 1), true);
    await database.pool.query(
      "UPDATE command_executions SET lease_until = now() - interval '1 second' WHERE id = $1",
      [command.id],
    );
    const newFence = await database.claim(command.id);
    assert.equal(newFence, 2);
    assert.equal(await database.renew(command.id, 1), false);
    assert.equal(await database.complete(command, 1), false);
    assert.equal(await database.complete(command, newFence!), true);
    assert.equal(await database.claim(command.id), null);
    assert.equal(await database.complete(command, newFence!), false);
    assert.equal((await database.getSearch(ownerId, command.aggregateId))?.status, 'completed');
    assert.equal(
      (await database.pool.query("SELECT * FROM run_events WHERE type = 'SearchCompleted'"))
        .rowCount,
      1,
    );
    await assert.rejects(database.createSearch(randomUUID(), 'invalid-owner', request));
    assert.equal((await database.unpublished()).length, 1);
    const queue = new LocalQueue(process.env.LOCAL_AWS_ENDPOINT!);
    try {
      await queue.initialize(`test-${randomUUID()}`);
      await queue.send(command);
      assert.equal(await publishPending(database, { 'search.collect': queue }), 1);
      assert.equal(await publishPending(database, { 'search.collect': queue }), 0);
      const shutdown = new AbortController();
      const unexpectedHandler = async () => {
        throw new Error('Completed command must not execute again');
      };
      for (let delivery = 0; delivery < 2; delivery += 1) {
        const duplicate = await queue.receive(undefined, 1);
        assert.ok(duplicate);
        assert.equal(
          await consumeMessage(
            database,
            queue,
            duplicate,
            'search.collect',
            unexpectedHandler,
            shutdown.signal,
          ),
          'duplicate',
        );
      }
      const pending = await database.createSearch(ownerId, 'worker-test', request);
      assert.equal(await publishPending(database, { 'search.collect': queue }), 1);
      const next = await queue.receive(undefined, 1);
      assert.ok(next?.ReceiptHandle);
      await assert.rejects(
        consumeMessage(
          database,
          queue,
          next,
          'search.collect',
          async () => {
            throw new Error('Synthetic provider unavailable');
          },
          shutdown.signal,
        ),
        /Synthetic provider unavailable/,
      );
      assert.equal((await database.getSearch(ownerId, pending.id))?.status, 'queued');
      await queue.visibility(next.ReceiptHandle, 0);
      const retry = await queue.receive(undefined, 1);
      assert.ok(retry);
      const job = {
        fingerprint: 'synthetic-job',
        title: 'React engineer',
        company: 'Example',
        location: 'Remote',
        description: 'Synthetic integration fixture',
        source: 'remoteok' as const,
        sourceUrl: 'https://remoteok.com/remote-jobs/synthetic',
        applyUrl: 'https://example.test/apply',
        postedAt: null,
      };
      assert.equal(
        await consumeMessage(
          database,
          queue,
          retry,
          'search.collect',
          (retryCommand, retryFence) => database.complete(retryCommand, retryFence, [job, job]),
          shutdown.signal,
        ),
        'completed',
      );
      assert.equal((await database.getSearch(ownerId, pending.id))?.status, 'completed');
      assert.equal(
        (await database.pool.query('SELECT * FROM search_jobs WHERE run_id = $1', [pending.id]))
          .rowCount,
        1,
      );
      await assert.rejects(
        consumeMessage(
          database,
          queue,
          {
            ...retry,
            Body: JSON.stringify({ ...JSON.parse(retry.Body!), ownerId: randomUUID() }),
          },
          'search.collect',
          unexpectedHandler,
          shutdown.signal,
        ),
        /does not match/,
      );
      const exhausted = await database.createSearch(ownerId, 'exhausted-retries', request);
      const exhaustedCommand = (await database.unpublished())[0]!.command;
      await publishPending(database, { 'search.collect': queue });
      await database.pool.query(
        `INSERT INTO command_executions (id, status, fence, attempts, lease_until)
        VALUES ($1, 'running', 4, 4, now() - interval '1 second')`,
        [exhaustedCommand.id],
      );
      const lastTry = await queue.receive(undefined, 1);
      assert.ok(lastTry?.ReceiptHandle);
      await assert.rejects(
        consumeMessage(
          database,
          queue,
          lastTry,
          'search.collect',
          unexpectedHandler,
          shutdown.signal,
        ),
      );
      assert.equal((await database.getSearch(ownerId, exhausted.id))?.status, 'failed');
      assert.equal(await database.claim(exhaustedCommand.id), null);
      const abandoned = await database.createSearch(ownerId, 'abandoned-queue', request);
      const abandonedCommand = (await database.unpublished())[0]!.command;
      await database.published(abandonedCommand.id);
      await database.pool.query(
        "UPDATE outbox_events SET published_at = now() - interval '3 minutes' WHERE id = $1",
        [abandonedCommand.id],
      );
      assert.equal((await database.unpublished())[0]!.command.id, abandonedCommand.id);
      assert.equal(
        await reconcileDeadLetter(database, { Body: JSON.stringify(abandonedCommand) }),
        true,
      );
      assert.equal((await database.getSearch(ownerId, abandoned.id))?.status, 'failed');
      assert.equal((await database.unpublished()).length, 0);
      assert.equal(
        await reconcileDeadLetter(database, { Body: JSON.stringify(abandonedCommand) }),
        false,
      );
    } finally {
      for (const url of [queue.url, queue.deadLetterUrl].filter(Boolean)) {
        await queue.client.send(new DeleteQueueCommand({ QueueUrl: url }));
      }
      queue.close();
    }
    for (const active of [false, true]) {
      const cancellable = await database.createSearch(ownerId, `cancel-${active}`, request);
      const cancellationCommand = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === cancellable.id,
      )!.command;
      const fence = active ? await database.claim(cancellationCommand.id) : null;
      assert.equal(await database.cancelSearch(randomUUID(), cancellable.id), undefined);
      const cancellations = await Promise.all(
        Array.from({ length: 4 }, () => database.cancelSearch(ownerId, cancellable.id)),
      );
      assert.ok(cancellations.every((search) => search?.status === 'cancelled'));
      assert.equal(await database.claim(cancellationCommand.id), null);
      if (fence !== null) {
        assert.equal(await database.renew(cancellationCommand.id, fence), false);
        assert.equal(await database.complete(cancellationCommand, fence), false);
        assert.equal(await database.fail(cancellationCommand, fence), false);
      }
      const terminal = await database.pool.query(
        "SELECT type FROM run_events WHERE run_id = $1 AND type <> 'SearchQueued'",
        [cancellable.id],
      );
      assert.deepEqual(terminal.rows, [{ type: 'SearchCancelled' }]);
      const neverRun = async () => {
        throw new Error('Cancelled work must not run');
      };
      assert.equal(
        await executeBullCommand(
          database,
          cancellationCommand,
          neverRun,
          new AbortController().signal,
        ),
        'duplicate',
      );
      const cancelledQueue = new LocalQueue(process.env.LOCAL_AWS_ENDPOINT!);
      try {
        await cancelledQueue.initialize(`test-cancel-${randomUUID()}`);
        await cancelledQueue.send(cancellationCommand);
        const message = await cancelledQueue.receive(undefined, 1);
        assert.ok(message);
        assert.equal(
          await consumeMessage(
            database,
            cancelledQueue,
            message,
            'search.collect',
            neverRun,
            new AbortController().signal,
          ),
          'duplicate',
        );
      } finally {
        for (const url of [cancelledQueue.url, cancelledQueue.deadLetterUrl].filter(Boolean)) {
          await cancelledQueue.client.send(new DeleteQueueCommand({ QueueUrl: url }));
        }
        cancelledQueue.close();
      }
    }
    assert.equal((await database.cancelSearch(ownerId, command.aggregateId))?.status, 'completed');
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const racing = await database.createSearch(ownerId, `cancel-race-${attempt}`, request);
      const racingCommand = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === racing.id,
      )!.command;
      const fence = await database.claim(racingCommand.id);
      await Promise.all([
        database.complete(racingCommand, fence!),
        database.cancelSearch(ownerId, racing.id),
      ]);
      const terminal = await database.pool.query(
        "SELECT type FROM run_events WHERE run_id = $1 AND type <> 'SearchQueued'",
        [racing.id],
      );
      assert.equal(terminal.rowCount, 1);
      const state = await database.getSearch(ownerId, racing.id);
      assert.equal(
        terminal.rows[0].type,
        state?.status === 'completed' ? 'SearchCompleted' : 'SearchCancelled',
      );
    }
    await assert.rejects(
      new Auth(database).createOwner('replacement@example.test', randomUUID()),
      /already configured/,
    );
    assert.equal(new Auth(database).validCsrf('a'.repeat(64), '\u00e9'.repeat(64)), false);
    const password = randomUUID();
    await database.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [
      await passwordHash(password),
      ownerId,
    ]);
    let allowRequest = true;
    const origin = 'http://localhost:5280';
    const app = await createApp(database, origin, async () => allowRequest);
    try {
      assert.equal((await app.inject('/api/searches')).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            payload: { email: `${ownerId}@example.test`, password },
          })
        ).statusCode,
        403,
      );
      const login = await app.inject({
        method: 'POST',
        url: '/api/login',
        headers: { origin },
        payload: { email: `${ownerId}@example.test`, password },
      });
      assert.equal(login.statusCode, 200);
      const cookieValue = login.cookies[0]!;
      assert.equal(cookieValue.httpOnly, true);
      const cookies = { [cookieValue.name]: cookieValue.value };
      const session = (await app.inject({ url: '/api/session', cookies })).json();
      const headers = { origin, 'x-csrf-token': session.csrf, 'idempotency-key': 'api-regression' };
      assert.equal((await app.inject('/api/profile')).statusCode, 401);
      const emptyProfile = await app.inject({ url: '/api/profile', cookies });
      assert.deepEqual(emptyProfile.json(), { revision: 0, profile: null, updatedAt: null });
      assert.equal(emptyProfile.headers['cache-control'], 'no-store');
      const profile = {
        candidate: {
          fullName: 'Example Candidate',
          email: 'candidate@example.test',
          location: 'Hyderabad',
        },
        preferences: { titles: ['React Engineer'], techStack: ['React', 'TypeScript'] },
        application: { yearsOfExperience: 4 },
      };
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/profile',
            cookies,
            headers: { origin },
            payload: { revision: 0, profile },
          })
        ).statusCode,
        403,
      );
      const competingSaves = await Promise.all(
        Array.from({ length: 2 }, () =>
          app.inject({
            method: 'PUT',
            url: '/api/profile',
            cookies,
            headers,
            payload: { revision: 0, profile },
          }),
        ),
      );
      assert.deepEqual(competingSaves.map((response) => response.statusCode).sort(), [200, 409]);
      assert.equal((await app.inject({ url: '/api/profile', cookies })).json().revision, 1);
      const updatedProfile = await app.inject({
        method: 'PUT',
        url: '/api/profile',
        cookies,
        headers,
        payload: { revision: 1, profile: { ...profile, application: { yearsOfExperience: 5 } } },
      });
      assert.equal(updatedProfile.statusCode, 200);
      assert.equal(updatedProfile.json().revision, 2);
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/profile',
            cookies,
            headers,
            payload: { revision: 1, profile },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/profile',
            cookies,
            headers,
            payload: { revision: 2, ownerId: randomUUID(), profile },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/profile',
            cookies,
            headers,
            payload: {
              revision: 2,
              profile: { ...profile, application: { yearsOfExperience: -1 } },
            },
          })
        ).statusCode,
        400,
      );
      const otherOwner = randomUUID();
      const otherEmail = `${otherOwner}@example.test`;
      await database.db
        .insert(users)
        .values({ id: otherOwner, email: otherEmail, passwordHash: await passwordHash(password) });
      const otherToken = await new Auth(database).login(otherEmail, password);
      assert.ok(otherToken);
      assert.equal(
        (
          await app.inject({ url: '/api/profile', cookies: { [cookieValue.name]: otherToken } })
        ).json().profile,
        null,
      );
      const persistedProfile = (await app.inject({ url: '/api/profile', cookies })).json();
      assert.equal(persistedProfile.profile.application.yearsOfExperience, 5);
      assert.equal(persistedProfile.revision, 2);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/searches',
            cookies,
            headers: { origin },
            payload: request,
          })
        ).statusCode,
        403,
      );
      const created = await app.inject({
        method: 'POST',
        url: '/api/searches',
        cookies,
        headers,
        payload: request,
      });
      assert.equal(created.statusCode, 202);
      const pendingExportUrl = `/api/searches/${created.json().runId}/export`;
      assert.equal((await app.inject({ url: pendingExportUrl, cookies })).statusCode, 409);
      const exportUrl = `/api/searches/${command.aggregateId}/export`;
      assert.equal((await app.inject(exportUrl)).statusCode, 401);
      assert.equal(
        (await app.inject({ url: exportUrl, cookies: { [cookieValue.name]: otherToken } }))
          .statusCode,
        404,
      );
      assert.equal(
        (await app.inject({ url: '/api/searches/invalid/export', cookies })).statusCode,
        400,
      );
      assert.equal(
        (await app.inject({ url: `/api/searches/${randomUUID()}/export`, cookies })).statusCode,
        404,
      );
      const emptyExport = await app.inject({ url: exportUrl, cookies });
      assert.equal(emptyExport.statusCode, 200);
      assert.deepEqual(emptyExport.json(), {
        schemaVersion: 1,
        runId: command.aggregateId,
        status: 'completed',
        sourceOutcomes: null,
        request,
        jobs: [],
      });
      assert.equal(emptyExport.headers['cache-control'], 'no-store');
      assert.equal(
        emptyExport.headers['content-disposition'],
        `attachment; filename="careerscope-search-${command.aggregateId}.json"`,
      );
      assert.match(String(emptyExport.headers['content-type']), /^application\/json/);
      const populatedRun = await database.createSearch(ownerId, 'export-fixture', request);
      const populatedCommand = (await database.unpublished()).find(
        (entry) => entry.command.aggregateId === populatedRun.id,
      )!.command;
      const populatedFence = await database.claim(populatedCommand.id);
      assert.ok(populatedFence);
      await database.complete(populatedCommand, populatedFence, [
        {
          fingerprint: 'export-synthetic',
          title: '=Synthetic "React" Engineer',
          company: 'Example',
          location: 'Remote',
          description: 'First line\nSecond line <script>untrusted</script>',
          source: 'himalayas',
          sourceUrl: 'https://himalayas.app/jobs/synthetic',
          applyUrl: 'https://example.test/apply',
          postedAt: null,
        },
      ]);
      await database.pool.query(
        'UPDATE search_jobs SET data = data || $1::jsonb WHERE run_id = $2',
        [JSON.stringify({ privateNotes: 'must-not-export' }), populatedRun.id],
      );
      const populatedExport = await app.inject({
        url: `/api/searches/${populatedRun.id}/export`,
        cookies,
      });
      assert.equal(populatedExport.statusCode, 200);
      assert.equal(populatedExport.json().jobs.length, 1);
      assert.equal(populatedExport.json().jobs[0].title, '=Synthetic "React" Engineer');
      assert.equal(
        populatedExport.json().jobs[0].description,
        'First line\nSecond line <script>untrusted</script>',
      );
      assert.equal(populatedExport.json().jobs[0].source, 'himalayas');
      assert.equal(populatedExport.json().jobs[0].match, null);
      assert.doesNotMatch(
        populatedExport.body,
        /must-not-export|candidate@example.test|passwordHash|matchingProfile|ownerId/,
      );
      const snapshot = await database.getSearch(ownerId, created.json().runId);
      const jobId = (
        await database.pool.query('SELECT id FROM search_jobs WHERE run_id = $1', [populatedRun.id])
      ).rows[0].id;
      assert.equal((await app.inject('/api/leads')).statusCode, 401);
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/leads',
            cookies,
            headers: { origin },
            payload: { jobId },
          })
        ).statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/leads',
            cookies,
            headers,
            payload: { jobId, ownerId: otherOwner },
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/leads',
            cookies,
            headers,
            payload: { jobId: randomUUID() },
          })
        ).statusCode,
        404,
      );
      const leadRepository = new LeadRepository(database);
      assert.equal(await leadRepository.save(otherOwner, { jobId }), null);
      const saves = await Promise.all(
        Array.from({ length: 6 }, () =>
          app.inject({ method: 'POST', url: '/api/leads', cookies, headers, payload: { jobId } }),
        ),
      );
      assert.ok(saves.every((response) => response.statusCode === 200));
      assert.equal(new Set(saves.map((response) => response.json().id)).size, 1);
      const lead = saves[0]!.json();
      const leadUrl = `/api/leads/${lead.id}`;
      assert.equal(lead.revision, 1);
      assert.equal(lead.status, 'saved');
      assert.doesNotMatch(saves[0]!.body, /must-not-export/);
      for (const suffix of ['', '/history']) {
        assert.equal(
          (await app.inject({ url: leadUrl + suffix, cookies: { [cookieValue.name]: otherToken } }))
            .statusCode,
          404,
        );
      }
      assert.equal(
        (
          await app.inject({ url: '/api/leads', cookies: { [cookieValue.name]: otherToken } })
        ).json().items.length,
        0,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: leadUrl,
            cookies: { [cookieValue.name]: otherToken },
            headers: {
              origin,
              'x-csrf-token': (
                await app.inject({
                  url: '/api/session',
                  cookies: { [cookieValue.name]: otherToken },
                })
              ).json().csrf,
            },
            payload: { revision: 1, notes: 'not mine', status: 'saved' },
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: leadUrl,
            cookies,
            headers: { origin },
            payload: { revision: 1, notes: '', status: 'saved' },
          })
        ).statusCode,
        403,
      );
      for (const invalid of [
        { revision: 1, notes: '', status: 'applied' },
        { revision: 0, notes: '', status: 'saved' },
        { revision: 1, notes: 'x'.repeat(10001), status: 'saved' },
        { revision: 1, notes: '', status: 'saved', ownerId },
      ])
        assert.equal(
          (await app.inject({ method: 'PUT', url: leadUrl, cookies, headers, payload: invalid }))
            .statusCode,
          400,
        );
      const updates = await Promise.all(
        Array.from({ length: 2 }, (_, index) =>
          app.inject({
            method: 'PUT',
            url: leadUrl,
            cookies,
            headers,
            payload: { revision: 1, notes: `Private note ${index}`, status: 'saved' },
          }),
        ),
      );
      assert.deepEqual(updates.map((response) => response.statusCode).sort(), [200, 409]);
      const revised = updates.find((response) => response.statusCode === 200)!.json();
      const archived = await app.inject({
        method: 'PUT',
        url: leadUrl,
        cookies,
        headers,
        payload: { revision: revised.revision, notes: revised.notes, status: 'archived' },
      });
      assert.equal(archived.statusCode, 200);
      assert.equal((await app.inject({ url: '/api/leads', cookies })).json().items.length, 0);
      assert.equal(
        (await app.inject({ url: '/api/leads?status=archived', cookies })).json().items[0].id,
        lead.id,
      );
      const duplicate = (
        await app.inject({
          method: 'POST',
          url: '/api/leads',
          cookies,
          headers,
          payload: { jobId },
        })
      ).json();
      assert.equal(duplicate.status, 'archived');
      assert.equal(duplicate.notes, revised.notes);
      assert.equal(duplicate.revision, 3);
      const restored = await app.inject({
        method: 'PUT',
        url: leadUrl,
        cookies,
        headers,
        payload: { revision: 3, notes: revised.notes, status: 'saved' },
      });
      assert.equal(restored.json().revision, 4);
      const noop = await app.inject({
        method: 'PUT',
        url: leadUrl,
        cookies,
        headers,
        payload: { revision: 4, notes: revised.notes, status: 'saved' },
      });
      assert.equal(noop.json().revision, 4);
      const audit = await app.inject({ url: `${leadUrl}/history`, cookies });
      assert.deepEqual(
        audit.json().items.map((entry: { revision: number }) => entry.revision),
        [4, 3, 2, 1],
      );
      assert.deepEqual(
        audit.json().items.map((entry: { notesChanged: boolean }) => entry.notesChanged),
        [false, false, true, false],
      );
      assert.doesNotMatch(audit.body, /Private note/);
      assert.equal(audit.headers['cache-control'], 'no-store');
      assert.equal((await app.inject({ url: '/api/leads?limit=51', cookies })).statusCode, 400);
      assert.equal(
        (await app.inject({ url: '/api/leads?status=applied', cookies })).statusCode,
        400,
      );
      assert.equal(
        (await app.inject({ url: `${leadUrl}/history?before=invalid`, cookies })).statusCode,
        400,
      );
      assert.equal(
        (await app.inject({ url: `${leadUrl}/history?before=3`, cookies })).json().items.length,
        2,
      );
      for (let revision = 4; revision < 30; revision += 1) {
        await leadRepository.update(ownerId, lead.id, {
          revision,
          status: 'saved',
          notes: `History fixture ${revision}`,
        });
      }
      const firstHistory = await leadRepository.history(ownerId, lead.id, {});
      assert.equal(firstHistory?.items.length, 25);
      assert.equal(firstHistory?.nextCursor, 6);
      assert.equal(
        (await leadRepository.history(ownerId, lead.id, { before: firstHistory?.nextCursor }))
          ?.items.length,
        5,
      );
      const secondJob = (
        await database.pool.query(
          'SELECT id FROM search_jobs WHERE owner_id = $1 AND run_id <> $2 LIMIT 1',
          [ownerId, populatedRun.id],
        )
      ).rows[0].id;
      const secondLead = await leadRepository.save(ownerId, { jobId: secondJob });
      assert.ok(secondLead);
      await database.pool.query('UPDATE saved_leads SET created_at = $1 WHERE owner_id = $2', [
        '2026-09-14T00:00:00.123456Z',
        ownerId,
      ]);
      const firstPage = await leadRepository.list(ownerId, { limit: 1 });
      assert.ok(firstPage.nextCursor);
      const secondPage = await leadRepository.list(ownerId, {
        limit: 1,
        before: firstPage.nextCursor,
      });
      assert.equal(secondPage.items.length, 1);
      assert.notEqual(firstPage.items[0]!.id, secondPage.items[0]!.id);
      assert.equal(secondPage.nextCursor, null);
      await assert.rejects(
        database.pool.query(
          "INSERT INTO lead_history (id, owner_id, lead_id, revision, status, notes_changed) VALUES ($1, $2, $3, 100, 'saved', 0)",
          [randomUUID(), otherOwner, lead.id],
        ),
      );
      await assert.rejects(
        database.pool.query("UPDATE saved_leads SET status = 'applied' WHERE id = $1", [lead.id]),
      );
      assert.equal(snapshot?.profileRevision, 2);
      assert.equal(snapshot?.matchingProfile?.application.yearsOfExperience, 5);
      assert.deepEqual(Object.keys(snapshot!.matchingProfile!.candidate), ['location']);
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/profile',
            cookies,
            headers,
            payload: {
              revision: 2,
              profile: { ...profile, application: { yearsOfExperience: 6 } },
            },
          })
        ).statusCode,
        200,
      );
      const replayed = await app.inject({
        method: 'POST',
        url: '/api/searches',
        cookies,
        headers,
        payload: request,
      });
      assert.equal(replayed.json().runId, created.json().runId);
      assert.equal(
        (await database.getSearch(ownerId, replayed.json().runId))?.matchingProfile?.application
          .yearsOfExperience,
        5,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/searches',
            cookies,
            headers,
            payload: { ...request, query: 'Python' },
          })
        ).statusCode,
        409,
      );
      assert.equal(
        (await app.inject({ url: `/api/searches/${created.json().runId}`, cookies })).statusCode,
        200,
      );
      assert.equal(
        (await app.inject({ url: `/api/searches/${randomUUID()}`, cookies })).statusCode,
        404,
      );
      const cancelUrl = `/api/searches/${created.json().runId}/cancel`;
      assert.equal(
        (await app.inject({ method: 'POST', url: cancelUrl, headers: { origin } })).statusCode,
        401,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: cancelUrl, cookies, headers: { origin } }))
          .statusCode,
        403,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/searches/invalid/cancel',
            cookies,
            headers,
          })
        ).statusCode,
        400,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/searches/${randomUUID()}/cancel`,
            cookies,
            headers,
          })
        ).statusCode,
        404,
      );
      const cancelled = await app.inject({ method: 'POST', url: cancelUrl, cookies, headers });
      assert.equal(cancelled.statusCode, 200);
      assert.equal(cancelled.json().status, 'cancelled');
      assert.deepEqual(
        (await app.inject({ method: 'POST', url: cancelUrl, cookies, headers })).json(),
        cancelled.json(),
      );
      allowRequest = false;
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/leads',
            cookies,
            headers,
            payload: { jobId },
          })
        ).statusCode,
        429,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: leadUrl,
            cookies,
            headers,
            payload: { revision: 30, notes: '', status: 'saved' },
          })
        ).statusCode,
        429,
      );
      assert.equal((await app.inject({ url: exportUrl, cookies })).statusCode, 429);
      assert.equal(
        (await app.inject({ method: 'POST', url: cancelUrl, cookies, headers })).statusCode,
        429,
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: '/api/login',
            headers: { origin },
            payload: { email: `${ownerId}@example.test`, password },
          })
        ).statusCode,
        429,
      );
      assert.equal(
        (await app.inject({ method: 'POST', url: '/api/logout', cookies, headers })).statusCode,
        200,
      );
      assert.equal((await app.inject({ url: '/api/searches', cookies })).statusCode, 401);
    } finally {
      await app.close();
    }
  } finally {
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}"`);
    await admin.close();
  }
});
