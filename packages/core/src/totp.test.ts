import assert from 'node:assert/strict';
import test from 'node:test';
import {
  authenticatorUri,
  decodeBase32,
  decryptTotpSecret,
  encodeBase32,
  encryptTotpSecret,
  hotp,
  matchingStep,
} from './totp.js';

// RFC 4226 Appendix D: the HOTP values for the secret "12345678901234567890".
const rfcSecret = Buffer.from('12345678901234567890', 'ascii');
const rfc4226: string[] = [
  '755224',
  '287082',
  '359152',
  '969429',
  '338314',
  '254676',
  '287922',
  '162583',
];

test('HOTP matches the RFC 4226 test vectors', () => {
  rfc4226.forEach((code, counter) => assert.equal(hotp(rfcSecret, counter), code));
});

test('a code matches its time step and the steps either side, and nothing else', () => {
  const nowMs = 59_000;
  // RFC 6238 time 59 is step 1, whose 6-digit code is 287082.
  assert.equal(matchingStep(rfcSecret, '287082', nowMs), 1);
  assert.equal(matchingStep(rfcSecret, rfc4226[0]!, nowMs), 0, 'the previous step is accepted');
  assert.equal(matchingStep(rfcSecret, rfc4226[2]!, nowMs), 2, 'the next step is accepted');
  assert.equal(matchingStep(rfcSecret, rfc4226[4]!, nowMs), null, 'two steps away is refused');
  assert.equal(matchingStep(rfcSecret, '28708', nowMs), null, 'a short code is refused');
  assert.equal(matchingStep(rfcSecret, '00000A', nowMs), null, 'a non-numeric code is refused');
});

test('base32 round-trips and the authenticator URI carries the account label and secret', () => {
  const bytes = Buffer.from('careerscope-secret-bytes', 'utf8');
  assert.deepEqual(decodeBase32(encodeBase32(bytes)), bytes);
  const uri = authenticatorUri(rfcSecret, 'admin@example.test');
  assert.match(uri, /^otpauth:\/\/totp\/CareerScope%3Aadmin%40example\.test\?/);
  assert.ok(uri.includes(`secret=${encodeBase32(rfcSecret)}`));
  assert.ok(uri.includes('algorithm=SHA1&digits=6&period=30'));
});

test('stored secrets are encrypted, decrypt only with the same key, and reject tampering', () => {
  const key = Buffer.alloc(32, 7);
  const stored = encryptTotpSecret(rfcSecret, key);
  assert.notEqual(stored, encodeBase32(rfcSecret));
  assert.deepEqual(decryptTotpSecret(stored, key), rfcSecret);
  assert.throws(() => decryptTotpSecret(stored, Buffer.alloc(32, 8)));
  const bytes = Buffer.from(stored, 'base64');
  bytes[bytes.length - 1]! ^= 1;
  assert.throws(() => decryptTotpSecret(bytes.toString('base64'), key));
});
