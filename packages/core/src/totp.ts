/**
 * Time-based one-time passwords (RFC 6238 over RFC 4226) for administrator sign-in (V12-4.1-012).
 * Only Node's built-in crypto is used. The secret is encrypted at rest with a key derived from the
 * application's email OTP secret, so it never appears in the database in plain text.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const stepSeconds = 30;
const digits = 6;
/** Accept the previous and next step to absorb clock drift between the server and the authenticator app. */
const driftSteps = 1;
const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

export function decodeBase32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const char of text.toUpperCase().replace(/=+$/, '')) {
    const index = base32Alphabet.indexOf(char);
    if (index < 0) throw new Error('Invalid base32 secret');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/** A new 160-bit secret, the size RFC 4226 recommends for HMAC-SHA1. */
export function generateTotpSecret(): Buffer {
  return randomBytes(20);
}

/** The RFC 4226 HOTP value for one counter. */
export function hotp(secret: Uint8Array, counter: number): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac('sha1', secret).update(message).digest();
  const offset = hash[hash.length - 1]! & 0x0f;
  const binary =
    ((hash[offset]! & 0x7f) << 24) |
    ((hash[offset + 1]! & 0xff) << 16) |
    ((hash[offset + 2]! & 0xff) << 8) |
    (hash[offset + 3]! & 0xff);
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export function timeStep(nowMs: number): number {
  return Math.floor(nowMs / 1000 / stepSeconds);
}

/**
 * The time step a code matches, or null. The comparison is constant time for each candidate. Callers
 * must still refuse a step at or below the account's last accepted step, so a code cannot be reused.
 */
export function matchingStep(secret: Uint8Array, code: string, nowMs: number): number | null {
  const current = timeStep(nowMs);
  const supplied = Buffer.from(code);
  for (let step = current - driftSteps; step <= current + driftSteps; step += 1) {
    const candidate = Buffer.from(hotp(secret, step));
    if (candidate.length === supplied.length && timingSafeEqual(candidate, supplied)) return step;
  }
  return null;
}

export function authenticatorUri(secret: Uint8Array, accountEmail: string): string {
  const label = encodeURIComponent(`CareerScope:${accountEmail}`);
  return `otpauth://totp/${label}?secret=${encodeBase32(secret)}&issuer=CareerScope&algorithm=SHA1&digits=${digits}&period=${stepSeconds}`;
}

function encryptionKey(masterSecret: Uint8Array): Buffer {
  return Buffer.from(
    hkdfSync('sha256', masterSecret, Buffer.alloc(0), 'careerscope-totp-secret-v1', 32),
  );
}

/** Encrypts with AES-256-GCM. The stored value is base64 of nonce, tag and ciphertext. */
export function encryptTotpSecret(secret: Uint8Array, masterSecret: Uint8Array): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(masterSecret), nonce);
  const body = Buffer.concat([cipher.update(secret), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString('base64');
}

export function decryptTotpSecret(stored: string, masterSecret: Uint8Array): Buffer {
  const bytes = Buffer.from(stored, 'base64');
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(masterSecret),
    bytes.subarray(0, 12),
  );
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]);
}
