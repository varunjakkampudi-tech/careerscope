import { describe, expect, it } from 'vitest';
import type { RawJob } from '@careerscope/shared';
import { normalizeJob } from './normalize.js';
import { buildJobTrustEvidence } from './trust-evidence.js';

const sourceUrl = 'https://boards.example/jobs/123';

function job(overrides: Partial<RawJob> = {}) {
  return normalizeJob(
    {
      source: 'greenhouse',
      sourceJobId: '123',
      title: 'Software Engineer',
      companyName: 'Example Corp',
      description: 'Build reliable software.',
      hasFullDescription: true,
      sourceUrl,
      applyUrl: 'https://apply.example/jobs/123',
      companyWebsite: 'https://example.com',
      companyCareersUrl: 'https://example.com/careers',
      sourcePublisher: 'LinkedIn',
      postedAt: '2026-11-20T00:00:00.000Z',
      ...overrides,
    },
    { now: Date.parse('2026-11-20T12:00:00.000Z') },
  );
}

describe('buildJobTrustEvidence', () => {
  it('records source-linked observations and keeps provider claims labeled as reported', () => {
    const evidence = buildJobTrustEvidence(job(), [
      { source: 'lever', url: 'https://jobs.example/roles/123' },
      { source: 'remoteok', url: 'https://remoteok.com/remote-jobs/123' },
    ]);

    expect(evidence.filter((entry) => entry.kind === 'source_listing')).toEqual([
      {
        kind: 'source_listing',
        status: 'observed',
        source: 'greenhouse',
        referenceUrl: sourceUrl,
        value: null,
      },
      {
        kind: 'source_listing',
        status: 'observed',
        source: 'lever',
        referenceUrl: 'https://jobs.example/roles/123',
        value: null,
      },
      {
        kind: 'source_listing',
        status: 'observed',
        source: 'remoteok',
        referenceUrl: 'https://remoteok.com/remote-jobs/123',
        value: null,
      },
    ]);
    expect(evidence.find((entry) => entry.kind === 'employer_website_claim')).toMatchObject({
      status: 'provider_reported',
      source: 'greenhouse',
      referenceUrl: sourceUrl,
      value: 'example.com',
    });
    expect(evidence.find((entry) => entry.kind === 'application_destination')).toMatchObject({
      status: 'observed',
      referenceUrl: 'https://apply.example/jobs/123',
      value: 'apply.example',
    });
    expect(evidence.map((entry) => entry.kind)).not.toContain('fraud_verdict');
  });

  it('records missing provider claims as not provided and distinguishes teaser from missing description', () => {
    const normalized = job({
      companyWebsite: undefined,
      companyCareersUrl: undefined,
      sourcePublisher: undefined,
      postedAt: undefined,
      description: 'Short teaser.',
      hasFullDescription: false,
    });
    const evidence = buildJobTrustEvidence(normalized);

    expect(evidence.find((entry) => entry.kind === 'publisher_attribution')).toMatchObject({
      status: 'not_provided',
      value: null,
    });
    expect(evidence.find((entry) => entry.kind === 'employer_website_claim')).toMatchObject({
      status: 'not_provided',
      value: null,
    });
    expect(evidence.find((entry) => entry.kind === 'posted_date_claim')).toMatchObject({
      status: 'not_provided',
      value: null,
    });
    expect(evidence.find((entry) => entry.kind === 'description_availability')).toMatchObject({
      status: 'observed',
      value: 'partial',
    });
  });

  it('collapses same-source references deterministically', () => {
    const links = [
      { source: 'lever' as const, url: 'https://jobs.example/z' },
      { source: 'lever' as const, url: 'https://jobs.example/a' },
    ];
    const forward = buildJobTrustEvidence(job(), links);
    const reverse = buildJobTrustEvidence(job(), [...links].reverse());

    expect(forward).toEqual(reverse);
    expect(forward.filter((entry) => entry.kind === 'source_listing')).toHaveLength(2);
    expect(
      forward.find((entry) => entry.kind === 'source_listing' && entry.source === 'lever'),
    ).toMatchObject({ referenceUrl: 'https://jobs.example/a' });
  });

  it('keeps credentials out of employer-host evidence and bounds untrusted claim text', () => {
    const evidence = buildJobTrustEvidence(
      job({
        companyWebsite: 'https://user:secret@example.com/careers',
        sourcePublisher: 'Publisher '.repeat(200),
      }),
    );

    expect(evidence.find((entry) => entry.kind === 'employer_website_claim')?.value).toBe(
      'example.com',
    );
    expect(evidence.find((entry) => entry.kind === 'publisher_attribution')?.value).toHaveLength(
      500,
    );
    expect(JSON.stringify(evidence)).not.toContain('secret');
  });
});
