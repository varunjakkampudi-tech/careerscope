import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { commandSchema, type Command } from './commands.js';
import { LocalQueue, localEndpoint } from './queue.js';

test('queue endpoints cannot select cloud or arbitrary hosts', () => {
  for (const value of [
    'https://queue.example.invalid',
    'http://example.com',
    'http://local:secret@localhost',
    'http://localhost/path',
  ]) {
    assert.throws(() => localEndpoint(value));
  }
  assert.equal(localEndpoint('redis://127.0.0.1:56480'), 'redis://127.0.0.1:56480');
});

test('local queue redelivery, acknowledgement and persistence', async () => {
  const endpoint = process.env.QUEUE_REDIS_URL;
  assert.ok(endpoint, 'Integration tests require QUEUE_REDIS_URL');
  const queue = new LocalQueue(endpoint);
  try {
    await queue.initialize(`test-${randomUUID()}`);
    const command: Command = {
      id: randomUUID(),
      type: 'search.collect',
      version: 1,
      ownerId: randomUUID(),
      aggregateId: randomUUID(),
      correlationId: randomUUID(),
      occurredAt: new Date().toISOString(),
    };
    await queue.send(command);
    const message = await queue.receive(undefined, 1);
    assert.ok(message?.ReceiptHandle);
    assert.deepEqual(commandSchema.parse(JSON.parse(message.Body!)), command);
    await queue.visibility(message.ReceiptHandle, 0);
    const repeated = await queue.receive(undefined, 1);
    assert.ok(repeated?.ReceiptHandle);
    assert.equal(repeated.MessageId, message.MessageId);
    assert.equal(Number(repeated.Attributes?.ApproximateReceiveCount), 2);
    await queue.acknowledge(repeated.ReceiptHandle);
    await assert.rejects(queue.acknowledge(repeated.ReceiptHandle), /stale queue receipt/);
    assert.equal(await queue.receive(undefined, 1), undefined);
  } finally {
    await queue.destroy();
    await queue.close();
  }
});

test('exhausted deliveries enter the DLQ and every failed command remains observable', async () => {
  const endpoint = process.env.QUEUE_REDIS_URL;
  assert.ok(endpoint, 'Integration tests require QUEUE_REDIS_URL');
  const queue = new LocalQueue(endpoint);
  try {
    await queue.initialize(`test-${randomUUID()}`);
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) {
      await queue.send({
        id,
        type: 'search.collect',
        version: 1,
        ownerId: randomUUID(),
        aggregateId: randomUUID(),
        correlationId: randomUUID(),
        occurredAt: new Date().toISOString(),
      });
      for (let attempt = 1; attempt <= 5; attempt++) {
        const message = await queue.receive(undefined, 1);
        assert.ok(message?.ReceiptHandle);
        assert.equal(message.Attributes?.ApproximateReceiveCount, String(attempt));
        await queue.visibility(message.ReceiptHandle, 0);
      }
      assert.equal(await queue.receive(undefined, 0), undefined);
    }
    assert.deepEqual(await queue.depth(), { ready: 0, inFlight: 0, deadLetter: 2 });
    const observed = new Set<string>();
    for (let index = 0; index < 2; index++) {
      const failed = await queue.receiveDeadLetter();
      assert.ok(failed?.Body);
      observed.add(commandSchema.parse(JSON.parse(failed.Body)).id);
    }
    assert.deepEqual(observed, new Set(ids));
  } finally {
    await queue.destroy();
    await queue.close();
  }
});
