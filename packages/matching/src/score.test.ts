import { describe, expect, it } from 'vitest';
import { DEFAULT_MATCH_THRESHOLD, LOW_CONFIDENCE_SCORE_CEILING } from '@job-radar/shared';
import {
  applyRerank,
  hardGate,
  hasReadableDescription,
  isFlaggedCompany,
  scoreJob,
} from './score.js';
import {
  JAVA_HEAVY_JD,
  NEAR_EXACT_JD,
  NOW,
  SNIPPET_JD,
  candidate,
  job,
} from './matching.fixtures.js';

const opts = { now: NOW, windowDays: 30 };

/* -------------------------------------------------------------------------- */
/* Score bands — the acceptance test for the whole engine                     */
/* -------------------------------------------------------------------------- */

describe('scoreJob — score bands', () => {
  it('clears the 85% threshold on a JD written for this candidate', () => {
    // The requirement that started the project: a genuinely matching posting has
    // to reach the default threshold. The old engine topped out near 0.59.
    const breakdown = scoreJob(
      job({ title: 'Full Stack Software Engineer', descriptionText: NEAR_EXACT_JD }),
      candidate(),
      opts,
    );

    expect(breakdown.score).toBeGreaterThanOrEqual(DEFAULT_MATCH_THRESHOLD);
    expect(breakdown.confidence).toBe('high');
    expect(breakdown.excludedReason).toBeNull();
    expect(breakdown.matchedSkills).toEqual(
      expect.arrayContaining(['React', 'TypeScript', 'Node.js', 'REST API', 'Storybook']),
    );
  });

  it('keeps a same-level, different-craft JD well under 60%', () => {
    const breakdown = scoreJob(
      job({
        title: 'Senior Backend Engineer',
        descriptionText: JAVA_HEAVY_JD,
        location: 'Chennai, India',
      }),
      candidate(),
      opts,
    );

    expect(breakdown.score).toBeLessThan(0.6);
    expect(breakdown.missingSkills).toEqual(
      expect.arrayContaining(['Java', 'Spring Boot', 'Kafka', 'Oracle DB']),
    );
  });

  it('caps a snippet-only listing below the threshold however well it reads', () => {
    // Every word in this snippet is a skill the candidate has. Without the clamp
    // it would outrank postings whose full JD we actually read.
    const breakdown = scoreJob(
      job({
        title: 'Full Stack Software Engineer',
        descriptionText: SNIPPET_JD,
        hasFullDescription: false,
      }),
      candidate(),
      opts,
    );

    expect(breakdown.confidence).toBe('low');
    expect(breakdown.score).toBeLessThanOrEqual(LOW_CONFIDENCE_SCORE_CEILING);
    expect(breakdown.score).toBeLessThan(DEFAULT_MATCH_THRESHOLD);
    // The clamp hides the heuristic score rather than rewriting it.
    expect(breakdown.heuristicScore).toBeGreaterThan(breakdown.score);
  });

  it('caps a provider that claims a full description and returns two lines', () => {
    const breakdown = scoreJob(
      job({
        title: 'Full Stack Software Engineer',
        descriptionText: SNIPPET_JD,
        hasFullDescription: true,
      }),
      candidate(),
      opts,
    );
    expect(breakdown.confidence).toBe('low');
  });

  it('ranks the matching JD above the mismatched one', () => {
    const good = scoreJob(
      job({ title: 'Full Stack Software Engineer', descriptionText: NEAR_EXACT_JD }),
      candidate(),
      opts,
    ).score;
    const bad = scoreJob(
      job({ title: 'Senior Backend Engineer', descriptionText: JAVA_HEAVY_JD }),
      candidate(),
      opts,
    ).score;
    expect(good - bad).toBeGreaterThan(0.25);
  });
});

/* -------------------------------------------------------------------------- */
/* Breakdown shape                                                            */
/* -------------------------------------------------------------------------- */

describe('scoreJob — breakdown', () => {
  it('returns all seven dimensions with their weights and reasons', () => {
    const breakdown = scoreJob(job({ descriptionText: NEAR_EXACT_JD }), candidate(), opts);
    const keys = Object.keys(breakdown.dimensions).sort();
    expect(keys).toEqual([
      'compensation',
      'experience',
      'location',
      'recency',
      'seniority',
      'skills',
      'title',
    ]);
    for (const dimension of Object.values(breakdown.dimensions)) {
      expect(dimension.score).toBeGreaterThanOrEqual(0);
      expect(dimension.score).toBeLessThanOrEqual(1);
      expect(dimension.reason).not.toBe('');
    }
  });

  it('is the weighted mean of its dimensions', () => {
    const breakdown = scoreJob(job({ descriptionText: NEAR_EXACT_JD }), candidate(), opts);
    const expected = Object.values(breakdown.dimensions).reduce(
      (sum, d) => sum + d.score * d.weight,
      0,
    );
    expect(breakdown.heuristicScore).toBeCloseTo(expected, 3);
  });

  it('is deterministic', () => {
    const args = [job({ descriptionText: NEAR_EXACT_JD }), candidate(), opts] as const;
    expect(scoreJob(...args)).toEqual(scoreJob(...args));
  });
});

/* -------------------------------------------------------------------------- */
/* Gates and flags                                                            */
/* -------------------------------------------------------------------------- */

describe('hardGate', () => {
  it('excludes an unwanted keyword and names it', () => {
    const me = candidate({ excludeKeywords: ['Sales', 'unpaid'] });
    const reason = hardGate(job({ title: 'Sales Engineer' }), me);
    expect(reason).toMatch(/Sales/);
  });

  it('excludes a non-remote role for a remote-only candidate', () => {
    expect(hardGate(job(), candidate({ remoteOnly: true }))).toMatch(/remote/i);
  });

  it('matches excluded terms as whole words, not internal substrings', () => {
    const me = candidate({ excludeKeywords: ['intern', 'internship'] });
    expect(
      hardGate(job({ descriptionText: 'Build internal tools for international teams.' }), me),
    ).toBeNull();
    expect(hardGate(job({ title: 'Frontend Intern (React)' }), me)).toMatch(/intern/);
    expect(hardGate(job({ title: 'Paid internship' }), me)).toMatch(/internship/);
  });

  it('treats punctuation in excluded terms literally', () => {
    const me = candidate({ excludeKeywords: ['C++', 'security clearance'] });
    expect(hardGate(job({ descriptionText: 'C++ experience required' }), me)).toMatch(/C\+\+/);
    expect(hardGate(job({ descriptionText: 'C experience required' }), me)).toBeNull();
    expect(hardGate(job({ descriptionText: 'Requires security clearance.' }), me)).toMatch(
      /security clearance/,
    );
  });

  it('excludes an employment type the candidate did not pick', () => {
    expect(hardGate(job({ employmentType: 'internship' }), candidate())).toMatch(/internship/);
  });

  it('does not exclude a posting that never stated its employment type', () => {
    expect(hardGate(job({ employmentType: null }), candidate())).toBeNull();
  });

  it('passes an ordinary listing', () => {
    expect(hardGate(job(), candidate())).toBeNull();
  });
});

describe('scoreJob — excluded listings', () => {
  it('zeroes the score, keeps the reason and skips scoring', () => {
    const me = candidate({ excludeKeywords: ['Backend'] });
    const breakdown = scoreJob(
      job({ title: 'Backend Engineer', descriptionText: NEAR_EXACT_JD }),
      me,
      opts,
    );

    expect(breakdown.score).toBe(0);
    expect(breakdown.excludedReason).toMatch(/Backend/);
    expect(breakdown.matchedSkills).toEqual([]);
    // The drawer still renders — every dimension is present, just not scored.
    expect(Object.keys(breakdown.dimensions)).toHaveLength(7);
  });
});

describe('isFlaggedCompany', () => {
  it('flags a company on the do-not-apply list without excluding it', () => {
    const me = candidate({ excludeCompanies: ['Acme'] });
    const breakdown = scoreJob(job({ descriptionText: NEAR_EXACT_JD }), me, opts);

    expect(breakdown.flaggedCompany).toBe(true);
    // Still scored and still shown — the user wants to know the role exists.
    expect(breakdown.excludedReason).toBeNull();
    expect(breakdown.score).toBeGreaterThan(0);
  });

  it('matches a shortened company name', () => {
    expect(
      isFlaggedCompany(
        job({ company: { ...job().company, name: 'Acme Corp Pvt Ltd' } }),
        candidate({ excludeCompanies: ['acme corp'] }),
      ),
    ).toBe(true);
  });

  it('does not flag an unrelated company', () => {
    expect(isFlaggedCompany(job(), candidate({ excludeCompanies: ['Globex'] }))).toBe(false);
  });

  it('ignores blank entries rather than flagging everything', () => {
    expect(isFlaggedCompany(job(), candidate({ excludeCompanies: ['  '] }))).toBe(false);
  });
});

describe('hasReadableDescription', () => {
  it('requires both the flag and enough text', () => {
    expect(hasReadableDescription(job({ descriptionText: NEAR_EXACT_JD }))).toBe(true);
    expect(hasReadableDescription(job({ descriptionText: SNIPPET_JD }))).toBe(false);
    expect(
      hasReadableDescription(job({ descriptionText: NEAR_EXACT_JD, hasFullDescription: false })),
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* LLM blend                                                                  */
/* -------------------------------------------------------------------------- */

describe('applyRerank', () => {
  const base = () => scoreJob(job({ descriptionText: NEAR_EXACT_JD }), candidate(), opts);

  it('keeps the deterministic engine in the majority', () => {
    const before = base();
    const after = applyRerank(before, 0, 'Not a fit');
    expect(after.score).toBeCloseTo(0.6 * before.heuristicScore, 4);
    expect(after.heuristicScore).toBe(before.heuristicScore);
  });

  it('records the model score and rationale', () => {
    const after = applyRerank(base(), 0.92, 'Strong overlap on React and design systems.');
    expect(after.llmScore).toBe(0.92);
    expect(after.llmRationale).toMatch(/React/);
  });

  it('clamps a model score outside 0..1', () => {
    expect(applyRerank(base(), 1.7, 'over').llmScore).toBe(1);
    expect(applyRerank(base(), -0.2, 'under').llmScore).toBe(0);
  });

  it('re-applies the confidence ceiling after blending', () => {
    const thin = scoreJob(
      job({ descriptionText: SNIPPET_JD, hasFullDescription: false }),
      candidate(),
      opts,
    );
    const after = applyRerank(thin, 1, 'Model loves it');
    expect(after.score).toBeLessThanOrEqual(LOW_CONFIDENCE_SCORE_CEILING);
  });

  it('leaves an excluded lead alone — a gate is not a matter of opinion', () => {
    const excluded = scoreJob(
      job({ title: 'Sales Engineer' }),
      candidate({ excludeKeywords: ['Sales'] }),
      opts,
    );
    expect(applyRerank(excluded, 0.99, 'Model disagrees')).toEqual(excluded);
  });
});
