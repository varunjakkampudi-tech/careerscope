import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encryptSnapshot, validateEnvelope } from '../mobile-site/snapshot-crypto.mjs';
import { validatePublicSnapshot, pageFiles } from './stage-pages.mjs';

test('Pages rejects plaintext admin data and private fields in public jobs', async () => {
  const encrypted = await encryptSnapshot({ leads: [] }, 'synthetic-staging-secret');
  assert.doesNotThrow(() => validateEnvelope(encrypted));
  assert.throws(() => validateEnvelope({ ...encrypted, password: 'oops' }));
  assert.throws(() => validateEnvelope({ leads: [] }));
  const job = {
    title: 'Role',
    company: 'Example',
    location: 'Remote',
    source: 'lever',
    postedAt: null,
    url: 'https://jobs.lever.co/example/123',
  };
  const fixture = { updatedAt: '2026-09-09T00:00:00Z', jobs: [job] };
  assert.doesNotThrow(() => validatePublicSnapshot(fixture));
  assert.throws(() => validatePublicSnapshot({ ...fixture, jobs: [{ ...job, score: 0.9 }] }));
  assert.throws(() =>
    validatePublicSnapshot({
      ...fixture,
      jobs: [{ ...job, url: 'https://jobs.lever.co/example/123?secret=value' }],
    }),
  );
  assert.ok(!pageFiles.some((name) => name.includes('.env') || name.endsWith('.db')));
});
