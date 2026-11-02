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
    [email.trim().toLowerCase()],
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

export type SupportEmailChange =
  { outcome: 'changed'; previousEmail: string } | { outcome: 'no-active-case' | 'conflict' };

/**
 * Changes the sign-in address of a locked-out account, once, under an active case. The operator's identity
 * check is the verification, so no code is sent. In one transaction the case is closed, the address is
 * changed, and every session and pending email change of the account is removed, so the old address can no
 * longer be used. The previous address is returned so the caller can send it a notice after the commit.
 */
export async function changeEmailWithSupportCase(
  database: Database,
  caseId: string,
  newEmail: string,
): Promise<SupportEmailChange> {
  // Addresses are stored lower-case, so a case variant of another account's address must count as taken.
  const address = newEmail.trim().toLowerCase();
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query<{ owner_id: string }>(
      `SELECT owner_id FROM support_cases
       WHERE id = $1 AND closed_at IS NULL AND expires_at > now()
       FOR UPDATE`,
      [caseId],
    );
    const ownerId = found.rows[0]?.owner_id;
    if (!ownerId) {
      await client.query('ROLLBACK');
      return { outcome: 'no-active-case' };
    }
    const taken = await client.query('SELECT 1 FROM users WHERE email = $1 AND id <> $2', [
      address,
      ownerId,
    ]);
    if ((taken.rowCount ?? 0) > 0) {
      await client.query('ROLLBACK');
      return { outcome: 'conflict' };
    }
    const current = await client.query<{ email: string }>(
      'SELECT email FROM users WHERE id = $1 FOR UPDATE',
      [ownerId],
    );
    const previousEmail = current.rows[0]!.email;
    await client.query('UPDATE users SET email = $2, email_verified_at = now() WHERE id = $1', [
      ownerId,
      address,
    ]);
    await client.query('DELETE FROM sessions WHERE owner_id = $1', [ownerId]);
    await client.query('DELETE FROM email_change_requests WHERE owner_id = $1', [ownerId]);
    await client.query('UPDATE support_cases SET closed_at = now() WHERE id = $1', [caseId]);
    await client.query('COMMIT');
    return { outcome: 'changed', previousEmail };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((error as { code?: string }).code === '23505') return { outcome: 'conflict' };
    throw error;
  } finally {
    client.release();
  }
}
