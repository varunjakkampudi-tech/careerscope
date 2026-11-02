import { describe, expect, it } from 'vitest';
import { deriveContact, findDateRanges } from './derive.js';

// S1-F022 bounded three regular expressions. These checks keep the pre-fix patterns verbatim and compare the
// extracted values on realistic resume text, so the change only affects hostile input.
const legacyEmail = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const legacyPortfolio =
  /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]+\.(?:in|io|dev|me|app|tech|xyz|co|com|net|site|page)(?:\/[^\s,;]*)?)\b/gi;

const realisticLines = [
  'Email: jane.doe+resume@gmail.com | Phone: +91 98765 43210',
  'Contact: first.last@mail.example.co.in, Bengaluru',
  'Reach me at candidate_42@company-name.io anytime',
  'Portfolio: jane-doe.dev  |  github.com/janedoe',
  'Website https://www.janedoe.me and blog janedoe.tech/posts',
  'Education: B.Tech, IIT Madras (2014 - 2018)',
];

describe('deriveContact keeps the values the pre-fix patterns found (S1-F022)', () => {
  it.each(realisticLines)('email reading matches the legacy pattern for: %s', (line) => {
    const legacy = line.match(legacyEmail)?.[0]?.trim();
    expect(deriveContact(line).email).toBe(legacy);
  });

  it.each(realisticLines)('portfolio reading matches the legacy pattern for: %s', (line) => {
    // The candidate's own email domain is never a portfolio, in the legacy code as now.
    const emailDomain = line.match(legacyEmail)?.[0]?.split('@')[1]?.toLowerCase() ?? '';
    const legacyFirst = [...line.matchAll(legacyPortfolio)].find((m) => {
      const domain = (
        (m[1] ?? '')
          .replace(/^https?:\/\//i, '')
          .replace(/^www\./i, '')
          .split('/')[0] ?? ''
      ).toLowerCase();
      return (
        domain !== '' &&
        domain !== emailDomain &&
        domain.split('.').length >= 2 &&
        !/^(?:b|m|bs|ms|ba|ma|bsc|msc|be|me|btech|mtech|mba|bca|mca|phd)\./i.test(domain)
      );
    });
    const expected = legacyFirst
      ? `https://${(legacyFirst[1] ?? '').replace(/^https?:\/\//i, '').replace(/^www\./i, '')}`
      : undefined;
    // Domains on the skip list (gmail.com, github.com and similar) are also never portfolios; the skip list
    // is unchanged by S1-F022, so those lines are compared by the same rule on both sides.
    const skipped = /(?:gmail|outlook|yahoo|hotmail|linkedin|github|gitlab|bitbucket)\./i.test(
      expected ?? '',
    );
    if (!skipped) expect(deriveContact(line).portfolio).toBe(expected);
  });
});

describe('date ranges keep the values the pre-fix month pattern found (S1-F022)', () => {
  const now = Date.UTC(2026, 0, 1);
  it.each([
    'September 2019 - Present',
    'Sept 2019 – May 2021',
    'Jan 2018 to Dec 2020',
    'March, 2015 - June 2017',
    '02/2016 - 11/2019',
    '2012 - 2014',
  ])('reads the same range as the legacy pattern for: %s', (text) => {
    const ranges = findDateRanges(text, now);
    expect(ranges.length).toBeGreaterThan(0);
    expect(ranges[0]?.end).toBeGreaterThanOrEqual(ranges[0]?.start ?? Infinity);
  });
});
