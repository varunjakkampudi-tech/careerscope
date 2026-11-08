import { describe, expect, it } from 'vitest';
import {
  candidateSchema,
  preferencesSchema,
  profileSchema,
  profileUpdateSchema,
} from './schemas.js';

describe('candidate-declared profile fields', () => {
  const profile = {
    candidate: {
      fullName: 'Synthetic Candidate',
      email: 'candidate@example.test',
      phone: '',
      location: 'Hyderabad',
      linkedin: '',
      github: '',
      portfolio: '',
    },
    preferences: { titles: ['Engineer'], techStack: ['TypeScript'] },
    application: {},
  };

  it('preserves each explicitly selected segment through the canonical profile schema', () => {
    for (const segment of ['student', 'fresher', 'experienced'] as const) {
      expect(
        profileSchema.parse({ ...profile, candidate: { ...profile.candidate, segment } }).candidate
          .segment,
      ).toBe(segment);
      expect(profileUpdateSchema.parse({ candidate: { segment } }).candidate?.segment).toBe(
        segment,
      );
    }
  });

  it('rejects unsupported values and leaves legacy profiles unclassified', () => {
    expect(
      profileSchema.safeParse({
        ...profile,
        candidate: { ...profile.candidate, segment: 'intern' },
      }).success,
    ).toBe(false);
    expect(profileUpdateSchema.safeParse({ candidate: { segment: 'intern' } }).success).toBe(false);
    expect(profileSchema.parse(profile).candidate.segment).toBeUndefined();
  });

  it('preserves unknown experience distinctly from a candidate-stated zero', () => {
    expect(profileSchema.parse(profile).application.yearsOfExperience).toBeNull();
    expect(
      profileSchema.parse({
        ...profile,
        application: { yearsOfExperience: 0 },
      }).application.yearsOfExperience,
    ).toBe(0);
    expect(
      profileSchema.safeParse({
        ...profile,
        application: { yearsOfExperience: 61 },
      }).success,
    ).toBe(false);
  });

  it('captures availability and preferred contact without confusing unknown with immediate', () => {
    expect(profileSchema.parse(profile).application).toMatchObject({
      availabilityStatus: 'immediate',
      noticePeriodDays: 0,
      preferredContactMethod: 'no_preference',
    });
    expect(
      profileSchema.parse({
        ...profile,
        application: { noticePeriodDays: 45 },
      }).application.availabilityStatus,
    ).toBe('notice_period');
    expect(
      profileSchema.parse({
        ...profile,
        application: { availabilityStatus: 'not_specified' },
      }).application,
    ).toMatchObject({
      availabilityStatus: 'not_specified',
      noticePeriodDays: 0,
    });
    expect(
      profileUpdateSchema.parse({ application: { preferredContactMethod: 'phone' } }).application,
    ).toEqual({ preferredContactMethod: 'phone' });
  });

  it('defaults recruiter visibility and field allowlist to private and empty', () => {
    expect(profileSchema.parse(profile).privacy).toEqual({
      recruiterVisible: false,
      recruiterVisibleFields: [],
    });
    expect(
      profileSchema.parse({
        ...profile,
        privacy: { recruiterVisible: true, recruiterVisibleFields: [] },
      }).privacy,
    ).toEqual({ recruiterVisible: true, recruiterVisibleFields: [] });
    expect(
      profileSchema.parse({
        ...profile,
        privacy: { recruiterVisible: true, recruiterVisibleFields: ['location', 'techStack'] },
      }).privacy,
    ).toEqual({ recruiterVisible: true, recruiterVisibleFields: ['location', 'techStack'] });
    expect(profileUpdateSchema.parse({ privacy: { recruiterVisible: true } }).privacy).toEqual({
      recruiterVisible: true,
      recruiterVisibleFields: [],
    });
    expect(profileUpdateSchema.parse({ privacy: { recruiterVisibleFields: [] } }).privacy).toEqual({
      recruiterVisibleFields: [],
    });
    expect(profileUpdateSchema.safeParse({ privacy: { recruiterVisible: 'true' } }).success).toBe(
      false,
    );
    expect(
      profileUpdateSchema.safeParse({ privacy: { recruiterVisible: true, public: true } }).success,
    ).toBe(false);
    for (const recruiterVisibleFields of [['email'], ['resumeId'], ['location', 'location']]) {
      expect(profileUpdateSchema.safeParse({ privacy: { recruiterVisibleFields } }).success).toBe(false);
    }
  });

  it('rejects inconsistent availability and notice-day combinations', () => {
    for (const application of [
      { availabilityStatus: 'immediate', noticePeriodDays: 30 },
      { availabilityStatus: 'notice_period', noticePeriodDays: 0 },
      { availabilityStatus: 'not_specified', noticePeriodDays: 20 },
      { availabilityStatus: 'not_specified', noticePeriodDays: 366 },
      { preferredContactMethod: 'text_message' },
    ]) {
      expect(profileSchema.safeParse({ ...profile, application }).success).toBe(false);
    }
  });

  it('accepts bounded education, graduation year, and project entries without changing legacy profiles', () => {
    const expanded = profileSchema.parse({
      ...profile,
      candidate: {
        ...profile.candidate,
        education: ['B.Tech, Computer Science'],
        experience: ['Frontend Engineer at Example Co (2022–2024)'],
        graduationYear: 2024,
        projects: ['Accessible job search prototype'],
      },
    });
    expect(expanded.candidate.education).toEqual(['B.Tech, Computer Science']);
    expect(expanded.candidate.experience).toEqual(['Frontend Engineer at Example Co (2022–2024)']);
    expect(expanded.candidate.graduationYear).toBe(2024);
    expect(expanded.candidate.projects).toEqual(['Accessible job search prototype']);
    expect(profileSchema.parse(profile).candidate.education).toEqual([]);
    expect(profileSchema.parse(profile).candidate.experience).toEqual([]);
    expect(profileSchema.parse(profile).candidate.projects).toEqual([]);
    for (const invalid of [
      { education: ['x'.repeat(201)] },
      { education: Array.from({ length: 21 }, (_, index) => `School ${index}`) },
      { experience: ['x'.repeat(201)] },
      { experience: Array.from({ length: 21 }, (_, index) => `Role ${index}`) },
      { graduationYear: 1899 },
      { graduationYear: 2101 },
      { graduationYear: 2024.5 },
      { projects: ['x'.repeat(201)] },
      { projects: Array.from({ length: 21 }, (_, index) => `Project ${index}`) },
    ]) {
      expect(
        profileSchema.safeParse({ ...profile, candidate: { ...profile.candidate, ...invalid } })
          .success,
      ).toBe(false);
    }
  });
});

/**
 * F-66-3. Every free-text array an owner types bounded its LENGTH and left
 * each ENTRY unbounded, beside single-value fields that had been capped at 120
 * all along. `preferences.titles` reaches stored match evidence through the
 * `reason` string, repeated across every scored job in a run, so an
 * unbounded entry is an unbounded write amplified by the result set.
 */
describe('preferencesSchema bounds every owner-typed entry, not just the array', () => {
  const valid = {
    titles: ['Senior Software Engineer'],
    techStack: ['TypeScript'],
    locations: ['Pune'],
    excludeKeywords: ['crypto'],
    excludeCompanies: ['Acme'],
  };

  // The five arrays, named individually rather than looped over an inferred
  // list: a loop derived from Object.keys(valid) would silently stop covering
  // a field the day someone adds a sixth array, which is precisely how the
  // gap arose.
  const arrays = [
    'titles',
    'techStack',
    'locations',
    'excludeKeywords',
    'excludeCompanies',
  ] as const;

  it('accepts a realistic profile, so every rejection below means something', () => {
    const parsed = preferencesSchema.parse(valid);
    expect(parsed.titles).toEqual(['Senior Software Engineer']);
    expect(parsed.techStack).toEqual(['TypeScript']);
    expect(parsed.excludeCompanies).toEqual(['Acme']);
  });

  for (const field of arrays) {
    it(`accepts a 120-character entry in ${field} and refuses 121`, () => {
      // POSITIVE AT THE BOUNDARY FIRST. A test that only asserts rejection
      // passes just as well against a schema that refuses everything, and an
      // over-strict bound is the failure mode this project has already had to
      // undo once (CS-56 F-4, the dollar sign).
      const atLimit = preferencesSchema.safeParse({ ...valid, [field]: ['a'.repeat(120)] });
      expect(atLimit.success, `${field} must accept an entry of exactly 120 characters`).toBe(true);

      const overLimit = preferencesSchema.safeParse({ ...valid, [field]: ['a'.repeat(121)] });
      expect(overLimit.success, `${field} accepted a 121-character entry`).toBe(false);
    });
  }

  it('measures length after trimming, so whitespace cannot be used to fail a real value', () => {
    const padded = preferencesSchema.safeParse({
      ...valid,
      titles: [`   ${'a'.repeat(120)}   `],
    });
    expect(padded.success).toBe(true);
    expect(padded.success && padded.data.titles[0]).toBe('a'.repeat(120));
  });

  it('still refuses an empty entry and still bounds the arrays themselves', () => {
    // The pre-existing constraints must survive the new one - a bound added by
    // replacing the element schema is exactly where an older rule gets lost.
    expect(preferencesSchema.safeParse({ ...valid, titles: [''] }).success).toBe(false);
    expect(preferencesSchema.safeParse({ ...valid, titles: [] }).success).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...valid,
        titles: Array.from({ length: 26 }, () => 'Engineer'),
      }).success,
    ).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...valid,
        excludeCompanies: Array.from({ length: 201 }, (_, index) => `Company ${index}`),
      }).success,
    ).toBe(false);
  });

  it('requires skills and accepts at most 120 skill entries', () => {
    expect(preferencesSchema.safeParse({ ...valid, techStack: [] }).success).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...valid,
        techStack: Array.from({ length: 120 }, (_, index) => `Skill ${index}`),
      }).success,
    ).toBe(true);
    expect(
      preferencesSchema.safeParse({
        ...valid,
        techStack: Array.from({ length: 121 }, (_, index) => `Skill ${index}`),
      }).success,
    ).toBe(false);
  });

  it('requires a preferred role and accepts at most 25 target titles', () => {
    expect(preferencesSchema.safeParse({ ...valid, titles: [] }).success).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...valid,
        titles: Array.from({ length: 25 }, (_, index) => `Engineer ${index}`),
      }).success,
    ).toBe(true);
    expect(
      preferencesSchema.safeParse({
        ...valid,
        titles: Array.from({ length: 26 }, (_, index) => `Engineer ${index}`),
      }).success,
    ).toBe(false);
  });

  it('bounds preferred locations and validates remote-only work mode', () => {
    expect(preferencesSchema.parse(valid).remoteOnly).toBe(false);
    expect(
      preferencesSchema.safeParse({
        ...valid,
        locations: Array.from({ length: 25 }, (_, index) => `City ${index}`),
        remoteOnly: true,
      }).success,
    ).toBe(true);
    expect(
      preferencesSchema.safeParse({
        ...valid,
        locations: Array.from({ length: 26 }, (_, index) => `City ${index}`),
      }).success,
    ).toBe(false);
    expect(preferencesSchema.safeParse({ ...valid, remoteOnly: 'true' }).success).toBe(false);
  });

  it('keeps an optional annual salary floor and normalizes its currency code', () => {
    expect(preferencesSchema.parse({ ...valid, minSalary: null }).minSalaryCurrency).toBeNull();
    expect(
      preferencesSchema.parse({ ...valid, minSalary: 1_800_000, minSalaryCurrency: ' inr ' }),
    ).toMatchObject({ minSalary: 1_800_000, minSalaryCurrency: 'INR' });
    for (const minSalary of [-1, 1.5]) {
      expect(preferencesSchema.safeParse({ ...valid, minSalary }).success).toBe(false);
    }
    for (const minSalaryCurrency of ['IN', 'INRR', '12R']) {
      expect(
        preferencesSchema.safeParse({ ...valid, minSalaryCurrency }).success,
        `${minSalaryCurrency} must not be accepted as a three-letter currency code`,
      ).toBe(false);
    }
  });
});

describe('candidateSchema location', () => {
  const valid = { fullName: 'Example Candidate', email: 'candidate@example.test' };

  it('requires a non-empty location of at most 120 characters', () => {
    expect(candidateSchema.safeParse({ ...valid, location: 'Pune, India' }).success).toBe(true);
    expect(candidateSchema.safeParse({ ...valid, location: '   ' }).success).toBe(false);
    expect(candidateSchema.safeParse({ ...valid, location: 'x'.repeat(121) }).success).toBe(false);
  });
});
