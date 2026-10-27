import assert from 'node:assert/strict';
import test from 'node:test';
import { QueryClient } from '@tanstack/react-query';
import { clearAuthQueryCache } from './query-cache.js';
import { NO_OWNER, ownerKey } from './session.js';

test('owner query keys remain distinct across candidate identities', () => {
  const ownerA = ownerKey('a'.repeat(64), 'profile', 'details');
  const ownerB = ownerKey('b'.repeat(64), 'profile', 'details');

  assert.deepEqual(ownerA, ['profile', 'a'.repeat(64), 'details']);
  assert.deepEqual(ownerB, ['profile', 'b'.repeat(64), 'details']);
  assert.notDeepEqual(ownerA, ownerB);
  assert.deepEqual(ownerKey(undefined, 'profile'), ['profile', NO_OWNER]);
});

test('authentication boundary reset always removes private cached data', () => {
  const cache = new QueryClient();
  cache.setQueryData(['profile', 'owner-a'], { fullName: 'Private Candidate A' });
  cache.setQueryData(['profile', 'owner-b'], { fullName: 'Private Candidate B' });

  clearAuthQueryCache(cache);

  assert.equal(cache.getQueryCache().getAll().length, 0);
  assert.equal(cache.getQueryData(['profile', 'owner-a']), undefined);
  assert.equal(cache.getQueryData(['profile', 'owner-b']), undefined);
  cache.clear();
});
