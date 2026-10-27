import { describe, expect, it } from 'vitest';
import {
  APPROVED_JOB_SOURCE_PROFILES,
  LAUNCH_JOB_SOURCE_CANDIDATES,
  isJobSourcePermittedForCandidateDiscovery,
  jobSourcePermissionProfileSchema,
  permittedCandidateDiscoverySources,
} from './job-source-policy.js';

const validProfile = (overrides: Record<string, unknown> = {}) =>
  jobSourcePermissionProfileSchema.parse({
    source: 'greenhouse',
    approvalRef: 'OA-2026-10-20-01',
    evidenceRef: 'rights-record:greenhouse-01',
    approvedAt: '2026-10-20T00:00:00.000Z',
    reviewBy: '2027-10-20T00:00:00.000Z',
    rights: {
      collection: true,
      storage: true,
      transformation: true,
      candidateDisplay: true,
      aiProcessing: false,
      publicDisplay: false,
      redistribution: false,
    },
    ...overrides,
  });

describe('D14 job-source permission policy', () => {
  it('has no enabled source until current source-specific owner evidence is recorded', () => {
    expect(APPROVED_JOB_SOURCE_PROFILES).toEqual([]);
    expect(permittedCandidateDiscoverySources()).toEqual([]);
    expect(isJobSourcePermittedForCandidateDiscovery('greenhouse')).toBe(false);
  });

  it('limits launch discovery candidates to the four D14 ATS source types', () => {
    expect(LAUNCH_JOB_SOURCE_CANDIDATES).toEqual(['greenhouse', 'lever', 'ashby', 'workable']);
    expect(() => validProfile({ source: 'remoteok' })).toThrow();
  });

  it('allows private discovery only with collection, storage, transformation, and candidate-display rights', () => {
    const profile = validProfile();
    expect(
      isJobSourcePermittedForCandidateDiscovery(
        'greenhouse',
        [profile],
        Date.parse('2026-10-20T12:00:00Z'),
      ),
    ).toBe(true);
    expect(
      isJobSourcePermittedForCandidateDiscovery(
        'greenhouse',
        [validProfile({ rights: { ...profile.rights, storage: false } })],
        Date.parse('2026-10-20T12:00:00Z'),
      ),
    ).toBe(false);
  });

  it('does not allow future approvals or profiles past their review date', () => {
    const profile = validProfile();
    expect(
      isJobSourcePermittedForCandidateDiscovery(
        'greenhouse',
        [profile],
        Date.parse('2026-10-19T23:59:59Z'),
      ),
    ).toBe(false);
    expect(
      isJobSourcePermittedForCandidateDiscovery(
        'greenhouse',
        [profile],
        Date.parse('2027-10-20T00:00:00Z'),
      ),
    ).toBe(false);
  });

  it('keeps AI, public display, and redistribution permissions independent', () => {
    const profile = validProfile();
    expect(
      isJobSourcePermittedForCandidateDiscovery(
        'greenhouse',
        [profile],
        Date.parse('2026-10-21T00:00:00Z'),
      ),
    ).toBe(true);
    expect(profile.rights).toMatchObject({
      aiProcessing: false,
      publicDisplay: false,
      redistribution: false,
    });
  });
});
