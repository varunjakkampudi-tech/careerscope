import { describe, expect, it } from 'vitest';
import type { JobDemands } from '@job-radar/shared';
import {
  scoreCompensation,
  scoreExperience,
  scoreLocation,
  scoreRecency,
  scoreSeniority,
  scoreSkills,
  scoreTitle,
} from './dimensions.js';
import { NOW, candidate, job } from './matching.fixtures.js';

function demands(overrides: Partial<JobDemands> = {}): JobDemands {
  return {
    skills: [],
    minYears: null,
    maxYears: null,
    seniority: null,
    isRemote: false,
    employmentType: null,
    ...overrides,
  };
}

const ask = (...skills: string[]) => skills.map((skill) => ({ skill, weight: 1 }));

describe('scoreSkills', () => {
  it('gives full marks when every demanded skill is held and current', () => {
    const out = scoreSkills(
      demands({ skills: ask('React', 'TypeScript', 'REST API') }),
      candidate(),
    );
    expect(out.dimension.score).toBe(1);
    expect(out.missing).toEqual([]);
  });

  it('scores against the job, not the size of the candidate stack', () => {
    // This is the bug the old matcher had: naming 3 of a 33-skill stack used to
    // cap the score near 9%.
    const out = scoreSkills(demands({ skills: ask('React', 'Node.js', 'AWS') }), candidate());
    expect(out.dimension.score).toBeGreaterThan(0.9);
  });

  it('discounts a skill the candidate holds but has not used lately', () => {
    const recent = scoreSkills(demands({ skills: ask('React') }), candidate());
    const stale = scoreSkills(demands({ skills: ask('MongoDB') }), candidate());
    expect(recent.dimension.score).toBe(1);
    expect(stale.dimension.score).toBeCloseTo(0.9, 5);
  });

  it('gives partial credit for an adjacent skill and still calls it missing', () => {
    // Vue is in the same family as React, which the candidate knows well.
    const out = scoreSkills(demands({ skills: ask('Vue') }), candidate());
    expect(out.dimension.score).toBeGreaterThan(0);
    expect(out.dimension.score).toBeLessThan(0.6);
    expect(out.missing).toEqual(['Vue']);
    expect(out.matched).toEqual([]);
  });

  it('weights a rare demand above a common one', () => {
    const me = candidate({ skills: ['JavaScript'], recentSkills: ['JavaScript'] });
    // JavaScript (0.6) held, Temporal (1.9) not — the miss dominates.
    const rareMiss = scoreSkills(demands({ skills: ask('JavaScript', 'Temporal') }), me);
    // JavaScript (0.6) held, HTML5 (0.5) not — the miss barely registers.
    const commonMiss = scoreSkills(demands({ skills: ask('JavaScript', 'HTML5') }), me);
    expect(rareMiss.dimension.score).toBeLessThan(commonMiss.dimension.score);
  });

  it('weights a required skill above a preferred one', () => {
    const me = candidate({ skills: ['React'], recentSkills: ['React'] });
    const missPreferred = scoreSkills(
      demands({
        skills: [
          { skill: 'React', weight: 1 },
          { skill: 'Kafka', weight: 0.5 },
        ],
      }),
      me,
    );
    const missRequired = scoreSkills(
      demands({
        skills: [
          { skill: 'React', weight: 1 },
          { skill: 'Kafka', weight: 1 },
        ],
      }),
      me,
    );
    expect(missPreferred.dimension.score).toBeGreaterThan(missRequired.dimension.score);
  });

  it('does not discount anything when the resume had no dated experience', () => {
    const undated = candidate({ recentSkills: [] });
    const out = scoreSkills(demands({ skills: ask('MongoDB', 'Redis') }), undated);
    expect(out.dimension.score).toBe(1);
  });

  it('stays neutral when the posting names no technology at all', () => {
    const out = scoreSkills(demands({ skills: [] }), candidate());
    expect(out.dimension.score).toBe(0.5);
    expect(out.dimension.reason).toMatch(/no technologies/i);
  });
});

describe('scoreTitle', () => {
  it('rewards an exact target', () => {
    expect(scoreTitle('Full Stack Software Engineer', candidate()).score).toBe(1);
  });

  it('sees past a ladder rung', () => {
    expect(scoreTitle('Senior Full Stack Engineer', candidate()).score).toBeGreaterThan(0.7);
  });

  it('recognises a role family across different words', () => {
    // No shared tokens with "Full Stack Software Engineer", same job.
    expect(scoreTitle('SDE II', candidate()).score).toBeGreaterThanOrEqual(0.6);
  });

  it('marks a different craft down', () => {
    expect(scoreTitle('Data Scientist', candidate()).score).toBeLessThan(0.35);
    expect(scoreTitle('Technical Recruiter', candidate()).score).toBeLessThan(0.35);
  });

  it('stays neutral when no target roles are set', () => {
    expect(scoreTitle('Anything At All', candidate({ titles: [] })).score).toBe(0.5);
  });
});

describe('scoreSeniority', () => {
  it('gives full marks for the same rung', () => {
    const me = candidate({ titles: ['Senior Engineer'], yearsOfExperience: 6 });
    expect(scoreSeniority('Senior Software Engineer', demands(), me).score).toBe(1);
  });

  it('caps a two-rung gap at a half', () => {
    // A mid candidate against a principal role is not a near miss.
    const out = scoreSeniority('Principal Engineer', demands(), candidate());
    expect(out.score).toBeLessThanOrEqual(0.5);
  });

  it('falls back to the level read from the description', () => {
    const out = scoreSeniority('Software Engineer', demands({ seniority: 'intern' }), candidate());
    expect(out.score).toBeLessThanOrEqual(0.5);
  });

  it('stays generous when the posting states no level', () => {
    expect(scoreSeniority('Software Engineer', demands(), candidate()).score).toBe(0.7);
  });
});

describe('scoreExperience', () => {
  it('gives full marks inside the band', () => {
    expect(scoreExperience(demands({ minYears: 3, maxYears: 6 }), candidate()).score).toBe(1);
  });

  it('penalises being short more than being long', () => {
    const short = scoreExperience(demands({ minYears: 6, maxYears: 9 }), candidate()).score;
    const long = scoreExperience(demands({ minYears: 1, maxYears: 2 }), candidate()).score;
    expect(short).toBeLessThan(long);
  });

  it('never drops a seasoned candidate below a half for being over the ceiling', () => {
    const veteran = candidate({ yearsOfExperience: 25 });
    expect(
      scoreExperience(demands({ minYears: 1, maxYears: 3 }), veteran).score,
    ).toBeGreaterThanOrEqual(0.5);
  });

  it('handles an open-ended minimum', () => {
    expect(scoreExperience(demands({ minYears: 2 }), candidate()).score).toBe(1);
    expect(scoreExperience(demands({ minYears: 8 }), candidate()).score).toBe(0);
  });

  it('stays neutral when the posting is silent', () => {
    expect(scoreExperience(demands(), candidate()).score).toBe(0.7);
  });
});

describe('scoreLocation', () => {
  it('gives full marks to a remote role regardless of preference', () => {
    expect(scoreLocation(job({ isRemote: true, location: 'Anywhere' }), candidate()).score).toBe(1);
  });

  it('gives full marks to a listed city', () => {
    expect(scoreLocation(job({ location: 'Hyderabad, India' }), candidate()).score).toBe(1);
  });

  it('gives near-full marks inside the same metro', () => {
    expect(scoreLocation(job({ location: 'Gachibowli' }), candidate()).score).toBe(0.85);
  });

  it('gives partial credit when the candidate can relocate', () => {
    expect(scoreLocation(job({ location: 'Pune, India' }), candidate()).score).toBe(0.6);
  });

  it('marks an unwanted city down hard when relocation is off the table', () => {
    const rooted = candidate({ willingToRelocate: false });
    expect(scoreLocation(job({ location: 'Pune, India' }), rooted).score).toBe(0.2);
  });

  it('zeroes a non-remote role for a remote-only candidate', () => {
    const remoteOnly = candidate({ remoteOnly: true });
    expect(scoreLocation(job({ location: 'Hyderabad, India' }), remoteOnly).score).toBe(0);
  });
});

describe('scoreCompensation', () => {
  const salary = (annualMin: number, annualMax: number) => ({
    raw: null,
    min: annualMin,
    max: annualMax,
    currency: 'INR',
    period: 'year' as const,
    annualMin,
    annualMax,
  });

  it('gives full marks when the whole range clears the expectation', () => {
    const out = scoreCompensation(job({ salary: salary(2_200_000, 2_800_000) }), candidate());
    expect(out.score).toBe(1);
  });

  it('gives near-full marks when only the top of the range clears it', () => {
    const out = scoreCompensation(job({ salary: salary(1_800_000, 2_400_000) }), candidate());
    expect(out.score).toBe(0.85);
  });

  it('tapers below the expectation and bottoms out well under it', () => {
    const close = scoreCompensation(job({ salary: salary(1_700_000, 1_800_000) }), candidate());
    const far = scoreCompensation(job({ salary: salary(900_000, 1_000_000) }), candidate());
    expect(close.score).toBeGreaterThan(far.score);
    expect(far.score).toBe(0);
  });

  it('stays neutral rather than zero when the salary is undisclosed', () => {
    // Most Indian postings hide the range; zeroing them would sink good matches
    // for a reason that says nothing about fit.
    const out = scoreCompensation(job(), candidate());
    expect(out.score).toBe(0.6);
    expect(out.reason).toMatch(/not disclosed/i);
  });

  it('stays neutral when the candidate set no expectation', () => {
    const noTarget = candidate({ expectedSalary: null, minSalary: null });
    expect(scoreCompensation(job({ salary: salary(500_000, 600_000) }), noTarget).score).toBe(0.7);
  });
});

describe('scoreRecency', () => {
  const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

  it('gives full marks inside the first week', () => {
    expect(scoreRecency(job({ postedAt: daysAgo(0) }), 30, NOW).score).toBe(1);
    expect(scoreRecency(job({ postedAt: daysAgo(6) }), 30, NOW).score).toBe(1);
  });

  it('decays across the search window', () => {
    const fresh = scoreRecency(job({ postedAt: daysAgo(10) }), 30, NOW).score;
    const stale = scoreRecency(job({ postedAt: daysAgo(28) }), 30, NOW).score;
    expect(fresh).toBeGreaterThan(stale);
    expect(stale).toBeGreaterThanOrEqual(0.3);
  });

  it('stays neutral when the date is unknown', () => {
    expect(scoreRecency(job({ postedAt: null }), 30, NOW).score).toBe(0.6);
    expect(scoreRecency(job({ postedAt: 'not a date' }), 30, NOW).score).toBe(0.6);
  });
});
