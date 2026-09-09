import assert from 'node:assert/strict';
import test from 'node:test';
import {
  encryptSnapshot,
  unlockSnapshot,
  restoreSnapshot,
} from '../mobile-site/snapshot-crypto.mjs';

test('tab key restores only the same snapshot during its idle lifetime', async () => {
  const passphrase = 'synthetic-session-test-secret';
  const data = { leads: [{ title: 'Private role' }] };
  const envelope = await encryptSnapshot(data, passphrase);
  const unlocked = await unlockSnapshot(envelope, passphrase);
  const session = {
    key: unlocked.key,
    salt: envelope.salt,
    nonce: envelope.nonce,
    lastActivity: 1000,
  };
  assert.deepEqual(unlocked.snapshot, data);
  assert.deepEqual(await restoreSnapshot(envelope, session, 2000), data);
  assert.ok(!JSON.stringify(session).includes(passphrase));
  assert.ok(!JSON.stringify(session).includes('Private role'));
  await assert.rejects(restoreSnapshot(envelope, session, 301000));
  await assert.rejects(restoreSnapshot(envelope, { ...session, lastActivity: 3000 }, 2000));
  await assert.rejects(restoreSnapshot(envelope, { ...session, key: 'invalid' }, 2000));
  const updated = await encryptSnapshot(data, passphrase);
  await assert.rejects(restoreSnapshot(updated, session, 2000));
  await assert.rejects(unlockSnapshot(envelope, 'wrong-password'));
});
