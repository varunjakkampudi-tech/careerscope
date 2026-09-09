const iterations = 600000;
const encoder = new TextEncoder();
const context = encoder.encode('CareerScope admin snapshot v1');

function encode(bytes) {
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
}

function decode(value) {
  if (typeof value !== 'string') throw new Error('Invalid snapshot');
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptSnapshot(snapshot, passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 16)
    throw new Error('Use a unique passphrase of at least 16 characters.');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: context },
    key,
    encoder.encode(JSON.stringify(snapshot)),
  );
  return {
    version: 1,
    algorithm: 'AES-256-GCM',
    kdf: 'PBKDF2-SHA256',
    iterations,
    salt: encode(salt),
    nonce: encode(nonce),
    ciphertext: encode(new Uint8Array(encrypted)),
  };
}

export function validateEnvelope(envelope) {
  if (
    envelope?.version !== 1 ||
    envelope.algorithm !== 'AES-256-GCM' ||
    envelope.kdf !== 'PBKDF2-SHA256' ||
    envelope.iterations !== iterations
  )
    throw new Error('Unsupported snapshot');
  const fields = ['version', 'algorithm', 'kdf', 'iterations', 'salt', 'nonce', 'ciphertext'];
  if (
    Object.keys(envelope).length !== fields.length ||
    Object.keys(envelope).some((key) => !fields.includes(key))
  )
    throw new Error('Unexpected snapshot fields');
  const salt = decode(envelope.salt);
  const nonce = decode(envelope.nonce);
  const ciphertext = decode(envelope.ciphertext);
  if (
    salt.length !== 16 ||
    nonce.length !== 12 ||
    ciphertext.length < 16 ||
    ciphertext.length > 25000000
  )
    throw new Error('Invalid snapshot');
  return { salt, nonce, ciphertext };
}

export async function decryptSnapshot(envelope, passphrase) {
  const { salt, nonce, ciphertext } = validateEnvelope(envelope);
  const key = await deriveKey(passphrase, salt);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: context },
    key,
    ciphertext,
  );
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decrypted));
}
