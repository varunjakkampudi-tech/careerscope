import { describe, expect, it } from 'vitest';
import { preferencesSchema, profileSchema, profileUpdateSchema } from './schemas.js';

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

  it('accepts bounded education, graduation year, and project entries without changing legacy profiles', () => {
    const expanded = profileSchema.parse({
      ...profile,
      candidate: {
        ...profile.candidate,
        education: ['B.Tech, Computer Science'],
        graduationYear: 2024,
        projects: ['Accessible job search prototype'],
      },
    });
    expect(expanded.candidate.education).toEqual(['B.Tech, Computer Science']);
    expect(expanded.candidate.graduationYear).toBe(2024);
    expect(expanded.candidate.projects).toEqual(['Accessible job search prototype']);
    expect(profileSchema.parse(profile).candidate.education).toEqual([]);
    expect(profileSchema.parse(profile).candidate.projects).toEqual([]);
    for (const invalid of [
      { education: ['x'.repeat(201)] },
      { education: Array.from({ length: 21 }, (_, index) => `School ${index}`) },
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
});
