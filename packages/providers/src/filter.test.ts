import { describe, expect, it } from 'vitest';
import type { ProviderQuery, RawJob } from '@job-radar/shared';
import {
  employmentTypeAllowed,
  hasExcludedKeyword,
  locationAllowed,
  locationTokens,
  matchesQuery,
  titleAllowed,
  titleRelevance,
  titleTokens,
  withinWindow,
} from './filter.js';

const NOW = Date.parse('2026-09-05T00:00:00Z');
const DAY = 86_400_000;

function query(overrides: Partial<ProviderQuery> = {}): ProviderQuery {
  return {
    titles: [],
    locations: [],
    excludeKeywords: [],
    remoteOnly: false,
    employmentTypes: [],
    postedWithinDays: 30,
    maxResults: 100,
    ...overrides,
  };
}

function job(overrides: Partial<RawJob> = {}): RawJob {
  return {
    source: 'greenhouse',
    sourceJobId: '1',
    title: 'Senior Backend Engineer',
    companyName: 'Acme',
    hasFullDescription: true,
    sourceUrl: 'https://example.com/1',
    ...overrides,
  };
}

describe('titleTokens', () => {
  it('drops seniority and filler, which say nothing about the role itself', () => {
    expect([...titleTokens('Senior Software Engineer II')].sort()).toEqual(
      ['software', 'engineer'].sort(),
    );
  });

  it('folds the abbreviations Indian boards actually use', () => {
    expect(titleTokens('SDE III')).toEqual(new Set(['engineer']));
    expect(titleTokens('Backend Developer')).toEqual(new Set(['back-end', 'engineer']));
  });

  it('keeps the punctuation that is part of a technology name', () => {
    expect(titleTokens('C++ / C# Engineer')).toEqual(new Set(['c++', 'c#', 'engineer']));
  });
});

describe('titleRelevance', () => {
  it('measures against the target, so a decorated job title still scores 1', () => {
    const score = titleRelevance('Senior Backend Engineer, Payments Platform — Bangalore', [
      'Backend Engineer',
    ]);
    expect(score).toBe(1);
  });

  it('scores partial overlap proportionally', () => {
    // One shared token ("engineer") out of the target's three.
    expect(titleRelevance('Data Engineer', ['Machine Learning Engineer'])).toBeCloseTo(1 / 3, 5);
  });

  it('takes the best of several targets', () => {
    expect(titleRelevance('Product Designer', ['Backend Engineer', 'Product Designer'])).toBe(1);
  });

  it('is 0 for an unrelated title', () => {
    expect(titleRelevance('Warehouse Associate', ['Backend Engineer'])).toBe(0);
  });

  it('is 0 rather than NaN when the title is all stopwords', () => {
    expect(titleRelevance('Senior', ['Backend Engineer'])).toBe(0);
  });
});

describe('titleAllowed', () => {
  it('passes everything when the user has stated no preference', () => {
    expect(titleAllowed('Warehouse Associate', [])).toBe(true);
  });

  it('keeps a half-overlap, because scoring decides what it is worth', () => {
    expect(titleAllowed('Software Engineer', ['Backend Software Engineer'])).toBe(true);
  });

  it('rejects a title with nothing in common', () => {
    expect(titleAllowed('Regional Sales Manager', ['Backend Engineer'])).toBe(false);
  });

  it('matches a synonym family: SDE is an engineer', () => {
    expect(titleAllowed('SDE 2', ['Software Engineer'])).toBe(true);
  });
});

describe('locationTokens / locationAllowed', () => {
  it('treats Bengaluru and Bangalore as one city', () => {
    expect(locationTokens('Bengaluru, KA')).toContain('bangalore');
    expect(locationAllowed({ location: 'Bengaluru, Karnataka' }, ['Bangalore'])).toBe(true);
  });

  it('ignores administrative filler so Milan matches its metropolitan city', () => {
    expect(locationAllowed({ location: 'Metropolitan City of Milan' }, ['Milan'])).toBe(true);
  });

  it('does not match two unrelated cities on a shared filler word', () => {
    expect(locationAllowed({ location: 'Greater Boston Area' }, ['Greater Noida Area'])).toBe(
      false,
    );
  });

  it('passes a posting whose location could not be read — absence is not evidence', () => {
    expect(locationAllowed({ location: undefined }, ['Bangalore'])).toBe(true);
    expect(locationAllowed({ location: '—' }, ['Bangalore'])).toBe(true);
  });

  it('always passes a remote role', () => {
    expect(locationAllowed({ location: 'Berlin', isRemote: true }, ['Bangalore'])).toBe(true);
    expect(locationAllowed({ location: 'Remote (India)' }, ['Bangalore'])).toBe(true);
  });

  it('rejects a definite elsewhere', () => {
    expect(locationAllowed({ location: 'Berlin, Germany' }, ['Bangalore', 'Hyderabad'])).toBe(
      false,
    );
  });
});

describe('withinWindow', () => {
  it('keeps a posting inside the window', () => {
    expect(withinWindow(new Date(NOW - 5 * DAY).toISOString(), 30, NOW)).toBe(true);
  });

  it('drops one past it', () => {
    expect(withinWindow(new Date(NOW - 40 * DAY).toISOString(), 30, NOW)).toBe(false);
  });

  it('keeps a posting with no date — many boards only list current openings', () => {
    expect(withinWindow(undefined, 30, NOW)).toBe(true);
  });

  it('keeps a posting with an unparseable date rather than guessing', () => {
    expect(withinWindow('last Tuesday', 30, NOW)).toBe(true);
  });

  it("keeps a future date: that is a board's timezone bug, not a stale posting", () => {
    expect(withinWindow(new Date(NOW + 2 * DAY).toISOString(), 30, NOW)).toBe(true);
  });
});

describe('employmentTypeAllowed', () => {
  it('passes an unstated type', () => {
    expect(employmentTypeAllowed(null, ['fulltime'])).toBe(true);
  });

  it('passes anything when the user has no preference', () => {
    expect(employmentTypeAllowed('internship', [])).toBe(true);
  });

  it('rejects a stated mismatch', () => {
    expect(employmentTypeAllowed('internship', ['fulltime'])).toBe(false);
  });
});

describe('hasExcludedKeyword', () => {
  it('matches on the title', () => {
    expect(hasExcludedKeyword({ title: 'Sales Engineer', companyName: 'Acme' }, ['sales'])).toBe(
      true,
    );
  });

  it('matches on the company', () => {
    expect(hasExcludedKeyword({ title: 'Engineer', companyName: 'Infosys' }, ['infosys'])).toBe(
      true,
    );
  });

  it('ignores an empty or whitespace keyword rather than excluding everything', () => {
    expect(hasExcludedKeyword({ title: 'Engineer', companyName: 'Acme' }, ['', '   '])).toBe(false);
  });
});

describe('matchesQuery', () => {
  it('keeps a plainly relevant posting', () => {
    const q = query({ titles: ['Backend Engineer'], locations: ['Bangalore'] });
    expect(matchesQuery(job({ location: 'Bengaluru, India' }), q, { now: NOW })).toBe(true);
  });

  it('enforces remote-only as a hard gate', () => {
    const q = query({ remoteOnly: true });
    expect(matchesQuery(job({ location: 'Bangalore' }), q, { now: NOW })).toBe(false);
    expect(matchesQuery(job({ isRemote: true }), q, { now: NOW })).toBe(true);
  });

  it('reads remote out of the text when the board has no flag for it', () => {
    const q = query({ remoteOnly: true });
    expect(matchesQuery(job({ location: 'Remote - India' }), q, { now: NOW })).toBe(true);
    expect(matchesQuery(job({ title: 'Backend Engineer (Work From Home)' }), q, { now: NOW })).toBe(
      true,
    );
  });

  it('applies the exclude list to the title, not the description', () => {
    const q = query({ excludeKeywords: ['sales'] });
    expect(matchesQuery(job({ title: 'Sales Engineer' }), q, { now: NOW })).toBe(false);
    expect(
      matchesQuery(job({ description: 'You will partner with sales.' }), q, { now: NOW }),
    ).toBe(true);
  });

  it('passes everything when the query states no preferences at all', () => {
    expect(matchesQuery(job({ title: 'Warehouse Associate' }), query(), { now: NOW })).toBe(true);
  });
});
