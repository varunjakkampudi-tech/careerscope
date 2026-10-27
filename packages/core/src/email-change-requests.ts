/**
 * Two-address email change: issues a code for each address and completes the change once both are
 * verified. Uses `email-otp.ts`; the API drives it from the account security routes.
 */

import { rollback } from './rollback.js';
import { createHmac, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { createEmailOtp, emailOtpLifetimeMs, verifyEmailOtp } from './email-otp.js';

const emailSchema = z.string().trim().email().max(254);

/** Returned once by `begin` for delivery; the codes are not stored. */
export type EmailChangeCodes = {
  requestId: string;
  currentChallengeId: string;
  newChallengeId: string;
  currentEmail: string;
  newEmail: string;
  currentCode: string;
  newCode: string;
};

/** Outcome of one verification attempt; `completed` means both addresses are verified and the email was changed. */
export type EmailChangeVerification =
  | 'accepted'
  | 'already-verified'
  | 'completed'
  | 'incorrect'
  | 'expired'
  | 'exhausted'
  | 'invalid'
  | 'conflict';

/**
 * Email-change requests tied to one user. Changing the sign-in email needs a code from both the
 * current and the new address; codes are never persisted, only their digests.
 */
export class EmailChangeRequests {
  constructor(private readonly pool: Pool) {}

  /** Deletes the user's pending request; the owner id is part of the match, so another user's request is untouched. */
  async cancel(ownerId: string, requestId: string): Promise<void> {
    await this.pool.query('DELETE FROM email_change_requests WHERE owner_id = $1 AND id = $2', [
      ownerId,
      requestId,
    ]);
  }

  /**
   * Starts (or replaces) the user's single pending request, locking the user row first. Returns null
   * if the current email is unverified or the new address equals it. Replacing resets attempt counters and verification state.
   */
  async begin(
    ownerId: string,
    newEmailInput: string,
    secret: Uint8Array,
    now = Date.now(),
  ): Promise<EmailChangeCodes | null> {
    const newEmail = emailSchema.parse(newEmailInput).toLowerCase();
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid email-change time');

    const requestId = randomUUID();
    const currentChallengeId = randomUUID();
    const newChallengeId = randomUUID();
    const currentCode = createEmailOtp(currentChallengeId, secret, now);
    const newCode = createEmailOtp(newChallengeId, secret, now);
    const expiresAt = new Date(now + emailOtpLifetimeMs);
    const currentEmailHash = (email: string) =>
      createHmac('sha256', secret)
        .update('careerscope-email-change-current\0', 'utf8')
        .update(email, 'utf8')
        .digest('hex');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const owner = await client.query<{ email: string | null; email_verified_at: Date | null }>(
        'SELECT email, email_verified_at FROM users WHERE id = $1 FOR UPDATE',
        [ownerId],
      );
      const currentEmail = owner.rows[0]?.email;
      if (!currentEmail || !owner.rows[0]?.email_verified_at) {
        await client.query('COMMIT');
        return null;
      }
      const normalizedCurrent = emailSchema.parse(currentEmail).toLowerCase();
      if (newEmail === normalizedCurrent) {
        await client.query('COMMIT');
        return null;
      }

      // Drop this user's abandoned expired request so a stale pending address
      // is not retained; the unique owner_id rule still allows one live row.
      await client.query(
        'DELETE FROM email_change_requests WHERE owner_id = $1 AND expires_at <= $2',
        [ownerId, new Date(now)],
      );
      await client.query(
        `INSERT INTO email_change_requests
           (id, owner_id, current_email_hash, new_email,
            current_challenge_id, current_digest, new_challenge_id, new_digest, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (owner_id) DO UPDATE SET
           id = EXCLUDED.id,
           current_email_hash = EXCLUDED.current_email_hash,
           new_email = EXCLUDED.new_email,
           current_challenge_id = EXCLUDED.current_challenge_id,
           current_digest = EXCLUDED.current_digest,
           current_attempts = 0,
           current_verified_at = NULL,
           new_challenge_id = EXCLUDED.new_challenge_id,
           new_digest = EXCLUDED.new_digest,
           new_attempts = 0,
           new_verified_at = NULL,
           expires_at = EXCLUDED.expires_at,
           created_at = now()`,
        [
          requestId,
          ownerId,
          currentEmailHash(normalizedCurrent),
          newEmail,
          currentChallengeId,
          currentCode.digest,
          newChallengeId,
          newCode.digest,
          expiresAt,
        ],
      );
      await client.query('COMMIT');
      return {
        requestId,
        currentChallengeId,
        newChallengeId,
        currentEmail: normalizedCurrent,
        newEmail,
        currentCode: currentCode.code,
        newCode: newCode.code,
      };
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Verifies the code for one address. Locks the user row, then the request row (the same order as
   * `begin`). Five wrong codes, expiry or a changed current email deletes the request. When both
   * addresses are verified the email is changed, unless another account already uses it (`conflict`).
   */
  async verify(input: {
    ownerId: string;
    address: 'current' | 'new';
    code: unknown;
    secret: Uint8Array;
    now?: number;
  }): Promise<EmailChangeVerification> {
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) return 'invalid';
    const client = await this.pool.connect();
    let requestId: string | undefined;
    try {
      await client.query('BEGIN');
      // Lock in the same user-then-request order as begin(), preventing a
      // request replacement from racing challenge consumption.
      const owner = await client.query<{ email: string | null; email_verified_at: Date | null }>(
        'SELECT email, email_verified_at FROM users WHERE id = $1 FOR UPDATE',
        [input.ownerId],
      );
      const request = await client.query<{
        id: string;
        current_email_hash: string;
        new_email: string;
        current_challenge_id: string;
        current_digest: string;
        current_attempts: number;
        current_verified_at: Date | null;
        new_challenge_id: string;
        new_digest: string;
        new_attempts: number;
        new_verified_at: Date | null;
        expires_at: Date;
      }>(
        `SELECT id, current_email_hash, new_email, current_challenge_id, current_digest,
                current_attempts, current_verified_at, new_challenge_id, new_digest,
                new_attempts, new_verified_at, expires_at
         FROM email_change_requests WHERE owner_id = $1 FOR UPDATE`,
        [input.ownerId],
      );
      const row = request.rows[0];
      requestId = row?.id;
      const currentEmail = owner.rows[0]?.email;
      if (!row || !currentEmail || !owner.rows[0]?.email_verified_at) {
        await client.query('COMMIT');
        return 'invalid';
      }
      if (
        createHmac('sha256', input.secret)
          .update('careerscope-email-change-current\0', 'utf8')
          .update(emailSchema.parse(currentEmail).toLowerCase(), 'utf8')
          .digest('hex') !== row.current_email_hash
      ) {
        await client.query('DELETE FROM email_change_requests WHERE id = $1', [row.id]);
        await client.query('COMMIT');
        return 'invalid';
      }
      if (now >= row.expires_at.getTime()) {
        await client.query('DELETE FROM email_change_requests WHERE id = $1', [row.id]);
        await client.query('COMMIT');
        return 'expired';
      }

      const current = input.address === 'current';
      const verifiedAt = current ? row.current_verified_at : row.new_verified_at;
      if (verifiedAt) {
        await client.query('COMMIT');
        return 'already-verified';
      }
      const result = verifyEmailOtp({
        challengeId: current ? row.current_challenge_id : row.new_challenge_id,
        code: input.code,
        digest: current ? row.current_digest : row.new_digest,
        secret: input.secret,
        expiresAt: row.expires_at.getTime(),
        attempts: current ? row.current_attempts : row.new_attempts,
        now,
      });
      if (result !== 'accepted') {
        if (result === 'incorrect') {
          const attempts = (current ? row.current_attempts : row.new_attempts) + 1;
          if (attempts >= 5) {
            await client.query('DELETE FROM email_change_requests WHERE id = $1', [row.id]);
            await client.query('COMMIT');
            return 'exhausted';
          }
          await client.query(
            `UPDATE email_change_requests SET ${current ? 'current_attempts' : 'new_attempts'} = $2 WHERE id = $1`,
            [row.id, attempts],
          );
        }
        await client.query('COMMIT');
        return result;
      }

      const column = current ? 'current_verified_at' : 'new_verified_at';
      await client.query(`UPDATE email_change_requests SET ${column} = now() WHERE id = $1`, [
        row.id,
      ]);
      const otherVerified = current ? row.new_verified_at : row.current_verified_at;
      if (!otherVerified) {
        await client.query('COMMIT');
        return 'accepted';
      }

      const existing = await client.query<{ id: string }>(
        'SELECT id FROM users WHERE email = $1 AND id <> $2 FOR UPDATE',
        [row.new_email, input.ownerId],
      );
      if (existing.rowCount) {
        await client.query('DELETE FROM email_change_requests WHERE id = $1', [row.id]);
        await client.query('COMMIT');
        return 'conflict';
      }
      await client.query(
        `UPDATE users SET email = $2, email_verified_at = now()
         WHERE id = $1 AND email = $3 AND email_verified_at IS NOT NULL`,
        [input.ownerId, row.new_email, currentEmail],
      );
      await client.query('DELETE FROM email_change_requests WHERE id = $1', [row.id]);
      await client.query('COMMIT');
      return 'completed';
    } catch (error) {
      await rollback(client);
      if ((error as { code?: string }).code === '23505') {
        // Another account registration may win the unique-email race after
        // the preflight. Remove the now unusable pending request in a fresh
        // statement after this transaction has rolled back.
        if (requestId)
          await client.query('DELETE FROM email_change_requests WHERE id = $1', [requestId]);
        return 'conflict';
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
