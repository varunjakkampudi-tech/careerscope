/**
 * Redis queue transport (`LocalQueue`) used by the publisher and search worker when
 * `SEARCH_QUEUE_TRANSPORT=redis`. Commands come from `commands.ts`; the Redis endpoint must be a
 * private loopback instance.
 */

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Job, Queue, Worker } from 'bullmq';
import { commandSchema, type Command } from './commands.js';
import { logFailure } from './failure.js';

/** Message envelope with SQS-style field names; `ApproximateReceiveCount` is the BullMQ attempt count. */
export type QueueMessage = {
  MessageId?: string;
  ReceiptHandle?: string;
  Body?: string;
  Attributes?: { ApproximateReceiveCount?: string };
};

/** Accepts only a loopback `redis://` URL with an optional password and no username, query, fragment or non-zero database, so queue traffic cannot leave the host. */
export function localEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1'].includes(url.hostname) ||
    url.username ||
    url.search ||
    url.hash ||
    !['', '/', '/0'].includes(url.pathname)
  ) {
    throw new Error('Queue Redis must use an isolated loopback endpoint');
  }
  return value;
}

/**
 * Redis-backed queue (BullMQ) with SQS-style receive, acknowledge and visibility calls. It is only
 * the transport: delivery is at-least-once, and the database fence in `database.ts` decides which
 * attempt may apply effects.
 */
export class LocalQueue {
  private queue?: Queue<Command>;
  private worker?: Worker<Command>;
  private readonly deliveries = new Map<string, Job<Command>>();
  private readonly leaseExpiries = new Map<string, number>();
  private deadLetterCursor = 0;

  constructor(readonly endpoint: string) {
    localEndpoint(endpoint);
  }

  /**
   * Connects and verifies that Redis uses `noeviction` and AOF persistence, so queued commands cannot
   * be evicted or lost on restart. The worker is created with `autorun: false` because `receive` pulls jobs manually.
   */
  async initialize(name: string) {
    if (this.queue) throw new Error('Queue is already initialized');
    if (!/^[a-z][a-z0-9-]{0,99}$/.test(name)) throw new Error('Invalid queue name');
    const url = new URL(this.endpoint);
    // Short timeouts and one retry per request so a Redis outage fails calls quickly instead of hanging them.
    const connection = {
      host: url.hostname,
      port: Number(url.port || 6379),
      connectTimeout: 3000,
      commandTimeout: 10_000,
      maxRetriesPerRequest: 1,
    };
    this.queue = new Queue<Command>(name, {
      connection,
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: { age: 1209600, count: 1000 },
      },
    });
    this.queue.on('error', (error) => logFailure(error, {}, 'Queue Redis operation failed'));
    try {
      const client = await this.queue.waitUntilReady();
      const info = await client.info();
      if (!/^maxmemory_policy:noeviction\r?$/m.test(info) || !/^aof_enabled:1\r?$/m.test(info)) {
        throw new Error('Queue Redis requires noeviction and AOF persistence');
      }
      this.worker = new Worker<Command>(name, null, {
        connection: { ...connection, maxRetriesPerRequest: null },
        autorun: false,
        lockDuration: 60_000,
        stalledInterval: 15_000,
        maxStalledCount: 5,
      });
      this.worker.on('error', (error) => logFailure(error, {}, 'Queue Redis delivery failed'));
      await this.worker.waitUntilReady();
      await this.worker.startStalledCheckTimer();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  private ready() {
    if (!this.queue || !this.worker) throw new Error('Queue is not initialized');
    return { queue: this.queue, worker: this.worker };
  }

  /** Validates the command against `commandSchema` and enqueues it; the job type is the command type. */
  async send(command: Command) {
    const { queue } = this.ready();
    await queue.add(command.type, commandSchema.parse(command));
  }

  /**
   * Long-polls up to `waitSeconds` for one job and returns it with a receipt. The local lease is 60
   * seconds. A job already started more than five times is moved to failed (dead letter) instead of returned.
   */
  async receive(signal?: AbortSignal, waitSeconds = 10): Promise<QueueMessage | undefined> {
    for (const [receipt, expiry] of this.leaseExpiries) {
      if (expiry <= Date.now()) {
        this.deliveries.delete(receipt);
        this.leaseExpiries.delete(receipt);
      }
    }
    const { worker } = this.ready();
    const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
    do {
      signal?.throwIfAborted();
      const receipt = randomUUID();
      const job = await worker.getNextJob(receipt, { block: false });
      if (job) {
        if (job.attemptsStarted > 5) {
          await job.moveToFailed(new Error('Delivery attempt budget exhausted'), receipt, false);
          continue;
        }
        this.deliveries.set(receipt, job);
        this.leaseExpiries.set(receipt, Date.now() + 60_000);
        return {
          MessageId: job.id,
          ReceiptHandle: receipt,
          Body: JSON.stringify(job.data),
          Attributes: { ApproximateReceiveCount: String(job.attemptsStarted) },
        };
      }
      if (Date.now() >= deadline) return undefined;
      await delay(Math.min(100, deadline - Date.now()), undefined, { signal });
    } while (Date.now() <= deadline);
    return undefined;
  }

  /** Marks the delivery completed. Throws for an unknown or expired receipt, so a stale worker cannot ack. */
  async acknowledge(receipt: string) {
    const job = this.deliveries.get(receipt);
    if (!job) throw new Error('Unknown or stale queue receipt');
    await job.moveToCompleted(null, receipt, false);
    this.deliveries.delete(receipt);
    this.leaseExpiries.delete(receipt);
  }

  /**
   * Changes how long this delivery stays leased. `0` hands it back immediately; otherwise the lock is
   * extended and `Queue lease lost` is thrown if BullMQ no longer holds it for this worker.
   */
  async visibility(receipt: string, seconds: number) {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600)
      throw new Error('Invalid lease duration');
    const job = this.deliveries.get(receipt);
    if (!job) throw new Error('Unknown or stale queue receipt');
    if (seconds === 0) {
      await job.moveToDelayed(Date.now(), receipt);
      this.deliveries.delete(receipt);
      this.leaseExpiries.delete(receipt);
    } else if (!(await job.extendLock(receipt, seconds * 1000))) {
      this.deliveries.delete(receipt);
      this.leaseExpiries.delete(receipt);
      throw new Error('Queue lease lost');
    } else {
      this.leaseExpiries.set(receipt, Date.now() + seconds * 1000);
    }
  }

  /** Counts for monitoring: ready (waiting or delayed), in flight and dead-lettered (failed). */
  async depth() {
    const counts = await this.ready().queue.getJobCounts('wait', 'delayed', 'active', 'failed');
    return {
      ready: (counts.wait ?? 0) + (counts.delayed ?? 0),
      inFlight: counts.active ?? 0,
      deadLetter: counts.failed ?? 0,
    };
  }

  /** Returns failed jobs one at a time in rotation, so repeated calls walk the whole dead-letter set. */
  async receiveDeadLetter(): Promise<QueueMessage | undefined> {
    const { queue } = this.ready();
    const failed = await queue.getFailedCount();
    if (!failed) {
      this.deadLetterCursor = 0;
      return undefined;
    }
    const index = this.deadLetterCursor % failed;
    this.deadLetterCursor = (index + 1) % failed;
    const [job] = await queue.getFailed(index, index);
    return job ? { MessageId: job.id, Body: JSON.stringify(job.data) } : undefined;
  }

  /** Deletes the queue and all its jobs. For tests and teardown scripts only. */
  async destroy() {
    const { queue } = this.ready();
    await this.worker?.close(true);
    await queue.obliterate({ force: true });
  }

  /** Closes the worker and queue and forgets in-memory deliveries. */
  async close() {
    await this.worker?.close(true);
    await this.queue?.close();
    this.deliveries.clear();
    this.leaseExpiries.clear();
  }
}
