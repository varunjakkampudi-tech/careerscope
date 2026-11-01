/**
 * Support cases for an inaccessible mailbox (V12-4.1-014). A case records who opened it and why, and it
 * expires after a fixed window. A case never signs anyone in. It only time-limits an operator's identity
 * check, and an operator closes it when the check ends.
 */

import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';

export const supportCaseWindowMs = 24 * 60 * 60 * 1000;

export type OpenedSupportCase = { caseId: string; expiresAt: Date };

/** Opens a case for the account at `email`. Returns null when no account has that address. */
export async function openSupportCase(
  database: Database,
  email: string,
  reason: string,
  openedBy: string,
  nowMs = Date.now(),
): Promise<OpenedSupportCase | null> {
  const account = await database.pool.query<{ id: string }>(
    'SELECT id FROM users WHERE email = $1',
    [email],
  );
  const ownerId = account.rows[0]?.id;
  if (!ownerId) return null;
  const caseId = randomUUID();
  const expiresAt = new Date(nowMs + supportCaseWindowMs);
  await database.pool.query(
    `INSERT INTO support_cases (id, owner_id, reason, opened_by, opened_at, expires_at)
     VALUES ($1, $2, $3, $4, to_timestamp($5::double precision / 1000), $6)`,
    [caseId, ownerId, reason.trim(), openedBy, nowMs, expiresAt],
  );
  return { caseId, expiresAt };
}

/** Closes an open case. Returns false when the case is unknown or already closed. */
export async function closeSupportCase(database: Database, caseId: string): Promise<boolean> {
  const closed = await database.pool.query(
    'UPDATE support_cases SET closed_at = now() WHERE id = $1 AND closed_at IS NULL',
    [caseId],
  );
  return (closed.rowCount ?? 0) === 1;
}

/** Whether the account has a case that is open and inside its window. */
export async function hasActiveSupportCase(database: Database, ownerId: string): Promise<boolean> {
  const active = await database.pool.query(
    'SELECT 1 FROM support_cases WHERE owner_id = $1 AND closed_at IS NULL AND expires_at > now() LIMIT 1',
    [ownerId],
  );
  return (active.rowCount ?? 0) > 0;
}
