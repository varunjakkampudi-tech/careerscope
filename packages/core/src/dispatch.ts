/**
 * Moves commands between the database outbox and the queue: `publishPending` sends, and
 * `consumeMessage` runs a delivered message under a lease. Used by the publisher and search worker entry points.
 */

import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { commandSchema, retryDelay, type Command } from './commands.js';
import type { Database } from './database.js';
import { logFailure } from './failure.js';
import { logger } from './runtime.js';
import type { LocalQueue, QueueMessage as Message } from './queue.js';

/** Executes one command. `fence` identifies the attempt; return true only after the result is durably committed. */
export type Handler = (command: Command, fence: number, signal: AbortSignal) => Promise<boolean>;
/** Queue to use for each command type; types without a route are not published. */
export type QueueRoutes = Partial<Record<Command['type'], Pick<LocalQueue, 'send'>>>;

/**
 * Sends unpublished outbox commands (see `Database.unpublished`) and marks each published after the
 * send. A crash between the two repeats the send, which is safe because consumers de-duplicate with fences.
 * Returns how many were published.
 */
export async function publishPending(database: Database, queues: QueueRoutes) {
  let published = 0;
  const types = (Object.keys(queues) as Command['type'][]).filter((type) => queues[type]);
  for (const record of await database.unpublished(types)) {
    const command = commandSchema.parse(record.command);
    const queue = queues[command.type];
    if (!queue) continue;
    await queue.send(command);
    await database.published(command.id);
    published += 1;
  }
  return published;
}

/**
 * Processes one delivered message. It checks the message against the stored command, claims a lease,
 * heartbeats while the handler runs, then acknowledges on durable completion. Returns `completed`,
 * `duplicate`, `busy`, `failed` or `interrupted`. After repeated attempts the command is failed
 * (dead-lettered); otherwise the lease is released and the message becomes visible again after a backoff delay.
 */
export async function consumeMessage(
  database: Database,
  queue: LocalQueue,
  message: Message,
  type: Command['type'],
  handler: Handler,
  shutdown: AbortSignal,
  fail: (command: Command, fence: number) => Promise<boolean> = (command, fence) =>
    database.fail(command, fence),
) {
  const receipt = message.ReceiptHandle;
  if (!receipt) throw new Error('Queue message has no receipt');
  let decoded: unknown;
  try {
    decoded = JSON.parse(message.Body ?? '');
  } catch {
    throw new Error('Invalid queue message');
  }
  const command = commandSchema.parse(decoded);
  const stored = await database.command(command.id);
  if (command.type !== type || !stored || !isDeepStrictEqual(command, stored)) {
    throw new Error('Queue message does not match a durable command');
  }
  if (shutdown.aborted) return 'interrupted';
  const fence = await database.claim(command.id);
  if (fence === null) {
    if ((await database.executionStatus(command.id)) === 'completed') {
      await queue.acknowledge(receipt);
      return 'duplicate';
    }
    if ((await database.executionStatus(command.id)) === 'failed') return 'failed';
    return 'busy';
  }
  // Fence counts attempts, so more than five claims means the command has used its retry budget.
  if (fence > 5) {
    await fail(command, fence);
    return 'failed';
  }
  const control = new AbortController();
  const heartbeatStop = new AbortController();
  const signal = AbortSignal.any([shutdown, control.signal]);
  let heartbeatFailed = false;
  // Lease is 60 s and renewed every 15 s with the queue visibility, so one slow renewal does not lose the lease.
  const heartbeat = async () => {
    try {
      while (!heartbeatStop.signal.aborted) {
        await delay(15_000, undefined, { signal: heartbeatStop.signal });
        if (!(await database.renew(command.id, fence))) throw new Error('Command lease lost');
        await queue.visibility(receipt, 60);
      }
    } catch (error) {
      if (!heartbeatStop.signal.aborted) {
        logFailure(
          error,
          {
            commandId: command.id,
            executionId: command.id,
            fence,
            attempt: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
          },
          'Command heartbeat failed',
        );
        heartbeatFailed = true;
        control.abort(new Error('Command heartbeat failed'));
      }
    }
  };
  const renewing = heartbeat();
  const startedAt = performance.now();
  // Completes the requestId -> runId -> executionId -> attempt chain.
  const settled = (outcome: string) =>
    logger.info(
      {
        executionId: command.id,
        runId: command.aggregateId,
        jobType: command.type,
        attempt: Number(message.Attributes?.ApproximateReceiveCount ?? 1),
        fence,
        outcome,
        durationMs: Math.round(performance.now() - startedAt),
      },
      'Command execution settled',
    );
  try {
    const committed = await handler(command, fence, signal);
    if (!committed) throw new Error('Command result was not committed');
    if ((await database.executionStatus(command.id)) !== 'completed') {
      throw new Error('Handler returned without durable completion');
    }
    await queue.acknowledge(receipt);
    settled('completed');
    return 'completed';
  } catch (error) {
    const count = Number(message.Attributes?.ApproximateReceiveCount ?? 1);
    logFailure(
      error,
      { commandId: command.id, executionId: command.id, fence, attempt: count },
      'Command execution failed',
    );
    if ((fence >= 5 || count >= 5) && !shutdown.aborted && !heartbeatFailed) {
      await fail(command, fence);
      settled('dead-lettered');
    } else {
      await database.release(command.id, fence);
      settled('released');
    }
    await queue.visibility(
      receipt,
      Math.max(1, Math.ceil(retryDelay(Number.isInteger(count) && count > 0 ? count : 1) / 1000)),
    );
    throw error;
  } finally {
    heartbeatStop.abort();
    control.abort();
    await renewing;
    if (heartbeatFailed) await database.release(command.id, fence);
  }
}

/** Marks a dead-lettered command failed in the database, if it matches a stored command and nobody else holds its lease. */
export async function reconcileDeadLetter(
  database: Database,
  message: Message,
  type: Command['type'] = 'search.collect',
  fail: (command: Command, fence: number) => Promise<boolean> = (command, fence) =>
    database.fail(command, fence),
) {
  const command = commandSchema.parse(JSON.parse(message.Body ?? ''));
  const stored = await database.command(command.id);
  if (!stored || !isDeepStrictEqual(stored, command) || command.type !== type) {
    throw new Error('Dead letter does not match a supported durable command');
  }
  const fence = await database.claim(command.id);
  if (fence !== null) return fail(command, fence);
  return false;
}
