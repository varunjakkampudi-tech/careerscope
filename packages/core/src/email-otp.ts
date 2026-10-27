/**
 * Pure one-time-code logic for email sign-in and email change: generation, HMAC digests and
 * verification. No I/O; persistence is in `email-otp-challenges.ts` and `email-change-requests.ts`.
 */

import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';

/** Codes live five minutes and allow five wrong attempts. */
export const emailOtpLifetimeMs = 5 * 60 * 1000;
export const emailOtpMaximumAttempts = 5;

/** Input shapes: a six-digit code, a hex SHA-256 digest, and a UUID challenge id (versions 1-8). */
const otpPattern = /^\d{6}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const challengeIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** A new code with its digest and expiry (epoch ms). Store the digest; deliver the code and discard it. */
export type EmailOtp = {
  code: string;
  digest: string;
  expiresAt: number;
};

/** `invalid` is malformed input; the others are the reason a code was not accepted. */
export type EmailOtpVerification = 'accepted' | 'incorrect' | 'expired' | 'exhausted' | 'invalid';

/** The HMAC key must be at least 32 bytes. */
function isValidSecret(secret: unknown): secret is Uint8Array {
  return secret instanceof Uint8Array && secret.byteLength >= 32;
}

/** Throws on a malformed challenge id or a short key. */
function validateInputs(challengeId: string, secret: Uint8Array) {
  if (!challengeIdPattern.test(challengeId)) throw new Error('Invalid OTP challenge identifier');
  if (!isValidSecret(secret)) throw new Error('OTP digest key must be at least 32 bytes');
}

/** HMAC-SHA256 over a fixed domain prefix, the challenge id and the code, so a digest is bound to one challenge. */
function digestEmailOtp(challengeId: string, code: string, secret: Uint8Array) {
  return createHmac('sha256', secret)
    .update('careerscope-email-otp\0', 'utf8')
    .update(challengeId.toLowerCase(), 'utf8')
    .update('\0', 'utf8')
    .update(code, 'utf8')
    .digest();
}

/**
 * Creates a six-digit email challenge. The code is returned only to the caller
 * that must deliver it; persistence should store `digest`, never `code`.
 */
export function createEmailOtp(
  challengeId: string,
  secret: Uint8Array,
  now = Date.now(),
): EmailOtp {
  validateInputs(challengeId, secret);
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid OTP creation time');
  const expiresAt = now + emailOtpLifetimeMs;
  if (!Number.isSafeInteger(expiresAt)) throw new Error('Invalid OTP expiration time');

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  return {
    code,
    digest: digestEmailOtp(challengeId, code, secret).toString('hex'),
    expiresAt,
  };
}

/**
 * Verifies a submitted code without exposing whether the challenge, account,
 * code, expiry, or attempt budget was the cause of rejection to an API caller.
 * The caller must persist attempt consumption and single-use state atomically.
 */
export function verifyEmailOtp(input: {
  challengeId: string;
  code: unknown;
  digest: string;
  secret: Uint8Array;
  expiresAt: number;
  attempts: number;
  now?: number;
}): EmailOtpVerification {
  const now = input.now ?? Date.now();
  if (
    !challengeIdPattern.test(input.challengeId) ||
    !isValidSecret(input.secret) ||
    !digestPattern.test(input.digest) ||
    !Number.isSafeInteger(input.expiresAt) ||
    !Number.isSafeInteger(input.attempts) ||
    input.attempts < 0 ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    return 'invalid';

  if (input.attempts >= emailOtpMaximumAttempts) return 'exhausted';
  if (now >= input.expiresAt) return 'expired';
  if (typeof input.code !== 'string' || !otpPattern.test(input.code)) return 'incorrect';

  const expected = Buffer.from(input.digest, 'hex');
  const actual = digestEmailOtp(input.challengeId, input.code, input.secret);
  return timingSafeEqual(expected, actual) ? 'accepted' : 'incorrect';
}
