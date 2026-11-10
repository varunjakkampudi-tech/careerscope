import assert from 'node:assert/strict';
import test from 'node:test';
import * as publicCoreApi from '@careerscope/core';
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

test('verification lifecycle stays out of the public core API until issuance policy is approved', () => {
  for (const member of ['verificationTransition', 'pendingVerification', 'revokeVerification']) {
    assert.equal(member in publicCoreApi, false, `${member} must not be exposed by the core API`);
  }
});

test('a completed check stays current only before its expiry and recheck time', () => {
  assert.equal(verificationTransition(verified, 100), 'verified');
  assert.equal(verificationTransition({ ...verified, expiresAt: 200 }, 199), 'verified');
  assert.equal(verificationTransition({ ...verified, expiresAt: 200 }, 200), 'expired');
  assert.equal(verificationTransition({ ...verified, recheckAt: 200 }, 200), 'expired');
  assert.equal(verificationTransition({ ...verified, status: 'expired' }, 200), 'expired');
  assert.equal(verificationTransition({ ...verified, expiresAt: 99 }, 100), 'invalid');
  assert.equal(
    verificationTransition({ ...verified, expiresAt: 200, recheckAt: Number.NaN }, 200),
    'invalid',
  );
  assert.equal(
    verificationTransition({ ...verified, expiresAt: 200, revokedAt: Number.NaN }, 200),
    'invalid',
  );
  assert.equal(
    verificationTransition({ ...verified, status: 'expired', recheckAt: Number.NaN }, 200),
    'invalid',
  );
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
  assert.equal(
    verificationTransition({ ...revoked, appealAvailable: 'yes' as unknown as boolean }, 151),
    'invalid',
  );
  assert.equal(verificationTransition({ ...revoked, expiresAt: Number.NaN }, 151), 'invalid');
  assert.equal(verificationTransition({ ...revoked, recheckAt: 140 }, 151), 'invalid');
});

test('revoked history stays revoked after its original expiry or recheck deadline', () => {
  const revokedAt = 150;
  const expiresLater = revokeVerification(
    { ...verified, expiresAt: 200 },
    { at: revokedAt, reason: 'Evidence could not be revalidated', appealAvailable: true },
  );
  const rechecksLater = revokeVerification(
    { ...verified, recheckAt: 200 },
    { at: revokedAt, reason: 'Evidence could not be revalidated', appealAvailable: true },
  );

  assert.ok(expiresLater);
  assert.ok(rechecksLater);
  assert.equal(verificationTransition(expiresLater, 250), 'revoked');
  assert.equal(verificationTransition(rechecksLater, 250), 'revoked');
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
  assert.equal(
    revokeVerification(
      { ...verified, expiresAt: 150 },
      {
        at: 150,
        reason: 'Changed',
        appealAvailable: false,
      },
    ),
    null,
  );
  assert.equal(verificationTransition(verified, Number.NaN), 'invalid');
  assert.equal(verificationTransition(null as unknown as VerificationCheck, 151), 'invalid');
  assert.equal(verificationTransition(undefined as unknown as VerificationCheck, 151), 'invalid');
  assert.equal(
    revokeVerification(verified, null as unknown as Parameters<typeof revokeVerification>[1]),
    null,
  );
  assert.equal(
    revokeVerification(verified, undefined as unknown as Parameters<typeof revokeVerification>[1]),
    null,
  );
  assert.equal(
    revokeVerification(verified, {
      at: 150,
      reason: 42 as unknown as string,
      appealAvailable: false,
    }),
    null,
  );
  assert.equal(
    verificationTransition(
      {
        ...verified,
        status: 'revoked',
        revokedAt: null,
        revocationReason: null,
      },
      151,
    ),
    'invalid',
  );
});

test('malformed verification records fail closed without throwing', () => {
  const malformedRecords: Array<[string, unknown]> = [
    ['unknown verification type', { ...verified, type: 'identity' }],
    ['unknown status', { ...verified, status: 'approved' }],
    ['missing type', { ...verified, type: undefined }],
    ['missing status', { ...verified, status: undefined }],
    ['missing checkedAt', { ...verified, checkedAt: undefined }],
    ['missing expiresAt', { ...verified, expiresAt: undefined }],
    ['missing recheckAt', { ...verified, recheckAt: undefined }],
    ['missing appealAvailable', { ...verified, appealAvailable: undefined }],
    ['array record', []],
  ];

  for (const [name, record] of malformedRecords) {
    assert.equal(verificationTransition(record as VerificationCheck, 151), 'invalid', name);
  }
  assert.equal(verificationTransition(verified, 151.5), 'invalid', 'fractional current time');
  assert.equal(
    verificationTransition({ ...verified, checkedAt: 100.5 }, 151),
    'invalid',
    'fractional check time',
  );
});

test('malformed revocation metadata fails closed without throwing', () => {
  const malformedRequests: Array<[string, unknown]> = [
    ['array request', []],
    ['fractional revocation time', { at: 150.5, reason: 'Changed', appealAvailable: false }],
    ['invalid appeal value', { at: 150, reason: 'Changed', appealAvailable: 'yes' }],
  ];

  for (const [name, request] of malformedRequests) {
    assert.equal(
      revokeVerification(verified, request as Parameters<typeof revokeVerification>[1]),
      null,
      name,
    );
  }
});
