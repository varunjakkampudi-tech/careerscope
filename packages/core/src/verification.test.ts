import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pendingVerification,
  revokeVerification,
  verificationTransition,
  type VerificationCheck,
} from './verification.js';

const verified: VerificationCheck = {
  ...pendingVerification('college'),
  status: 'verified',
  checkedAt: 100,
};

test('new verification records do not grant a tick', () => {
  const check = pendingVerification('profile-link');
  assert.equal(check.status, 'pending');
  assert.equal(check.checkedAt, null);
  assert.equal(verificationTransition(check, 100), 'pending');
});

test('a completed check stays current only before its expiry and recheck time', () => {
  assert.equal(verificationTransition(verified, 100), 'verified');
  assert.equal(verificationTransition({ ...verified, expiresAt: 200 }, 199), 'verified');
  assert.equal(verificationTransition({ ...verified, expiresAt: 200 }, 200), 'expired');
  assert.equal(verificationTransition({ ...verified, recheckAt: 200 }, 200), 'expired');
});

test('revocation immediately removes the active tick and records a reason and appeal', () => {
  const revoked = revokeVerification(verified, {
    at: 150,
    reason: 'Evidence could not be revalidated',
    appealAvailable: true,
  });
  assert.ok(revoked);
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.revocationReason, 'Evidence could not be revalidated');
  assert.equal(revoked.appealAvailable, true);
  assert.equal(verificationTransition(revoked, 151), 'revoked');
});

test('revocation rejects missing reasons, invalid times, and non-active checks', () => {
  assert.equal(
    revokeVerification(verified, { at: 150, reason: '  ', appealAvailable: false }),
    null,
  );
  assert.equal(
    revokeVerification(verified, { at: 99, reason: 'Changed', appealAvailable: false }),
    null,
  );
  assert.equal(
    revokeVerification(pendingVerification('email'), {
      at: 150,
      reason: 'Changed',
      appealAvailable: false,
    }),
    null,
  );
  assert.equal(verificationTransition(verified, Number.NaN), 'invalid');
});
