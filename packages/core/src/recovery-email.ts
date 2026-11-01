/**
 * The recovery address for an account that has lost access to its sign-in email (item 2.17). The
 * address is confirmed with a code, and recovery sign-in to the account is refused for a cooldown
 * after confirmation, so a stolen session cannot add a recovery address and use it at once.
 */

import type { Database } from './database.js';

/** Recovery sign-in is refused this long after a recovery address is confirmed. */
export const recoveryCooldownMs = 72 * 60 * 60 * 1000;

export type RecoveryStatus = {
  configured: boolean;
  verifiedAt: Date | null;
  cooldownEndsAt: Date | null;
};

/**
 * Stores a confirmed recovery address for one owner. It is refused when the address is already the
 * sign-in address of any account (including this one), so a recovery address can never point an
 * attacker at another account. Returns false when it was refused.
 */
export async function setRecoveryEmail(
  database: Database,
  ownerId: string,
  email: string,
): Promise<boolean> {
  const result = await database.pool.query(
    `UPDATE users SET recovery_email = $2, recovery_email_verified_at = now()
     WHERE id = $1
       AND NOT EXISTS (SELECT 1 FROM users WHERE email = $2)`,
    [ownerId, email],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Removes the owner's recovery address. Recovery sign-in is unavailable until one is confirmed again. */
export async function removeRecoveryEmail(database: Database, ownerId: string): Promise<void> {
  await database.pool.query(
    'UPDATE users SET recovery_email = NULL, recovery_email_verified_at = NULL WHERE id = $1',
    [ownerId],
  );
}

/** The owner's recovery status. Only the configured flag and the dates are returned, never the address. */
export async function recoveryStatus(database: Database, ownerId: string): Promise<RecoveryStatus> {
  const result = await database.pool.query<{ verified_at: Date | null }>(
    'SELECT recovery_email_verified_at AS verified_at FROM users WHERE id = $1',
    [ownerId],
  );
  const verifiedAt = result.rows[0]?.verified_at ?? null;
  return {
    configured: verifiedAt !== null,
    verifiedAt,
    cooldownEndsAt: verifiedAt ? new Date(verifiedAt.getTime() + recoveryCooldownMs) : null,
  };
}

/**
 * The account and recovery address for a sign-in email, when recovery is allowed now: a recovery
 * address is confirmed and the cooldown has passed. Returns null for every other case, so the caller
 * cannot tell an unknown account from one without recovery.
 */
export async function recoveryTarget(
  database: Database,
  email: string,
): Promise<{ ownerId: string; recoveryEmail: string } | null> {
  const result = await database.pool.query<{ id: string; recovery_email: string }>(
    `SELECT id, recovery_email FROM users
     WHERE email = $1
       AND recovery_email IS NOT NULL
       AND recovery_email_verified_at <= now() - ($2::bigint * interval '1 millisecond')`,
    [email, recoveryCooldownMs],
  );
  const row = result.rows[0];
  return row ? { ownerId: row.id, recoveryEmail: row.recovery_email } : null;
}
