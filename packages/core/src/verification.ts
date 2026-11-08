/**
 * Candidate verification lifecycle primitives.
 *
 * This module intentionally does not grant verification status. A tick may be
 * displayed only after an approved, type-specific check has completed and its
 * evidence policy has been reviewed. See the verification approval gate in
 * docs/requirements/CareerScope-v12.md.
 */

export type VerificationType = 'email' | 'college' | 'profile-link';
export type VerificationStatus = 'pending' | 'verified' | 'expired' | 'revoked';

export type VerificationCheck = {
  type: VerificationType;
  status: VerificationStatus;
  checkedAt: number | null;
  expiresAt: number | null;
  recheckAt: number | null;
  revokedAt: number | null;
  revocationReason: string | null;
  appealAvailable: boolean;
};

export type VerificationTransition = 'pending' | 'verified' | 'expired' | 'revoked' | 'invalid';

/** Returns a non-verified placeholder; creating a record never confers a tick. */
export function pendingVerification(type: VerificationType): VerificationCheck {
  return {
    type,
    status: 'pending',
    checkedAt: null,
    expiresAt: null,
    recheckAt: null,
    revokedAt: null,
    revocationReason: null,
    appealAvailable: false,
  };
}

/**
 * Derives whether a verified check remains current. Expiry and scheduled
 * recheck both remove the active tick; callers must arrange a fresh check.
 */
export function verificationTransition(
  check: VerificationCheck,
  now = Date.now(),
): VerificationTransition {
  if (!Number.isSafeInteger(now) || now < 0) return 'invalid';
  if (
    !['email', 'college', 'profile-link'].includes(check.type) ||
    typeof check.appealAvailable !== 'boolean'
  )
    return 'invalid';
  if (check.status === 'pending') {
    return check.checkedAt === null &&
      check.expiresAt === null &&
      check.recheckAt === null &&
      check.revokedAt === null &&
      check.revocationReason === null &&
      check.appealAvailable === false
      ? 'pending'
      : 'invalid';
  }
  if (check.status !== 'verified' && check.status !== 'expired' && check.status !== 'revoked')
    return 'invalid';
  if (check.checkedAt === null) return 'invalid';
  if (!Number.isSafeInteger(check.checkedAt) || check.checkedAt < 0 || check.checkedAt > now)
    return 'invalid';
  if (
    check.expiresAt !== null &&
    (!Number.isSafeInteger(check.expiresAt) ||
      check.expiresAt < check.checkedAt ||
      check.expiresAt < 0)
  )
    return 'invalid';
  if (
    check.recheckAt !== null &&
    (!Number.isSafeInteger(check.recheckAt) ||
      check.recheckAt < check.checkedAt ||
      check.recheckAt < 0)
  )
    return 'invalid';
  if (check.status === 'revoked') {
    if (
      check.revokedAt === null ||
      !Number.isSafeInteger(check.revokedAt) ||
      check.revokedAt < check.checkedAt ||
      check.revokedAt > now ||
      typeof check.revocationReason !== 'string' ||
      !check.revocationReason.trim() ||
      (check.expiresAt !== null && check.expiresAt <= check.revokedAt) ||
      (check.recheckAt !== null && check.recheckAt <= check.revokedAt)
    )
      return 'invalid';
    return 'revoked';
  }
  if (check.revokedAt !== null || check.revocationReason !== null || check.appealAvailable)
    return 'invalid';
  if (check.status === 'expired') return 'expired';
  if (check.expiresAt !== null && check.expiresAt <= now) return 'expired';
  if (check.recheckAt !== null && check.recheckAt <= now) return 'expired';
  return 'verified';
}

/**
 * Applies a revocation with a user-facing reason. This records lifecycle data;
 * notice delivery and the appeal process require an approved operational flow.
 */
export function revokeVerification(
  check: VerificationCheck,
  input: { at: number; reason: string; appealAvailable: boolean },
): VerificationCheck | null {
  const reason = input.reason.trim();
  if (
    !Number.isSafeInteger(input.at) ||
    input.at < 0 ||
    !reason ||
    typeof input.appealAvailable !== 'boolean' ||
    verificationTransition(check, input.at) !== 'verified'
  )
    return null;

  return {
    ...check,
    status: 'revoked',
    revokedAt: input.at,
    revocationReason: reason,
    appealAvailable: input.appealAvailable,
  };
}
