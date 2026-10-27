import assert from 'node:assert/strict';
import test from 'node:test';
import { rollback } from './rollback.ts';

function fakeClient(rollbackFails: boolean) {
  const released: unknown[] = [];
  return {
    released,
    client: {
      query: async (sql: string) => {
        if (sql === 'ROLLBACK' && rollbackFails) throw new Error('connection reset');
        return { rows: [] };
      },
      release: (error?: Error | boolean) => {
        released.push(error);
      },
    },
  };
}

/** The shape every transactional method uses: rollback in catch, release in finally. */
async function transaction(client: ReturnType<typeof fakeClient>['client'], failure: Error) {
  try {
    throw failure;
  } catch (error) {
    await rollback(client as never);
    throw error;
  } finally {
    client.release();
  }
}

test('a successful rollback leaves release to the caller', async () => {
  const { client, released } = fakeClient(false);
  const failure = new Error('original');
  await assert.rejects(transaction(client, failure), (error) => error === failure);
  assert.deepEqual(released, [undefined]);
});

test('a failed rollback destroys the connection and the original error still reaches the caller', async () => {
  const { client, released } = fakeClient(true);
  const failure = new Error('original');
  await assert.rejects(transaction(client, failure), (error) => error === failure);
  assert.equal(released.length, 1);
  assert.ok(released[0] instanceof Error);
  assert.equal((released[0] as Error).message, 'connection reset');
});
