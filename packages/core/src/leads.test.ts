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
});

test('collected job schema reads historical seven-dimension match records without rescoring them', () => {
  const historical = {
    scoringVersion: 'deterministic-v2',
    score: 0.81,
    heuristicScore: 0.79,
    dimensions: {
      compensation: { score: 0.8, weight: 0.1, reason: 'within range' },
      experience: { score: 1, weight: 0.2, reason: 'within range' },
      location: { score: 0.7, weight: 0.15, reason: 'unknown' },
      recency: { score: 0.9, weight: 0.1, reason: 'recent' },
      seniority: { score: 0.8, weight: 0.1, reason: 'aligned' },
      skills: { score: 0.9, weight: 0.25, reason: 'matched' },
      title: { score: 0.8, weight: 0.1, reason: 'aligned' },
    },
    matchedSkills: ['TypeScript'],
    missingSkills: [],
    confidence: 'high',
  };
  const job = collectedJobSchema.parse({
    fingerprint: 'historical-job',
    title: 'Historical engineer',
    company: 'Synthetic company',
    location: 'Remote',
    description: 'Historical description',
    source: 'remoteok',
    sourceUrl: 'https://jobs.example.test/source',
    applyUrl: 'https://jobs.example.test/apply',
    postedAt: null,
    match: historical,
  });

  assert.equal(job.match?.score, 0.81);
  assert.equal(job.match?.scoringVersion, 'deterministic-v2');
  assert.deepEqual(job.match?.dimensions.education, {
    score: 0,
    weight: 0,
    reason: 'Not recorded for this scoring version',
  });

  for (const invalidMatch of [
    { ...historical, unexpected: true },
    {
      ...historical,
      dimensions: { ...historical.dimensions, unexpected: { score: 0, weight: 0, reason: '' } },
    },
    {
      ...historical,
      scoringVersion: 'deterministic-v3',
      dimensions: historical.dimensions,
    },
  ]) {
    assert.equal(
      collectedJobSchema.safeParse({
        fingerprint: 'invalid-historical-job',
        title: 'Historical engineer',
        company: 'Synthetic company',
        location: 'Remote',
        description: 'Historical description',
        source: 'remoteok',
        sourceUrl: 'https://jobs.example.test/source',
        applyUrl: 'https://jobs.example.test/apply',
        postedAt: null,
        match: invalidMatch,
      }).success,
      false,
    );
  }

  const currentNullVersion = collectedJobSchema.parse({
    fingerprint: 'current-null-version-job',
    title: 'Current engineer',
    company: 'Synthetic company',
    location: 'Remote',
    description: 'Current description',
    source: 'remoteok',
    sourceUrl: 'https://jobs.example.test/source',
    applyUrl: 'https://jobs.example.test/apply',
    postedAt: null,
    match: {
      ...historical,
      scoringVersion: null,
      dimensions: {
        ...historical.dimensions,
        education: { score: 0.7, weight: 0.05, reason: 'unknown' },
      },
    },
  });
  assert.equal(currentNullVersion.match?.scoringVersion, null);
  assert.equal(currentNullVersion.match?.dimensions.education.weight, 0.05);
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
