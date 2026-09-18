import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database, BullSearchQueue, users } from '@careerscope/core';

const execute = promisify(execFile);
const image = 'redis:7.4.5-alpine';

async function docker(...args: string[]) {
  const result = await execute('docker', args, { timeout: 30_000, maxBuffer: 256_000 });
  return result.stdout.trim();
}

async function until(check: () => Promise<boolean>, label: string, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    assert.equal(child.exitCode, 0, 'Runtime process exited unsuccessfully');
    return;
  }
  const exit = once(child, 'exit');
  if (process.platform === 'win32') child.send('shutdown');
  else child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const [code, signal] = await exit;
    assert.equal(signal, null, 'Runtime required forced termination');
    assert.equal(code, 0, 'Runtime shutdown failed');
  } finally {
    clearTimeout(timer);
  }
}

function runtimeArguments(entry: URL) {
  if (process.platform !== 'win32') return [fileURLToPath(entry)];
  return [
    '--input-type=module',
    '-e',
    `process.on('message', message => {
      if (message === 'shutdown') {
        process.disconnect();
        process.emit('SIGTERM');
      }
    });
    await import(${JSON.stringify(entry.href)});`,
  ];
}

test(
  'isolated Redis restart, AOF restore and real queue process lifecycle',
  { timeout: 120_000 },
  async () => {
    const configured = process.env.DATABASE_URL;
    assert.ok(configured);
    const databaseUrl = new URL(configured);
    assert.ok(['localhost', '127.0.0.1'].includes(databaseUrl.hostname));
    const suffix = randomUUID().replaceAll('-', '');
    const container = `careerscope-test-${suffix}`;
    const restored = `${container}-restored`;
    const volume = `${container}-data`;
    const copied = `${container}-copy`;
    const copyContainer = `${container}-copying`;
    const name = `test_${suffix}`;
    const admin = new Database(configured);
    let database: Database | undefined;
    let queue: BullSearchQueue | undefined;
    let publisher: ChildProcess | undefined;
    let worker: ChildProcess | undefined;
    let databaseCreated = false;
    const cleanupErrors: unknown[] = [];
    const volumes: string[] = [];
    const containers: string[] = [];
    const startRedis = async (id: string, data: string) => {
      containers.push(id);
      await docker(
        'run',
        '-d',
        '--name',
        id,
        '--label',
        'careerscope.test=queue-runtime',
        '--memory',
        '256m',
        '--cpus',
        '1',
        '-p',
        '127.0.0.1::6379',
        '-v',
        `${data}:/data`,
        image,
        'redis-server',
        '--appendonly',
        'yes',
        '--appendfsync',
        'everysec',
        '--maxmemory',
        '128mb',
        '--maxmemory-policy',
        'noeviction',
      );
      await until(
        async () => (await docker('exec', id, 'redis-cli', 'ping')) === 'PONG',
        'Redis readiness',
      );
      const binding = await docker('port', id, '6379/tcp');
      assert.match(binding, /^127\.0\.0\.1:\d+$/);
      return `redis://${binding}`;
    };
    try {
      await docker('image', 'inspect', image, '--format', '{{.Id}}');
      for (const entry of [volume, copied]) {
        await docker('volume', 'create', '--label', 'careerscope.test=queue-runtime', entry);
        volumes.push(entry);
      }
      await admin.pool.query(`CREATE DATABASE "${name}"`);
      databaseCreated = true;
      databaseUrl.pathname = `/${name}`;
      database = new Database(databaseUrl.href);
      await migrate(database.db, {
        migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url)),
      });
      const ownerId = randomUUID();
      await database.db
        .insert(users)
        .values({ id: ownerId, email: `${ownerId}@example.test`, passwordHash: 'synthetic' });
      await database.createSearch(ownerId, 'runtime-fixture', {
        query: 'React',
        sources: ['remoteok'],
      });
      const command = (await database.unpublished())[0]!.command;
      const endpoint = await startRedis(container, volume);
      queue = new BullSearchQueue(database, endpoint);
      await queue.initialize();
      const env = {
        ...process.env,
        DATABASE_URL: databaseUrl.href,
        SEARCH_QUEUE_TRANSPORT: 'bullmq',
        SEARCH_QUEUE_REDIS_URL: endpoint,
        RESUME_STORAGE_DIRECTORY: undefined,
        RESUME_STORAGE_KEY_FILE: undefined,
      };
      publisher = spawn(
        process.execPath,
        runtimeArguments(new URL('../apps/workers/search/dist/publisher.js', import.meta.url)),
        { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
      );
      publisher.stdout?.resume();
      publisher.stderr?.resume();
      await until(async () => Boolean(await queue!.queue.getJob(command.id)), 'publisher delivery');
      await until(
        async () => (await database!.unpublished()).length === 0,
        'publication committed',
      );
      await stop(publisher);
      publisher = undefined;
      await queue.close();
      queue = undefined;
      await docker('stop', '--time', '10', container);
      await docker('start', container);
      const restartedBinding = await docker('port', container, '6379/tcp');
      assert.match(restartedBinding, /^127\.0\.0\.1:\d+$/);
      queue = new BullSearchQueue(database, `redis://${restartedBinding}`);
      await queue.initialize();
      assert.deepEqual((await queue.queue.getJob(command.id))?.data, command);
      await queue.close();
      queue = undefined;
      await docker('stop', '--time', '10', container);
      containers.push(copyContainer);
      await docker(
        'run',
        '--name',
        copyContainer,
        '--network',
        'none',
        '-v',
        `${volume}:/source:ro`,
        '-v',
        `${copied}:/target`,
        image,
        'cp',
        '-a',
        '/source/.',
        '/target/',
      );
      const restoredEndpoint = await startRedis(restored, copied);
      queue = new BullSearchQueue(database, restoredEndpoint);
      await queue.initialize();
      assert.deepEqual((await queue.queue.getJob(command.id))?.data, command);
      const fence = await database.claim(command.id);
      assert.ok(fence);
      assert.equal(await database.complete(command, fence), true);
      worker = spawn(
        process.execPath,
        runtimeArguments(new URL('../apps/workers/search/dist/main.js', import.meta.url)),
        {
          env: { ...env, SEARCH_QUEUE_REDIS_URL: restoredEndpoint },
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      worker.stdout?.resume();
      worker.stderr?.resume();
      await until(
        async () =>
          (await queue!.queue.getJob(command.id))
            ?.getState()
            .then((state) => state === 'completed') ?? false,
        'real worker acknowledges completed duplicate',
      );
      await stop(worker);
      worker = undefined;
      assert.equal(
        (
          await database.pool.query(
            "SELECT id FROM run_events WHERE run_id = $1 AND type = 'SearchCompleted'",
            [command.aggregateId],
          )
        ).rowCount,
        1,
      );
      await queue.close();
      queue = undefined;
      await docker('stop', '--time', '10', restored);
      queue = new BullSearchQueue(database, restoredEndpoint, 'unavailable-test', () => {});
      const startup = Date.now();
      await assert.rejects(queue.initialize(), /startup timed out/);
      assert.ok(Date.now() - startup < 15_000, 'Unavailable Redis startup must be bounded');
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      const clean = async (action: () => Promise<unknown>) => {
        try {
          await action();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };
      if (worker) await clean(() => stop(worker!));
      if (publisher) await clean(() => stop(publisher!));
      if (queue) await clean(() => queue!.close());
      if (database) await clean(() => database!.close());
      if (databaseCreated) await clean(() => admin.pool.query(`DROP DATABASE "${name}"`));
      await clean(() => admin.close());
      for (const id of containers.reverse()) await clean(() => docker('rm', '-f', id));
      for (const id of volumes.reverse()) await clean(() => docker('volume', 'rm', id));
    }
    if (cleanupErrors.length)
      throw new AggregateError(cleanupErrors, 'Runtime acceptance or fixture cleanup failed');
  },
);
