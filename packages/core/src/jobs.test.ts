import assert from 'node:assert/strict';
import test from 'node:test';
import { collectedJobSchema } from './jobs.js';

const legacyJob = {
  fingerprint: 'job-fingerprint',
  title: 'Backend Engineer',
  company: 'Acme',
  location: 'Remote',
  description: 'Build backend services.',
  source: 'greenhouse',
  sourceUrl: 'https://boards.greenhouse.io/acme/jobs/1',
  applyUrl: 'https://boards.greenhouse.io/acme/jobs/1',
  postedAt: null,
  match: null,
} as const;

test('legacy collected jobs receive unknown employer domain evidence', () => {
  assert.deepEqual(collectedJobSchema.parse(legacyJob).employerDomainCheck, {
    status: 'unknown',
    companyHost: null,
    applyHost: null,
  });
});

test('collected job domain evidence rejects unrecognized fields', () => {
  assert.throws(() =>
    collectedJobSchema.parse({
      ...legacyJob,
      employerDomainCheck: {
        status: 'different-host',
        companyHost: 'acme.example',
        applyHost: 'apply.example',
        verified: true,
      },
    }),
  );
});
