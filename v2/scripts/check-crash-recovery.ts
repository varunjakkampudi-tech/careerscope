import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  Database,
  LocalQueue,
  PrivateFileResumeStorage,
  ResumeUploadCoordinator,
  ResumeUploadRepository,
  consumeMessage,
  passwordHash,
  publishPending,
  users,
} from '@careerscope/core';

const key = 'crash-recovery-fixture';
// Deterministic: the parent must retry byte-identical content to the killed child.
const body = Buffer.concat([
  Buffer.from('%PDF-1.7 synthetic crash fixture'),
  Buffer.alloc(2048, 7),
]);

/**
 * Child mode: performs a real upload through the production coordinator, but
 * stalls inside publication so the parent can kill it between the durable write
 * and the object becoming visible. Only the pause is synthetic.
 */
if (process.argv.includes('--child') && process.env.CRASH_MODE === 'upload') {
  const publish = process.env.CRASH_PUBLISH === 'true';
  class StalledStorage extends PrivateFileResumeStorage {
    protected override async publishObject(temporary: string, filename: string) {
      // Optionally let the object become real first, so the kill lands between
      // durable filesystem state and durable database state.
      if (publish) await super.publishObject(temporary, filename);
      process.send?.({ paused: true });
      await new Promise(() => {});
    }
  }
  const database = new Database(process.env.CRASH_DATABASE_URL!);
  const storage = new StalledStorage({
    directory: process.env.CRASH_STORAGE_DIRECTORY!,
    encryptionKey: process.env.CRASH_STORAGE_KEY!,
  });
  const coordinator = new ResumeUploadCoordinator(new ResumeUploadRepository(database), storage);
  await coordinator.upload(process.env.CRASH_OWNER_ID!, process.env.CRASH_UPLOAD_KEY ?? key, body);
  throw new Error('Child was expected to be killed during publication');
}

/**
 * Child mode: runs the real publisher, but stalls after the queue has genuinely
 * accepted the message and before the outbox row is acknowledged.
 */
if (process.argv.includes('--child') && process.env.CRASH_MODE === 'publish') {
  const database = new Database(process.env.CRASH_DATABASE_URL!);
  const queue = new LocalQueue(process.env.LOCAL_AWS_ENDPOINT!);
  await queue.initialize(process.env.CRASH_QUEUE_NAME!);
  await publishPending(database, {
    'search.collect': {
      async send(command) {
        await queue.send(command);
        process.send?.({ paused: true });
        await new Promise(() => {});
      },
    },
  });
  throw new Error('Child was expected to be killed during publication');
}

/**
 * Child mode: claims real durable work and holds the lease, so the parent can
 * kill a worker that is mid-execution with its lease still valid.
 */
if (process.argv.includes('--child') && process.env.CRASH_MODE === 'consume') {
  const database = new Database(process.env.CRASH_DATABASE_URL!);
  const queue = new LocalQueue(process.env.LOCAL_AWS_ENDPOINT!);
  await queue.initialize(process.env.CRASH_QUEUE_NAME!);
  const message = await queue.receive(AbortSignal.timeout(20000), 1);
  if (!message) throw new Error('Worker child received no message');
  await consumeMessage(
    database,
    queue,
    message,
    'search.collect',
    async () => {
      process.send?.({ paused: true });
      await new Promise(() => {});
      return true;
    },
    AbortSignal.timeout(120000),
  );
  throw new Error('Child was expected to be killed while holding its lease');
}

const configured = process.env.DATABASE_URL;
assert.ok(configured);
const url = new URL(configured);
assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
const admin = new Database(configured);
const name = `crash_${randomUUID().replaceAll('-', '')}`;
await admin.pool.query(`CREATE DATABASE "${name}"`);
url.pathname = `/${name}`;
const database = new Database(url.href);
const directory = await mkdtemp(join(tmpdir(), 'careerscope-crash-'));
const objects = join(directory, 'objects');
const encryptionKey = randomBytes(32).toString('hex');
const ownerId = randomUUID();
const uploads = new ResumeUploadRepository(database);
const pending = async () =>
  (await readdir(objects)).filter((entry) => entry.endsWith('.pending')).length;
const published = async () =>
  (await readdir(objects)).filter((entry) => entry.endsWith('.bin')).length;

try {
  await migrate(database.db, {
    migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
  });
  await database.db.insert(users).values({
    id: ownerId,
    email: `${ownerId}@example.test`,
    passwordHash: await passwordHash(randomUUID()),
  });

  const child = await killAtPause('upload', {
    CRASH_STORAGE_DIRECTORY: objects,
    CRASH_STORAGE_KEY: encryptionKey,
    CRASH_OWNER_ID: ownerId,
  });
  assert.ok(child);
  // A hard kill runs no cleanup, exactly like a power loss during publication.
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));

  // The durable write survived, but nothing may be visible or claimable yet.
  assert.equal(await pending(), 1);
  assert.equal(await published(), 0);
  const uploaded = await database.pool.query<{ id: string }>(
    'SELECT id FROM resume_uploads WHERE owner_id = $1',
    [ownerId],
  );
  assert.equal(uploaded.rowCount, 1);
  const stranded = await uploads.get(ownerId, uploaded.rows[0]!.id);
  assert.ok(stranded);
  assert.equal(stranded.status, 'uploading');
  assert.equal(stranded.objectVersion, null);
  assert.equal(stranded.commandId, null);
  assert.equal((await database.unpublished()).length, 0);

  // Restarting the single writer reclaims the stranded temporary.
  const storage = new PrivateFileResumeStorage({ directory: objects, encryptionKey });
  await storage.initialize();
  const coordinator = new ResumeUploadCoordinator(uploads, storage);
  try {
    assert.deepEqual(await storage.reclaimTemporariesAtStartup(), {
      removed: 1,
      bytes: body.length + 68,
    });
    assert.equal(await pending(), 0);

    // Recovery must not invent a publication that never happened.
    const reconciled = await coordinator.reconcile(ownerId, stranded.id);
    assert.equal(reconciled?.status, 'uploading');
    assert.equal(reconciled?.objectVersion, null);
    assert.equal(await published(), 0);

    // Retrying the identical upload converges on exactly one object and one command.
    const retried = await coordinator.upload(ownerId, key, body);
    assert.equal(retried.id, stranded.id);
    assert.equal(retried.status, 'queued');
    assert.ok(retried.objectVersion);
    assert.equal(await published(), 1);
    assert.equal(await pending(), 0);
    assert.deepEqual(await storage.get(await objectFor(retried.id), retried.objectVersion), body);

    const commands = await database.unpublished();
    assert.equal(commands.length, 1);
    assert.equal(commands[0]!.command.aggregateId, stranded.id);
    assert.equal((await storage.inventory()).reservedBytes, 0);

    // A repeated retry stays idempotent instead of publishing a second object.
    const repeated = await coordinator.upload(ownerId, key, body);
    assert.equal(repeated.objectVersion, retried.objectVersion);
    assert.equal(await published(), 1);
    assert.equal((await database.unpublished()).length, 1);
  } finally {
    storage.close();
  }
  console.log('crash before publication: no partial object, temporary reclaimed, retry converged');

  // Phase two: the publisher dies after the queue accepts the message but
  // before the outbox row is acknowledged, so the work must not be lost.
  const queueName = `crash-search-${randomUUID()}`;
  const queue = new LocalQueue(process.env.LOCAL_AWS_ENDPOINT!);
  await queue.initialize(queueName);
  try {
    const search = await database.createSearch(ownerId, `crash-${randomUUID()}`, {
      query: 'React',
      sources: ['remoteok'],
    });
    const publisher = await killAtPause('publish', { CRASH_QUEUE_NAME: queueName });
    publisher.kill('SIGKILL');
    await new Promise((resolve) => publisher.once('exit', resolve));

    // The message is really queued, yet the outbox still owes an acknowledgement.
    assert.deepEqual(await queue.depth(), { ready: 1, inFlight: 0, deadLetter: 0 });
    const owed = await database.unpublished(['search.collect']);
    assert.equal(owed.length, 1);
    assert.equal(owed[0]!.command.aggregateId, search.id);

    // Restarting the publisher re-sends rather than losing the work.
    assert.equal(await publishPending(database, { 'search.collect': queue }), 1);
    assert.equal((await database.unpublished(['search.collect'])).length, 0);
    assert.deepEqual(await queue.depth(), { ready: 2, inFlight: 0, deadLetter: 0 });

    // Fencing must collapse the duplicate into exactly one execution and result.
    const outcomes: string[] = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const message = await queue.receive(AbortSignal.timeout(15000), 1);
      assert.ok(message);
      outcomes.push(
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
                  fingerprint: `crash-${command.aggregateId}`,
                  title: 'React engineer',
                  company: 'Synthetic Systems',
                  location: 'Remote',
                  description: 'Deterministic crash fixture',
                  source: 'remoteok' as const,
                  sourceUrl: 'https://remoteok.com/remote-jobs/crash',
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
            return true;
          },
          AbortSignal.timeout(30000),
        ),
      );
    }
    assert.deepEqual(outcomes.sort(), ['completed', 'duplicate']);
    const jobs = await database.pool.query('SELECT id FROM search_jobs WHERE run_id = $1', [
      search.id,
    ]);
    assert.equal(jobs.rowCount, 1);
    const settled = await database.pool.query<{ type: string }>(
      "SELECT type FROM run_events WHERE run_id = $1 AND type <> 'SearchQueued'",
      [search.id],
    );
    assert.equal(settled.rowCount, 1);
    assert.equal(settled.rows[0]!.type, 'SearchCompleted');
    assert.deepEqual(await queue.depth(), { ready: 0, inFlight: 0, deadLetter: 0 });
    console.log('crash after queue publish: outbox work retained, duplicate collapsed to one run');

    // Phase four: a worker dies holding a valid lease mid-execution.
    const leased = await database.createSearch(ownerId, `lease-${randomUUID()}`, {
      query: 'React',
      sources: ['remoteok'],
    });
    assert.equal(await publishPending(database, { 'search.collect': queue }), 1);
    const worker = await killAtPause('consume', { CRASH_QUEUE_NAME: queueName });
    worker.kill('SIGKILL');
    await new Promise((resolve) => worker.once('exit', resolve));

    const leasedCommand = (await database.command(await commandIdFor(leased.id)))!;
    const held = await database.pool.query<{ status: string; fence: number; live: boolean }>(
      'SELECT status, fence, lease_until > now() AS live FROM command_executions WHERE id = $1',
      [leasedCommand.id],
    );
    assert.equal(held.rows[0]?.status, 'running');
    assert.equal(held.rows[0]?.fence, 1);
    assert.equal(held.rows[0]?.live, true);

    // While the lease is live no other worker may take the work.
    assert.equal(await database.claim(leasedCommand.id), null);

    // After expiry the work is reclaimed under a higher fence.
    await database.pool.query('UPDATE command_executions SET lease_until = now() WHERE id = $1', [
      leasedCommand.id,
    ]);
    const fence = await database.claim(leasedCommand.id);
    assert.equal(fence, 2);

    // The dead worker's stale fence must never be able to settle the run.
    assert.equal(await database.complete(leasedCommand, 1), false);
    assert.equal(await database.complete(leasedCommand, fence!), true);
    const settledLease = await database.pool.query(
      "SELECT type FROM run_events WHERE run_id = $1 AND type <> 'SearchQueued'",
      [leased.id],
    );
    assert.equal(settledLease.rowCount, 1);
    console.log(
      'crash holding a lease: no concurrent claim, stale fence rejected, run settled once',
    );
  } finally {
    queue.close();
  }

  // Phase three: the object is genuinely published, then the writer dies before
  // the database records the version. Filesystem and database now disagree.
  const split = await killAtPause('upload', {
    CRASH_STORAGE_DIRECTORY: objects,
    CRASH_STORAGE_KEY: encryptionKey,
    CRASH_OWNER_ID: ownerId,
    CRASH_UPLOAD_KEY: 'crash-split-fixture',
    CRASH_PUBLISH: 'true',
  });
  split.kill('SIGKILL');
  await new Promise((resolve) => split.once('exit', resolve));

  const splitRow = await uploads.get(ownerId, await uploadIdFor('crash-split-fixture'));
  assert.ok(splitRow);
  assert.equal(splitRow.status, 'uploading');
  assert.equal(splitRow.objectVersion, null);
  assert.equal(await published(), 2);
  assert.equal(await pending(), 1);

  const recovery = new PrivateFileResumeStorage({ directory: objects, encryptionKey });
  await recovery.initialize();
  try {
    // The stranded alias points at a real object, so reclaiming it must not destroy it.
    assert.equal((await recovery.reclaimTemporariesAtStartup()).removed, 1);
    assert.equal(await pending(), 0);
    assert.equal(await published(), 2);

    // Reconciliation must adopt the object that really exists rather than lose it.
    const adopted = await new ResumeUploadCoordinator(uploads, recovery).reconcile(
      ownerId,
      splitRow.id,
    );
    assert.equal(adopted?.status, 'queued');
    assert.ok(adopted?.objectVersion);
    assert.deepEqual(await recovery.get(await objectFor(splitRow.id), adopted.objectVersion), body);
    assert.equal(await published(), 2);
    const commands = await database.pool.query(
      "SELECT id FROM outbox_events WHERE command->>'aggregateId' = $1",
      [splitRow.id],
    );
    assert.equal(commands.rowCount, 1);
    assert.equal((await recovery.inventory()).reservedBytes, 0);
  } finally {
    recovery.close();
  }
  console.log('crash during publication: orphaned object adopted, no duplicate, alias reclaimed');
} finally {
  await database.close();
  await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin.close();
  await rm(directory, { recursive: true, force: true });
}

async function objectFor(id: string) {
  const record = await uploads.get(ownerId, id);
  assert.ok(record);
  return {
    ownerId: record.ownerId,
    resumeId: record.id,
    sha256: record.sha256,
    bytes: record.bytes,
    contentType: record.contentType,
  };
}

async function commandIdFor(runId: string) {
  const row = await database.pool.query<{ id: string }>(
    "SELECT id FROM outbox_events WHERE command->>'aggregateId' = $1",
    [runId],
  );
  assert.equal(row.rowCount, 1);
  return row.rows[0]!.id;
}

async function uploadIdFor(uploadKey: string) {
  const row = await database.pool.query<{ id: string }>(
    'SELECT id FROM resume_uploads WHERE owner_id = $1 AND idempotency_key = $2',
    [ownerId, uploadKey],
  );
  assert.equal(row.rowCount, 1);
  return row.rows[0]!.id;
}

/** Runs a child in the given crash mode and returns it stalled at the kill point. */
async function killAtPause(mode: 'upload' | 'publish', env: Record<string, string>) {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', fileURLToPath(import.meta.url), '--child'],
    {
      env: { ...process.env, ...env, CRASH_MODE: mode, CRASH_DATABASE_URL: url.href },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    },
  );
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`${mode} never reached its kill point`)),
      60000,
    );
    child.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error(`${mode} process exited before its kill point`));
    });
    child.on('message', (message: { paused?: boolean }) => {
      if (!message.paused) return;
      clearTimeout(timeout);
      resolve();
    });
  });
  return child;
}
