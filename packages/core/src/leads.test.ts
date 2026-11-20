import assert from 'node:assert/strict';
import test from 'node:test';
import { leadTagsSchema, updateLeadSchema } from './leads.js';
import { collectedJobSchema } from './jobs.js';

test('collected job schema keeps legacy missing match values normalized to null', () => {
  const job = collectedJobSchema.parse({
    fingerprint: 'synthetic-job',
    title: 'Synthetic engineer',
    company: 'Synthetic company',
    location: 'Remote',
    description: 'Synthetic description',
    source: 'remoteok',
    sourceUrl: 'https://jobs.example.test/source',
    applyUrl: 'https://jobs.example.test/apply',
    postedAt: null,
  });

  assert.equal(job.match, null);
  assert.deepEqual(job.trustEvidence, []);
});

test('collected job trust evidence requires secure source-linked references', () => {
  const base = {
    fingerprint: 'synthetic-job',
    title: 'Synthetic engineer',
    company: 'Synthetic company',
    location: 'Remote',
    description: 'Synthetic description',
    source: 'remoteok' as const,
    sourceUrl: 'https://jobs.example.test/source',
    applyUrl: 'https://jobs.example.test/apply',
    postedAt: null,
  };

  assert.equal(
    collectedJobSchema.safeParse({
      ...base,
      trustEvidence: [
        {
          kind: 'source_listing',
          status: 'observed',
          source: 'remoteok',
          referenceUrl: 'http://jobs.example.test/source',
          value: null,
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    collectedJobSchema.safeParse({
      ...base,
      trustEvidence: [
        {
          kind: 'source_listing',
          status: 'observed',
          source: 'remoteok',
          referenceUrl: 'https://user:secret@jobs.example.test/source',
          value: null,
        },
      ],
    }).success,
    false,
  );
  assert.equal(
    collectedJobSchema.safeParse({
      ...base,
      trustEvidence: [
        {
          kind: 'publisher_attribution',
          status: 'observed',
          source: 'remoteok',
          referenceUrl: 'https://jobs.example.test/source',
          value: 'LinkedIn',
        },
      ],
    }).success,
    false,
  );
});

test('lead tags are trimmed, bounded and case-insensitively unique', () => {
  assert.deepEqual(leadTagsSchema.parse(['  Frontend  ', 'Remote']), ['Frontend', 'Remote']);
  assert.equal(leadTagsSchema.safeParse(['Frontend', ' frontend ']).success, false);
  assert.equal(leadTagsSchema.safeParse(['']).success, false);
  assert.equal(leadTagsSchema.safeParse(['Remote, hybrid']).success, false);
  assert.equal(leadTagsSchema.safeParse(['x'.repeat(33)]).success, false);
  assert.equal(leadTagsSchema.safeParse(['🙂'.repeat(32)]).success, true);
  assert.equal(leadTagsSchema.safeParse(['🙂'.repeat(33)]).success, false);
  assert.deepEqual(leadTagsSchema.parse(['\u00a0Remote\u00a0']), ['Remote']);
  assert.equal(
    leadTagsSchema.safeParse(Array.from({ length: 13 }, (_, index) => `tag-${index}`)).success,
    false,
  );
  assert.equal(leadTagsSchema.safeParse(['has\nnewline']).success, false);
});

test('lead update accepts tags only within the existing optimistic-revision contract', () => {
  const base = { revision: 1, notes: '', status: 'saved' as const };
  assert.deepEqual(updateLeadSchema.parse({ ...base, tags: ['Remote'] }).tags, ['Remote']);
  assert.equal(updateLeadSchema.safeParse({ ...base, tags: ['x'.repeat(33)] }).success, false);
  assert.equal(
    updateLeadSchema.safeParse({ ...base, ownerId: 'not-client-controlled' }).success,
    false,
  );
});
