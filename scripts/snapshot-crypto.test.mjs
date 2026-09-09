import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { test } from 'node:test';
import { encryptSnapshot, decryptSnapshot } from '../mobile-site/snapshot-crypto.mjs';

test('round trip, random encryption, wrong password and tampering', async () => {
  const fixture = { leads: [{ title: 'PRIVATE_TEST_MARKER', score: 0.91 }] };
  const passphrase = 'synthetic-test-passphrase-only';
  const encrypted = await encryptSnapshot(fixture, passphrase);
  assert.deepEqual(await decryptSnapshot(encrypted, passphrase), fixture);
  assert.ok(!JSON.stringify(encrypted).includes('PRIVATE_TEST_MARKER'));
  assert.notEqual((await encryptSnapshot(fixture, passphrase)).ciphertext, encrypted.ciphertext);
  await assert.rejects(decryptSnapshot(encrypted, 'wrong-test-passphrase'));
  const bytes = Buffer.from(encrypted.ciphertext, 'base64');
  bytes[0] ^= 1;
  await assert.rejects(
    decryptSnapshot({ ...encrypted, ciphertext: bytes.toString('base64') }, passphrase),
  );
  await assert.rejects(decryptSnapshot({ ...encrypted, iterations: 1 }, passphrase));
  await assert.rejects(encryptSnapshot(fixture, 'short'));
});
