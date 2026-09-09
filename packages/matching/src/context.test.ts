import { describe, expect, it } from 'vitest';
import type { DerivedResume, MatchableProfile } from '@job-radar/shared';
import { buildCandidateContext } from './context.js';

function derived(overrides: Partial<DerivedResume> = {}): DerivedResume {
  return {
    techStack: [],
    recentSkills: [],
    titles: [],
    yearsOfExperience: null,
    ...overrides,
  };
}

function profile(
  overrides: {
    candidate?: Partial<MatchableProfile['candidate']>;
    preferences?: Partial<MatchableProfile['preferences']>;
    application?: Partial<MatchableProfile['application']>;
    derived?: DerivedResume | null;
  } = {},
): MatchableProfile {
  return {
    candidate: { location: 'Hyderabad, India', ...overrides.candidate },
    preferences: {
      titles: ['Full Stack Software Engineer'],
      techStack: ['React', 'Node.js'],
      locations: ['Hyderabad', 'Bangalore'],
      remoteOnly: false,
      minSalary: 1_600_000,
      employmentTypes: ['fulltime'],
      excludeKeywords: [],
      excludeCompanies: [],
      ...overrides.preferences,
    },
    application: {
      currentCtc: '14 LPA',
      expectedCtc: '20 LPA',
      noticePeriodDays: 60,
      willingToRelocate: true,
      yearsOfExperience: 4,
      ...overrides.application,
    },
    derived: overrides.derived === undefined ? derived() : overrides.derived,
  };
}

describe('buildCandidateContext', () => {
  it('carries the preference fields straight through', () => {
    const ctx = buildCandidateContext(profile());
    expect(ctx.remoteOnly).toBe(false);
    expect(ctx.willingToRelocate).toBe(true);
    expect(ctx.minSalary).toBe(1_600_000);
    expect(ctx.employmentTypes).toEqual(['fulltime']);
    expect(ctx.locations).toEqual(['Hyderabad', 'Bangalore']);
  });

  it('works with no resume at all', () => {
    const ctx = buildCandidateContext(profile({ derived: null }));
    expect(ctx.skills).toEqual(['React', 'Node.js']);
    expect(ctx.recentSkills).toEqual([]);
    expect(ctx.yearsOfExperience).toBe(4);
  });

  it('defaults the resume text to empty rather than undefined', () => {
    expect(buildCandidateContext(profile()).resumeText).toBe('');
  });
});

describe('buildCandidateContext — skills and titles', () => {
  it('unions what the user typed with what the resume found', () => {
    const ctx = buildCandidateContext(
      profile({
        preferences: { techStack: ['React', 'GraphQL'] },
        derived: derived({ techStack: ['Node.js', 'PostgreSQL'] }),
      }),
    );
    expect(ctx.skills).toEqual(
      expect.arrayContaining(['React', 'GraphQL', 'Node.js', 'PostgreSQL']),
    );
  });

  it('collapses aliases so the same skill is not counted twice', () => {
    const ctx = buildCandidateContext(
      profile({
        preferences: { techStack: ['react'] },
        derived: derived({ techStack: ['React.js', 'ReactJS'] }),
      }),
    );
    expect(ctx.skills).toEqual(['React']);
  });

  it('keeps recent skills separate from the full stack', () => {
    // The distinction drives the staleness discount in scoreSkills; merging them
    // would mark every skill current.
    const ctx = buildCandidateContext(
      profile({
        preferences: { techStack: ['React', 'jQuery'] },
        derived: derived({ techStack: ['React', 'jQuery'], recentSkills: ['React'] }),
      }),
    );
    expect(ctx.skills).toEqual(expect.arrayContaining(['React', 'jQuery']));
    expect(ctx.recentSkills).toEqual(['React']);
  });

  it('dedupes titles case-insensitively and drops blanks', () => {
    const ctx = buildCandidateContext(
      profile({
        preferences: { titles: ['Software Engineer', '  '] },
        derived: derived({ titles: ['software engineer', 'Senior Associate'] }),
      }),
    );
    expect(ctx.titles).toEqual(['Software Engineer', 'Senior Associate']);
  });
});

describe('buildCandidateContext — expected salary', () => {
  const expected = (ctc: string) =>
    buildCandidateContext(profile({ application: { expectedCtc: ctc } })).expectedSalary;

  it('takes the bottom of a range, not the top', () => {
    // "18-22 LPA" means 18 is acceptable. Scoring against 22 would mark every
    // offer the candidate would happily take as a shortfall.
    expect(expected('18-22 LPA')).toBe(1_800_000);
  });

  it('reads a single figure', () => {
    expect(expected('20 LPA')).toBe(2_000_000);
    expect(expected('₹24,00,000')).toBe(2_400_000);
  });

  it('is null when the user left it blank', () => {
    expect(expected('')).toBeNull();
    expect(expected('negotiable')).toBeNull();
  });
});

describe('buildCandidateContext — years of experience', () => {
  const years = (entered: number, fromResume: number | null) =>
    buildCandidateContext(
      profile({
        application: { yearsOfExperience: entered },
        derived: derived({ yearsOfExperience: fromResume }),
      }),
    ).yearsOfExperience;

  it('prefers the figure the user typed', () => {
    // They edited the form after seeing the parse, so they had the last word.
    expect(years(6, 4)).toBe(6);
  });

  it('falls back to the resume when the field was left at zero', () => {
    expect(years(0, 4)).toBe(4);
  });

  it('is zero when neither source knows', () => {
    expect(years(0, null)).toBe(0);
  });
});

describe('buildCandidateContext — home location', () => {
  it('comes from the profile, not the resume parse', () => {
    const ctx = buildCandidateContext(
      profile({
        candidate: { location: '  Hyderabad, India  ' },
        derived: derived({ location: 'Chennai' }),
      }),
    );
    expect(ctx.homeLocation).toBe('Hyderabad, India');
  });
});
