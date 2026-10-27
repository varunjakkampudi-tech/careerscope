import { describe, expect, it } from 'vitest';
import { matchesExcludedKeyword } from './keywords.js';

describe('matchesExcludedKeyword', () => {
  it('matches whole words and phrases case-insensitively', () => {
    expect(matchesExcludedKeyword('Backend Intern', 'intern')).toBe(true);
    expect(matchesExcludedKeyword('Sales Engineering Lead', 'Sales Engineering')).toBe(true);
    expect(matchesExcludedKeyword('C++ Developer', 'c++')).toBe(true);
  });

  it('does not match inside a longer word', () => {
    expect(matchesExcludedKeyword('Internal Tools Engineer', 'intern')).toBe(false);
    expect(matchesExcludedKeyword('International Payments Engineer', 'intern')).toBe(false);
  });

  it('ignores blank keywords', () => {
    expect(matchesExcludedKeyword('Anything', '   ')).toBe(false);
  });
});
