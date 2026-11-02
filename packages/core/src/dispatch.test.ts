import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { Command } from './commands.js';
import type { Database } from './database.js';
import { consumeMessage } from './dispatch.js';
import type { LocalQueue } from './queue.js';

// A handler error must reach the caller even when handing the message back to the queue also fails
// (S1-F011). The queue and database are fakes, so only the error path is exercised.
test('the handler error survives a failed queue hand-back', async () => {
  const command: Command = {
    id: randomUUID(),
    type: 'search.collect',
    version: 1,
    aggregateId: randomUUID(),
    ownerId: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId: randomUUID(),
  };
  const database = {
    command: async () => command,
    claim: async () => 1,
    executionStatus: async () => 'running',
    release: async () => true,
    fail: async () => true,
  } as unknown as Database;
  const queue = {
    acknowledge: async () => undefined,
    visibility: async () => {
      throw new Error('Queue lease lost');
    },
  } as unknown as LocalQueue;
  const message = {
    ReceiptHandle: randomUUID(),
    Body: JSON.stringify(command),
    Attributes: { ApproximateReceiveCount: '1' },
  };
  await assert.rejects(
    consumeMessage(
      database,
      queue,
      message,
      'search.collect',
      async () => {
        throw new Error('handler exploded');
      },
      new AbortController().signal,
    ),
    (error: Error) => error.message === 'handler exploded',
  );
});
