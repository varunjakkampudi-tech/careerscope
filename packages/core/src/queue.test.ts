import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { DeleteQueueCommand, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { commandSchema, type Command } from './commands.js';
import { LocalQueue, localEndpoint } from './queue.js';

test('local endpoints cannot select AWS or arbitrary hosts', () => {
  for (const value of [
    'https://sqs.us-east-1.amazonaws.com',
    'http://example.com',
    'http://local:secret@localhost',
    'http://localhost/path',
  ]) {
    assert.throws(() => localEndpoint(value));
  }
  assert.equal(localEndpoint('http://127.0.0.1:54566'), 'http://127.0.0.1:54566');
});

test('local SQS redelivery, acknowledgement and DLQ configuration', async () => {
  const endpoint = process.env.LOCAL_AWS_ENDPOINT;
  assert.ok(endpoint, 'Integration tests require LOCAL_AWS_ENDPOINT');
  const queue = new LocalQueue(endpoint);
  try {
    await queue.initialize(`test-${randomUUID()}`);
    const attributes = await queue.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: queue.url,
        AttributeNames: ['RedrivePolicy'],
      }),
    );
    assert.equal(Number(JSON.parse(attributes.Attributes!.RedrivePolicy!).maxReceiveCount), 5);
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
    assert.equal(await queue.receive(undefined, 1), undefined);
  } finally {
    for (const url of [queue.url, queue.deadLetterUrl].filter(Boolean)) {
      await queue.client.send(new DeleteQueueCommand({ QueueUrl: url }));
    }
    queue.close();
  }
});
