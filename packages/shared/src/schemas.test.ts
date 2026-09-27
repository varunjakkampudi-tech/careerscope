import { describe, expect, it } from 'vitest';
import { preferencesSchema } from './schemas.js';

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
