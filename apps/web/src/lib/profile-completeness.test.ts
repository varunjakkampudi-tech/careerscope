import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { profileCompletenessChecks, profileCompletenessPercent } from './profile-completeness';

const completeProfile = {
  candidate: {
    fullName: 'Sam Candidate',
    email: 'sam@example.com',
    location: 'Pune',
    segment: 'student' as const,
    education: ['BSc Computer Science'],
    experience: [],
    projects: [],
  },
  preferences: { titles: ['Software Engineer'], techStack: ['TypeScript'] },
};

describe('profile completeness checklist', () => {
  it('shows an honest empty-profile checklist and zero percent', () => {
    const checks = profileCompletenessChecks(null);
    assert.equal(checks.length, 5);
    assert.ok(checks.every((check) => !check.done));
    assert.equal(profileCompletenessPercent(checks), 0);
  });

  it('counts only saved profile fields, not unrelated activity or optional data', () => {
    const checks = profileCompletenessChecks(completeProfile);
    assert.ok(checks.every((check) => check.done));
    assert.equal(profileCompletenessPercent(checks), 100);
    assert.deepEqual(
      checks.map((check) => check.id),
      ['contact', 'location', 'background', 'target-role', 'skills'],
    );
  });

  it('calculates exact intermediate percentages', () => {
    for (const [completed, percent] of [
      [1, 20],
      [2, 40],
      [3, 60],
      [4, 80],
    ] as const) {
      const checks = profileCompletenessChecks({
        ...completeProfile,
        candidate: {
          ...completeProfile.candidate,
          fullName: completed >= 1 ? 'Sam Candidate' : '',
          location: completed >= 2 ? 'Pune' : '',
          education: completed >= 3 ? ['BSc Computer Science'] : [],
        },
        preferences: {
          titles: completed >= 4 ? ['Software Engineer'] : [],
          techStack: [],
        },
      });
      assert.equal(profileCompletenessPercent(checks), percent);
    }
  });

  it('uses the selected stage to accept relevant background information', () => {
    const fresher = {
      ...completeProfile,
      candidate: {
        ...completeProfile.candidate,
        segment: 'fresher' as const,
        education: [],
        projects: ['Capstone'],
      },
    };
    const experienced = {
      ...completeProfile,
      candidate: {
        ...completeProfile.candidate,
        segment: 'experienced' as const,
        education: [],
        experience: ['Engineer at Acme'],
      },
    };
    assert.equal(
      profileCompletenessChecks(fresher).find((check) => check.id === 'background')?.done,
      true,
    );
    assert.equal(
      profileCompletenessChecks(experienced).find((check) => check.id === 'background')?.done,
      true,
    );
  });

  it('does not award completion for whitespace-only entries or infer an unset career stage', () => {
    const profile = {
      ...completeProfile,
      candidate: {
        ...completeProfile.candidate,
        segment: undefined,
        education: ['  '],
        experience: [],
        projects: [],
      },
      preferences: { titles: [' '], techStack: [] },
    };
    const checks = profileCompletenessChecks(profile);
    assert.equal(checks.find((check) => check.id === 'background')?.done, false);
    assert.equal(checks.find((check) => check.id === 'target-role')?.done, false);
    assert.equal(checks.find((check) => check.id === 'skills')?.done, false);
  });

  it('accepts education for experienced candidates and does not require optional profile data', () => {
    const experienced = {
      ...completeProfile,
      candidate: {
        ...completeProfile.candidate,
        segment: 'experienced' as const,
        experience: [],
      },
    };
    const checks = profileCompletenessChecks(experienced);
    assert.equal(checks.find((check) => check.id === 'background')?.done, true);
    assert.equal(checks.length, 5);
  });
});
