/**
 * Transaction rollback that cannot mask the error that caused it. Used in every `catch` that rolls
 * back before rethrowing, so the caller's original error always reaches the caller.
 */

import type { PoolClient } from 'pg';
import { logFailure } from './failure.js';

/**
 * Rolls back the open transaction on `client`. If the rollback itself fails the connection is in an
 * unknown state, so it is destroyed with `client.release(error)` instead of being returned to the
 * pool, and the failure is logged. This function never throws, so the caller rethrows its own error.
 * After a failed rollback the client's `release` becomes a no-op: the usual `finally { client.release() }`
 * would otherwise throw "already released" and mask the original error.
 */
export async function rollback(client: Pick<PoolClient, 'query' | 'release'>): Promise<void> {
  try {
    await client.query('ROLLBACK');
  } catch (rollbackError) {
    logFailure(rollbackError, {}, 'Transaction rollback failed; destroying the connection');
    client.release(
      rollbackError instanceof Error ? rollbackError : new Error('Transaction rollback failed'),
    );
    client.release = () => undefined;
  }
}
