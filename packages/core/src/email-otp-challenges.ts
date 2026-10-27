/**
 * Postgres-backed email OTP challenges for sign-in and sign-up. Uses digests from `email-otp.ts`; the
 * API calls it with `auth.ts` to create sessions in the same transaction as consumption.
 */

import { rollback } from './rollback.js';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { verifyEmailOtp, type EmailOtpVerification } from './email-otp.js';

const emailSchema = z.string().trim().email().max(254);
const uuidSchema = z.string().uuid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Domain-separated HMAC of the lower-cased address, used as the challenge key so raw addresses are not stored. */
export function hashOtpEmail(emailInput: string, secret: Uint8Array): string {
  const email = emailSchema.parse(emailInput).toLowerCase();
  if (!(secret instanceof Uint8Array) || secret.byteLength < 32)
    throw new Error('OTP digest key must be at least 32 bytes');
  return createHmac('sha256', secret)
    .update('careerscope-email-otp-address\0', 'utf8')
    .update(email, 'utf8')
    .digest('hex');
}

/** Fields stored for a new challenge. Sign-up challenges carry consent versions and must have a passed age screen. */
export type NewEmailOtpChallenge = {
  id: string;
  email: string;
  digest: string;
  expiresAt: number;
  intent?: 'sign-in' | 'sign-up';
  termsVersion?: string;
  privacyVersion?: string;
  marketingOptIn?: boolean;
  marketingVersion?: string;
  ageScreenPassed?: boolean;
};

/** What the challenge recorded at issue time, handed to `onAccepted` so the account can be created with the same consent. */
export type EmailOtpChallengeContext = Pick<
  NewEmailOtpChallenge,
  'intent' | 'termsVersion' | 'privacyVersion' | 'marketingOptIn' | 'marketingVersion'
> &
  Pick<NewEmailOtpChallenge, 'ageScreenPassed'>;

/**
 * PostgreSQL-backed one-time challenge state. The code itself is never stored.
 * The caller owns delivery and must not log the returned code or raw payload.
 * Rows are keyed by an HMAC of the email, so the table holds no raw addresses.
 */
export class EmailOtpChallenges {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => number = Date.now,
  ) {}

  /**
   * Replaces the active challenge for an address. With `cooldownMs`, an
   * unexpired challenge issued within that window is left untouched and
   * `false` is returned, so a third party cannot invalidate a code the owner
   * was just sent. Returns `true` when the new challenge was stored.
   */
  async replaceActive(
    input: NewEmailOtpChallenge,
    secret: Uint8Array,
    options: { cooldownMs?: number } = {},
  ): Promise<boolean> {
    const id = uuidSchema.parse(input.id);
    const digest = digestSchema.parse(input.digest);
    const emailHash = hashOtpEmail(input.email, secret);
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now())
      throw new Error('Invalid OTP expiration time');
    if (input.intent === 'sign-up' && input.ageScreenPassed !== true)
      throw new Error('Signup OTP requires a passed age screen');
    if (input.intent !== 'sign-up' && input.ageScreenPassed !== undefined)
      throw new Error('Age-screen result is valid only for signup OTP');

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Expired challenges are bounded to a small cleanup batch per issuance;
      // active rows are keyed by a domain-separated HMAC, never raw email. The
      // per-address advisory lock serialises concurrent issues, so only one
      // challenge stays active and the cooldown check cannot race.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [emailHash]);
      await client.query(
        `WITH expired AS (
           SELECT id FROM email_otp_challenges
           WHERE expires_at <= now()
           ORDER BY expires_at
           LIMIT 500
           FOR UPDATE SKIP LOCKED
         )
         DELETE FROM email_otp_challenges challenge
         USING expired WHERE challenge.id = expired.id`,
      );
      if (options.cooldownMs !== undefined) {
        const recent = await client.query(
          `SELECT 1 FROM email_otp_challenges
           WHERE email_hash = $1 AND expires_at > now()
             AND created_at > now() - ($2::double precision * interval '1 millisecond')`,
          [emailHash, options.cooldownMs],
        );
        if (recent.rows.length > 0) {
          await client.query('COMMIT');
          return false;
        }
      }
      await client.query('DELETE FROM email_otp_challenges WHERE email_hash = $1', [emailHash]);
      await client.query(
        `INSERT INTO email_otp_challenges
           (id, email_hash, digest, expires_at, intent, terms_version, privacy_version,
            marketing_opt_in, marketing_version, age_screen_passed)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          id,
          emailHash,
          digest,
          new Date(input.expiresAt),
          input.intent ?? 'sign-in',
          input.termsVersion ?? null,
          input.privacyVersion ?? null,
          input.marketingOptIn ?? false,
          input.marketingVersion ?? null,
          input.ageScreenPassed ?? null,
        ],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** The id of the unexpired challenge for an address, or null. Takes the same per-address lock as issuing. */
  async activeId(email: string, secret: Uint8Array): Promise<string | null> {
    const emailHash = hashOtpEmail(email, secret);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [emailHash]);
      const active = await client.query<{ id: string }>(
        `SELECT id FROM email_otp_challenges
         WHERE email_hash = $1 AND expires_at > now()
         LIMIT 1`,
        [emailHash],
      );
      await client.query('COMMIT');
      return active.rows[0]?.id ?? null;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Deletes one challenge; the address hash must match, so an id alone cannot delete another address's challenge. */
  async invalidate(id: string, email: string, secret: Uint8Array): Promise<void> {
    const parsedId = uuidSchema.parse(id);
    const emailHash = hashOtpEmail(email, secret);
    await this.pool.query('DELETE FROM email_otp_challenges WHERE id = $1 AND email_hash = $2', [
      parsedId,
      emailHash,
    ]);
  }

  /**
   * Checks a code against a challenge under a row lock. A wrong code consumes one attempt and the
   * fifth deletes the challenge; an accepted, expired or exhausted challenge is deleted so it cannot be
   * reused. `onAccepted` runs in the same transaction before the delete, so side effects such as session creation commit atomically.
   */
  async consume(input: {
    id: string;
    email: string;
    code: unknown;
    secret: Uint8Array;
    now?: number;
    expectedIntent?: 'sign-in' | 'sign-up';
    onAccepted?: (client: PoolClient, challenge: EmailOtpChallengeContext) => Promise<void>;
  }): Promise<EmailOtpVerification> {
    const id = uuidSchema.safeParse(input.id);
    if (!id.success) return 'invalid';
    const email = emailSchema.safeParse(input.email);
    if (
      !email.success ||
      !(input.secret instanceof Uint8Array) ||
      input.secret.byteLength < 32 ||
      (input.now !== undefined && (!Number.isSafeInteger(input.now) || input.now < 0))
    )
      return 'invalid';
    const emailHash = hashOtpEmail(email.data, input.secret);

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<{
        digest: string;
        attempts: number;
        expires_at: Date;
        intent: 'sign-in' | 'sign-up';
        terms_version: string | null;
        privacy_version: string | null;
        marketing_opt_in: boolean;
        marketing_version: string | null;
        age_screen_passed: boolean | null;
      }>(
        `SELECT digest, attempts, expires_at, intent, terms_version, privacy_version,
                marketing_opt_in, marketing_version, age_screen_passed
         FROM email_otp_challenges
         WHERE id = $1 AND email_hash = $2
         FOR UPDATE`,
        [id.data, emailHash],
      );
      const challenge = selected.rows[0];
      if (!challenge) {
        await client.query('COMMIT');
        return 'invalid';
      }
      if (input.expectedIntent && input.expectedIntent !== challenge.intent) {
        await client.query('COMMIT');
        return 'invalid';
      }
      if (input.expectedIntent === 'sign-up' && challenge.age_screen_passed !== true) {
        // A signup challenge without a passed age screen is never accepted. Delete
        // it so a fresh request must pass the age screen before a code is sent.
        await client.query('DELETE FROM email_otp_challenges WHERE id = $1', [id.data]);
        await client.query('COMMIT');
        return 'invalid';
      }

      // Evaluate expiry only after the row lock is acquired. A request may wait
      // behind another verifier long enough for the challenge to expire.
      const now = input.now ?? this.clock();
      if (!Number.isSafeInteger(now) || now < 0) {
        await client.query('COMMIT');
        return 'invalid';
      }
      const verification = verifyEmailOtp({
        challengeId: id.data,
        code: input.code,
        digest: challenge.digest,
        secret: input.secret,
        expiresAt: challenge.expires_at.getTime(),
        attempts: challenge.attempts,
        now,
      });

      if (
        verification === 'accepted' ||
        verification === 'expired' ||
        verification === 'exhausted'
      ) {
        if (verification === 'accepted' && input.onAccepted) {
          await input.onAccepted(client, {
            intent: challenge.intent,
            termsVersion: challenge.terms_version ?? undefined,
            privacyVersion: challenge.privacy_version ?? undefined,
            marketingOptIn: challenge.marketing_opt_in,
            marketingVersion: challenge.marketing_version ?? undefined,
            ageScreenPassed: challenge.age_screen_passed ?? undefined,
          });
        }
        await client.query('DELETE FROM email_otp_challenges WHERE id = $1', [id.data]);
      } else if (verification === 'incorrect') {
        const attempts = challenge.attempts + 1;
        if (attempts >= 5)
          await client.query('DELETE FROM email_otp_challenges WHERE id = $1', [id.data]);
        else
          await client.query('UPDATE email_otp_challenges SET attempts = $2 WHERE id = $1', [
            id.data,
            attempts,
          ]);
      }
      await client.query('COMMIT');
      // The fifth wrong code has just deleted the row, so report `exhausted` for it directly.
      return verification === 'incorrect' && challenge.attempts >= 4 ? 'exhausted' : verification;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
