import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { Queue, Worker, DelayedError, UnrecoverableError } from 'bullmq';
import { commandSchema, retryDelay, type Command } from './commands.js';
import type { Database } from './database.js';
import type { Handler } from './dispatch.js';
import { logger } from './runtime.js';

export function queueConnection(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'redis:' ||
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/', '/0'].includes(url.pathname)
  ) {
    throw new Error('Queue Redis must use an isolated local endpoint');
  }
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    connectTimeout: 3000,
    commandTimeout: 10_000,
    maxRetriesPerRequest: 1,
    retryStrategy: (attempt: number) => Math.min(1000, attempt * 200),
  };
}

export async function executeBullCommand(
  database: Database,
  input: unknown,
  handler: Handler,
  shutdown: AbortSignal,
) {
  const parsed = commandSchema.safeParse(input);
  if (!parsed.success || parsed.data.type !== 'search.collect') {
    throw new UnrecoverableError('Unsupported queue command');
  }
  const command = parsed.data;
  const stored = await database.command(command.id);
  if (!stored || !isDeepStrictEqual(stored, command)) {
    throw new UnrecoverableError('Queue command does not match durable state');
  }
  shutdown.throwIfAborted();
  const fence = await database.claim(command.id);
  if (fence === null) {
    const state = await database.executionStatus(command.id);
    if (state === 'completed') return 'duplicate';
    if (state === 'failed') throw new UnrecoverableError('Command failed permanently');
    return 'busy';
  }
  if (fence > 5) {
    if (!(await database.fail(command, fence))) throw new Error('Command lease lost');
    throw new UnrecoverableError('Command attempt budget exhausted');
  }
  const stop = new AbortController();
  const control = new AbortController();
  const signal = AbortSignal.any([shutdown, control.signal]);
  const renewing = (async () => {
    try {
      while (!stop.signal.aborted) {
        await delay(15_000, undefined, { signal: stop.signal });
        if (!(await database.renew(command.id, fence))) throw new Error('Command lease lost');
      }
    } catch {
      if (!stop.signal.aborted) control.abort(new Error('Command heartbeat failed'));
    }
  })();
  try {
    const committed = await handler(command, fence, signal);
    if (!committed || (await database.executionStatus(command.id)) !== 'completed') {
      throw new Error('Command completion missing');
    }
    return 'completed';
  } catch {
    if ((await database.executionStatus(command.id)) === 'completed') return 'duplicate';
    if (fence >= 5 && !signal.aborted && (await database.fail(command, fence))) {
      throw new UnrecoverableError('Command attempt budget exhausted');
    }
    throw new Error(signal.aborted ? 'Command interrupted' : 'Command execution failed');
  } finally {
    stop.abort();
    control.abort();
    await renewing;
    await database.release(command.id, fence);
  }
}

export class BullSearchQueue {
  readonly queue;
  private readonly connection;

  constructor(
    private readonly database: Database,
    url: string,
    readonly name = 'careerscope-v2-search',
    private readonly reportError: () => void = () => logger.error('Queue Redis operation failed'),
  ) {
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(name)) throw new Error('Invalid queue name');
    this.connection = queueConnection(url);
    this.queue = new Queue<Command>(name, {
      connection: this.connection,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'durable' },
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: { age: 604800, count: 1000 },
      },
    });
    this.queue.on('error', this.reportError);
  }

  async initialize() {
    const deadline = new AbortController();
    try {
      await Promise.race([
        (async () => {
          const client = await this.queue.waitUntilReady();
          const info = await client.info();
          if (
            !/^maxmemory_policy:noeviction\r?$/m.test(info) ||
            !/^aof_enabled:1\r?$/m.test(info)
          ) {
            throw new Error('Queue Redis requires noeviction and AOF persistence');
          }
        })(),
        delay(10_000, undefined, { signal: deadline.signal }).then(() => {
          throw new Error('Queue Redis startup timed out');
        }),
      ]);
    } catch (error) {
      await this.queue.close();
      throw error;
    } finally {
      deadline.abort();
    }
  }

  async send(input: Command) {
    const command = commandSchema.parse(input);
    if (
      command.type !== 'search.collect' ||
      !isDeepStrictEqual(await this.database.command(command.id), command)
    ) {
      throw new Error('Unsupported durable command');
    }
    const state = await this.database.executionStatus(command.id);
    if (state === 'completed' || state === 'failed') return;
    const existing = await this.queue.getJob(command.id);
    if (existing) {
      if (!isDeepStrictEqual(existing.data, command)) throw new Error('Queue data mismatch');
      const transportState = await existing.getState();
      if (transportState === 'completed' || transportState === 'failed') {
        await existing.retry(transportState);
      }
      return;
    }
    await this.queue.add(command.type, command, { jobId: command.id });
  }

  worker(handler: Handler, shutdown: AbortSignal) {
    const worker = new Worker<Command>(
      this.name,
      async (job, token, lockSignal) => {
        try {
          const signal = lockSignal ? AbortSignal.any([shutdown, lockSignal]) : shutdown;
          const result = await executeBullCommand(this.database, job.data, handler, signal);
          if (result === 'busy') {
            await job.moveToDelayed(Date.now() + 1000, token);
            throw new DelayedError();
          }
          return result;
        } catch (error) {
          if (error instanceof UnrecoverableError || error instanceof DelayedError) throw error;
        }
        throw new Error('Queue execution interrupted or failed');
      },
      {
        connection: { ...this.connection, maxRetriesPerRequest: null },
        concurrency: 1,
        lockDuration: 60_000,
        maxStalledCount: 1,
        settings: { backoffStrategy: (attempt) => Math.max(100, retryDelay(attempt)) },
      },
    );
    worker.on('error', () => {
      worker.cancelAllJobs('Queue connection failed');
      this.reportError();
    });
    worker.on('lockRenewalFailed', (ids) => {
      for (const id of ids) worker.cancelJob(id, 'Queue lock lost');
      this.reportError();
    });
    return worker;
  }

  async close() {
    await this.queue.close();
  }
}
