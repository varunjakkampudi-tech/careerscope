import { describe, expect, it } from 'vitest';
import { constrainEvidenceText, isRefusedCodePointAt } from './evidence-text.js';

// S1-F025: a run of zero-width joiners copied the whole text for every joiner, which took about a minute for
// 60,000 joiners. These checks prove the joiner rule is unchanged and the cost is linear.
describe('constrainEvidenceText joiner handling (S1-F025)', () => {
  it('finishes in bounded time on a long run of zero-width joiners', () => {
    const started = performance.now();
    constrainEvidenceText('‍'.repeat(60_000));
    constrainEvidenceText('😀‍'.repeat(20_000));
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('keeps a joiner between letters of one Indic script and refuses it elsewhere', () => {
    expect(constrainEvidenceText('ब‍क')).toBe('ब‍क');
    expect(constrainEvidenceText('Senior‍ Engineer')).toBe('Senior Engineer');
    expect(constrainEvidenceText('a‍b')).toBe('ab');
  });

  it('reads the code point before a joiner after a surrogate pair', () => {
    const emoji = '😀';
    expect(isRefusedCodePointAt(`${emoji}‍`, 2)).toBe(true);
  });
});
