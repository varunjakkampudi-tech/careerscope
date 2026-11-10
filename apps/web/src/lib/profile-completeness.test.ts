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

  it('covers every career-stage and background-source combination', () => {
    const segments = ['student', 'fresher', 'experienced', undefined] as const;
    const sources = ['education', 'experience', 'projects'] as const;

    for (const segment of segments) {
      for (const source of sources) {
        const profile = {
          ...completeProfile,
          candidate: {
            ...completeProfile.candidate,
            segment,
            education: source === 'education' ? ['BSc Computer Science'] : [],
            experience: source === 'experience' ? ['Engineer at Acme'] : [],
            projects: source === 'projects' ? ['Capstone'] : [],
          },
        };
        const expected =
          segment === 'student' || segment === 'fresher' ? source !== 'experience' : true;

        assert.equal(
          profileCompletenessChecks(profile).find((check) => check.id === 'background')?.done,
          expected,
          `${segment ?? 'unset'} candidates should ${expected ? '' : 'not '}count ${source}`,
        );
      }
    }
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

  it('ignores optional contact, link, photo, resume, location, and salary fields', () => {
    const incompleteProfile = {
      ...completeProfile,
      candidate: {
        ...completeProfile.candidate,
        fullName: '',
        email: '',
        location: '',
        segment: undefined,
        education: [],
        experience: [],
        projects: [],
      },
      preferences: { titles: [], techStack: [] },
    };
    const optionalFieldsOnly = {
      ...incompleteProfile,
      candidate: {
        ...incompleteProfile.candidate,
        phone: '+1-555-0100',
        website: 'https://example.com',
        photoUrl: 'https://example.com/photo.webp',
        resumeFilename: 'resume.pdf',
      },
      preferences: {
        ...incompleteProfile.preferences,
        locations: ['Pune'],
        salaryMin: 100000,
      },
    };
    const baselineChecks = profileCompletenessChecks(incompleteProfile);
    const optionalChecks = profileCompletenessChecks(optionalFieldsOnly);

    assert.equal(baselineChecks.length, 5);
    assert.deepEqual(optionalChecks, baselineChecks);
    assert.equal(profileCompletenessPercent(optionalChecks), 0);

    const completeWithOptionalFields = {
      ...completeProfile,
      candidate: {
        ...completeProfile.candidate,
        phone: '+1-555-0100',
        website: 'https://example.com',
        photoUrl: 'https://example.com/photo.webp',
        resumeFilename: 'resume.pdf',
      },
      preferences: {
        ...completeProfile.preferences,
        locations: ['Pune'],
        salaryMin: 100000,
      },
    };
    assert.deepEqual(
      profileCompletenessChecks(completeWithOptionalFields),
      profileCompletenessChecks(completeProfile),
    );
  });
});
