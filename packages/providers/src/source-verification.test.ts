import { describe, expect, it } from 'vitest';
import { verifySourceUrl } from './source-verification.js';

describe('verifySourceUrl', () => {
  it('matches a configured direct-provider host exactly', () => {
    expect(verifySourceUrl('greenhouse', 'https://job-boards.greenhouse.io/acme/jobs/123')).toEqual(
      {
        status: 'configured_host_match',
        reason: 'host_match',
      },
    );
  });

  it('permits explicitly configured subdomains at a DNS label boundary', () => {
    expect(verifySourceUrl('remoteok', 'https://www.remoteok.com/remote-jobs/123').status).toBe(
      'configured_host_match',
    );
    expect(verifySourceUrl('remoteok', 'https://remoteok.com.evil.test/job').status).toBe(
      'unverified',
    );
  });

  it('does not accept a lookalike or another configured provider host', () => {
    expect(
      verifySourceUrl('greenhouse', 'https://boards.greenhouse.io.evil.test/acme/123'),
    ).toEqual({
      status: 'unverified',
      reason: 'host_not_configured',
    });
    expect(verifySourceUrl('remoteok', 'https://jobs.lever.co/acme/123')).toEqual({
      status: 'unverified',
      reason: 'host_mismatch',
    });
  });

  it('leaves aggregator destinations unverified when their host is not configured', () => {
    expect(verifySourceUrl('jsearch', 'https://boards.greenhouse.io/acme/jobs/123')).toEqual({
      status: 'unverified',
      reason: 'unconfigured_source',
    });
  });

  it.each([
    ['malformed', 'not a URL', 'invalid_url'],
    ['non-web', 'javascript:alert(1)', 'invalid_url'],
    [
      'credential-bearing',
      'https://user:secret@boards.greenhouse.io/acme/123',
      'credentials_present',
    ],
    ['non-standard port', 'https://boards.greenhouse.io:8443/acme/123', 'invalid_url'],
  ] as const)('keeps %s URLs unverified', (_label, url, reason) => {
    expect(verifySourceUrl('greenhouse', url)).toEqual({ status: 'unverified', reason });
  });
});
