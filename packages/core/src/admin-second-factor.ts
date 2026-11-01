/**
 * Authenticator enrolment and the admin second factor (V12-4.1-012). An admin role is refused by the
 * database unless an authenticator is confirmed (`users_admin_requires_totp`). A confirmed code is
 * recorded as the account's last accepted time step, so the same code cannot be used twice.
 */

import type { Database } from './database.js';
import {
  authenticatorUri,
  decryptTotpSecret,
  encodeBase32,
  encryptTotpSecret,
  generateTotpSecret,
  matchingStep,
} from './totp.js';

export type AccountRole = 'candidate' | 'admin';

/** Starts or restarts enrolment for an account whose authenticator is not yet confirmed. */
export async function beginTotpEnrolment(
  database: Database,
  ownerId: string,
  email: string,
  masterSecret: Uint8Array,
): Promise<{ secret: string; uri: string } | 'already-enrolled'> {
  const existing = await database.pool.query<{ totp_enabled_at: Date | null }>(
    'SELECT totp_enabled_at FROM users WHERE id = $1',
    [ownerId],
  );
  if (existing.rows[0]?.totp_enabled_at) return 'already-enrolled';
  const secret = generateTotpSecret();
  await database.pool.query(
    'UPDATE users SET totp_secret_enc = $2, totp_last_counter = NULL WHERE id = $1 AND totp_enabled_at IS NULL',
    [ownerId, encryptTotpSecret(secret, masterSecret)],
  );
  return { secret: encodeBase32(secret), uri: authenticatorUri(secret, email) };
}

/** Confirms enrolment with a code from the pending secret. Returns false for a wrong or reused code. */
export async function confirmTotpEnrolment(
  database: Database,
  ownerId: string,
  code: string,
  masterSecret: Uint8Array,
  nowMs = Date.now(),
): Promise<boolean> {
  const row = await database.pool.query<{ totp_secret_enc: string | null }>(
    'SELECT totp_secret_enc FROM users WHERE id = $1 AND totp_enabled_at IS NULL',
    [ownerId],
  );
  const stored = row.rows[0]?.totp_secret_enc;
  if (!stored) return false;
  const step = matchingStep(decryptTotpSecret(stored, masterSecret), code, nowMs);
  if (step === null) return false;
  const confirmed = await database.pool.query(
    `UPDATE users SET totp_enabled_at = now(), totp_last_counter = $2
     WHERE id = $1 AND totp_enabled_at IS NULL AND totp_secret_enc = $3`,
    [ownerId, step, stored],
  );
  return (confirmed.rowCount ?? 0) === 1;
}

/** The role of an account and, for an admin, its confirmed authenticator. Null when there is no account. */
export async function accountSecondFactor(
  database: Database,
  email: string,
): Promise<{ role: AccountRole; secretEnc: string | null } | null> {
  const row = await database.pool.query<{
    role: AccountRole;
    totp_secret_enc: string | null;
    totp_enabled_at: Date | null;
  }>('SELECT role, totp_secret_enc, totp_enabled_at FROM users WHERE email = $1', [email]);
  const account = row.rows[0];
  if (!account) return null;
  return {
    role: account.role,
    secretEnc: account.totp_enabled_at ? account.totp_secret_enc : null,
  };
}

/**
 * Accepts an admin's authenticator code only once: the step is claimed with a conditional update, so two
 * concurrent sign-ins with the same code cannot both succeed.
 */
export async function claimAdminCode(
  database: Database,
  email: string,
  code: string,
  masterSecret: Uint8Array,
  nowMs = Date.now(),
): Promise<boolean> {
  const row = await database.pool.query<{ id: string; totp_secret_enc: string | null }>(
    'SELECT id, totp_secret_enc FROM users WHERE email = $1 AND totp_enabled_at IS NOT NULL',
    [email],
  );
  const account = row.rows[0];
  if (!account?.totp_secret_enc) return false;
  const step = matchingStep(decryptTotpSecret(account.totp_secret_enc, masterSecret), code, nowMs);
  if (step === null) return false;
  const claimed = await database.pool.query(
    `UPDATE users SET totp_last_counter = $2
     WHERE id = $1 AND (totp_last_counter IS NULL OR totp_last_counter < $2)`,
    [account.id, step],
  );
  return (claimed.rowCount ?? 0) === 1;
}

/**
 * Sets an account's role. Making an account an admin fails with a database error unless its authenticator
 * is confirmed. Returns false when no account has that address.
 */
export async function setAccountRole(
  database: Database,
  email: string,
  role: AccountRole,
): Promise<boolean> {
  const updated = await database.pool.query('UPDATE users SET role = $2 WHERE email = $1', [
    email,
    role,
  ]);
  return (updated.rowCount ?? 0) === 1;
}
