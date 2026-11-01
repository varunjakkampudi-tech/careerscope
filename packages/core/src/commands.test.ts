import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { queueConnection } from './bull-queue.ts';
import { commandSchema, createSearchSchema, retryDelay } from './commands.ts';
import { localConnection } from './queue.ts';

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
  assert.equal(
    createSearchSchema.parse({
      query: 'React',
      sources: ['remoteok', 'himalayas', 'greenhouse', 'lever', 'workable'],
    }).sources.length,
    5,
  );
  for (const sources of [
    [],
    ['remoteok', 'remoteok'],
    ['remotive'],
    ['linkedin'],
    ['naukri'],
    ['indeed'],
  ]) {
    assert.equal(createSearchSchema.safeParse({ query: 'React', sources }).success, false);
  }
  assert.deepEqual(createSearchSchema.parse({ query: ' React ', sources: ['remoteok'] }), {
    query: 'React',
    sources: ['remoteok'],
    origin: 'manual',
  });
  assert.equal(
    createSearchSchema.safeParse({ query: 'React', sources: ['unknown'] }).success,
    false,
  );
});

// CS-26: origin distinguishes an unattended, scheduler-created run from a
// human clicking "search" - every existing manual caller must be unaffected
// (defaults to 'manual'), and only these two literal values are accepted.
test('createSearch origin defaults to manual and rejects anything but the two known values', () => {
  assert.equal(
    createSearchSchema.parse({ query: 'React', sources: ['remoteok'] }).origin,
    'manual',
  );
  assert.equal(
    createSearchSchema.parse({ query: 'React', sources: ['remoteok'], origin: 'scheduled' }).origin,
    'scheduled',
  );
  assert.equal(
    createSearchSchema.safeParse({ query: 'React', sources: ['remoteok'], origin: 'automated' })
      .success,
    false,
  );
});

test('retry jitter remains bounded even after many attempts', () => {
  assert.equal(
    createSearchSchema.parse({
      query: 'Saved target roles',
      sources: ['remoteok'],
      useProfileTitles: true,
    }).useProfileTitles,
    true,
  );
  assert.equal(
    createSearchSchema.safeParse({
      query: 'React',
      sources: ['remoteok'],
      useProfileTitles: 'true',
    }).success,
    false,
  );
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

test('queue connections forward both the ACL username and the password', () => {
  for (const connection of [
    localConnection('redis://worker:p%40ss@127.0.0.1:6380'),
    queueConnection('redis://worker:p%40ss@127.0.0.1:6380'),
  ]) {
    assert.equal(connection.host, '127.0.0.1');
    assert.equal(connection.port, 6380);
    assert.equal((connection as { username?: string }).username, 'worker');
    assert.equal((connection as { password?: string }).password, 'p@ss');
  }
  const passwordOnly = localConnection('redis://:secret@localhost');
  assert.equal('username' in passwordOnly, false);
  assert.equal((passwordOnly as { password?: string }).password, 'secret');
  assert.throws(() => localConnection('redis://worker:pw@example.com'));
  assert.throws(() => queueConnection('redis://worker:pw@example.com'));
});
