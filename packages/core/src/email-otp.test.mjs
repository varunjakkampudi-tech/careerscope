import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import test from 'node:test';
import {
  createEmailOtp,
  emailOtpLifetimeMs,
  emailOtpMaximumAttempts,
  verifyEmailOtp,
} from './email-otp.ts';

const challengeId = 'f3040401-c357-4d17-8000-000000000001';
const secret = Buffer.from('0123456789abcdef0123456789abcdef');
const now = 1_800_000_000_000;

function verify(otp, overrides = {}) {
  return verifyEmailOtp({
    challengeId,
    code: otp.code,
    digest: otp.digest,
    secret,
    expiresAt: otp.expiresAt,
    attempts: 0,
    now,
    ...overrides,
  });
}

test('creates a six-digit code and a challenge-bound digest with a fixed lifetime', () => {
  const otp = createEmailOtp(challengeId, secret, now);

  assert.match(otp.code, /^\d{6}$/);
  assert.match(otp.digest, /^[a-f0-9]{64}$/);
  assert.notEqual(otp.digest, otp.code);
  assert.equal(otp.expiresAt, now + emailOtpLifetimeMs);
  assert.equal(verify(otp), 'accepted');
});

test('rejects a code verified against a different challenge identifier', () => {
  const otp = createEmailOtp(challengeId, secret, now);

  assert.equal(verify(otp, { challengeId: 'f3040401-c357-4d17-8000-000000000002' }), 'incorrect');
});

test('rejects a code verified with a different server secret', () => {
  const otp = createEmailOtp(challengeId, secret, now);

  assert.equal(
    verify(otp, { secret: Buffer.from('abcdef0123456789abcdef0123456789') }),
    'incorrect',
  );
});

test('rejects malformed codes without attempting a digest comparison', () => {
  const otp = createEmailOtp(challengeId, secret, now);

  for (const code of ['', '12345', '1234567', '12x456', 123456, null])
    assert.equal(verify(otp, { code }), 'incorrect');
});

test('expires at the exact expiration boundary', () => {
  const otp = createEmailOtp(challengeId, secret, now);

  assert.equal(verify(otp, { now: otp.expiresAt - 1 }), 'accepted');
  assert.equal(verify(otp, { now: otp.expiresAt }), 'expired');
});

test('rejects verification after the attempt budget is exhausted', () => {
  const otp = createEmailOtp(challengeId, secret, now);

  assert.equal(verify(otp, { attempts: emailOtpMaximumAttempts }), 'exhausted');
});

test('fails closed for malformed stored digests and attempt metadata', () => {
  const otp = createEmailOtp(challengeId, secret, now);

  assert.equal(verify(otp, { digest: 'not-a-digest' }), 'invalid');
  assert.equal(verify(otp, { attempts: -1 }), 'invalid');
  assert.equal(verify(otp, { expiresAt: Number.NaN }), 'invalid');
});

test('requires a valid UUID, a 32-byte key, and safe timestamp bounds', () => {
  assert.throws(() => createEmailOtp('not-a-uuid', secret, now), /challenge identifier/);
  assert.throws(
    () => createEmailOtp(challengeId, Buffer.alloc(31), now),
    /key must be at least 32 bytes/,
  );
  assert.throws(() => createEmailOtp(challengeId, secret, Number.NaN), /creation time/);
  assert.throws(
    () => createEmailOtp(challengeId, secret, Number.MAX_SAFE_INTEGER),
    /expiration time/,
  );
  assert.equal(
    verify({ code: '000000', digest: 'x'.repeat(64), expiresAt: now }, { secret: 'invalid' }),
    'invalid',
  );
});

test('permits the final attempt but rejects attempts after the configured maximum', () => {
  const otp = createEmailOtp(challengeId, secret, now);
  const wrongCode = otp.code === '000000' ? '000001' : '000000';

  assert.equal(
    verify(otp, { code: wrongCode, attempts: emailOtpMaximumAttempts - 1 }),
    'incorrect',
  );
  assert.equal(verify(otp, { attempts: emailOtpMaximumAttempts }), 'exhausted');
});
