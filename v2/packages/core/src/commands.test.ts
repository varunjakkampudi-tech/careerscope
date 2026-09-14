import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { commandSchema, createSearchSchema, retryDelay } from './commands.ts';

test('commands contain identifiers, not private source text or arbitrary payloads', () => {
  const command = {
    id: randomUUID(),
    type: 'search.collect',
    version: 1,
    aggregateId: randomUUID(),
    ownerId: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId: randomUUID(),
  };
  assert.equal(commandSchema.safeParse(command).success, true);
  assert.equal(commandSchema.safeParse({ ...command, resume: 'private' }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, type: 'shell.execute' }).success, false);
  assert.equal(commandSchema.safeParse({ ...command, version: 2 }).success, false);
});

test('search commands only advertise implemented providers', () => {
  assert.deepEqual(
    createSearchSchema.parse({ query: 'React', sources: ['remoteok', 'himalayas'] }).sources,
    ['himalayas', 'remoteok'],
  );
  for (const sources of [[], ['remoteok', 'remoteok'], ['remotive']]) {
    assert.equal(createSearchSchema.safeParse({ query: 'React', sources }).success, false);
  }
  assert.deepEqual(createSearchSchema.parse({ query: ' React ', sources: ['remoteok'] }), {
    query: 'React',
    sources: ['remoteok'],
  });
  assert.equal(
    createSearchSchema.safeParse({ query: 'React', sources: ['unknown'] }).success,
    false,
  );
});

test('retry jitter remains bounded even after many attempts', () => {
  assert.equal(
    retryDelay(1, () => 0.5),
    500,
  );
  assert.equal(
    retryDelay(100, () => 1),
    300_000,
  );
  assert.throws(() => retryDelay(0));
});
