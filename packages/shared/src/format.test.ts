import { describe, expect, it } from 'vitest';
import {
  daysSince,
  formatAnnual,
  formatRelativeDate,
  formatSalary,
  parseCompensation,
} from './format.js';

describe('parseCompensation', () => {
  it('reads Indian lakh notation as an annual figure', () => {
    expect(parseCompensation('14 LPA')).toMatchObject({
      currency: 'INR',
      period: 'year',
      annualMin: 1_400_000,
      annualMax: 1_400_000,
    });
    expect(parseCompensation('7.1 LPA').annualMin).toBe(710_000);
  });

  it('applies a trailing unit to both ends of a bare range', () => {
    // "12-18 LPA" leaves the 12 without a unit — it must still become 12 lakh,
    // not 12 rupees. Getting this wrong understates a salary 100,000x.
    expect(parseCompensation('12-18 LPA')).toMatchObject({
      annualMin: 1_200_000,
      annualMax: 1_800_000,
    });
    expect(parseCompensation('6-9 Lacs P.A.')).toMatchObject({
      annualMin: 600_000,
      annualMax: 900_000,
    });
  });

  it('handles crore', () => {
    expect(parseCompensation('1.2 Cr')).toMatchObject({
      currency: 'INR',
      annualMin: 12_000_000,
    });
  });

  it('annualises non-yearly periods', () => {
    expect(parseCompensation('₹80,000/month').annualMin).toBe(960_000);
    expect(parseCompensation('$50 per hour').annualMin).toBe(104_000);
  });

  it('reads western formats', () => {
    expect(parseCompensation('$120k - $150k')).toMatchObject({
      currency: 'USD',
      annualMin: 120_000,
      annualMax: 150_000,
    });
    expect(parseCompensation('$95,000 - $120,000 a year')).toMatchObject({
      currency: 'USD',
      period: 'year',
      annualMin: 95_000,
      annualMax: 120_000,
    });
  });

  it('returns nulls for undisclosed pay rather than zero', () => {
    for (const text of ['', null, undefined, 'Not disclosed', 'Competitive', 'Negotiable']) {
      expect(parseCompensation(text).annualMin).toBeNull();
    }
  });
});

describe('formatSalary', () => {
  it('renders a range', () => {
    const parsed = parseCompensation('12-18 LPA');
    expect(formatSalary({ raw: '12-18 LPA', ...parsed })).toBe('₹12.0 LPA – ₹18.0 LPA');
  });

  it('falls back to the board wording when nothing parsed', () => {
    expect(
      formatSalary({
        raw: 'Depends on experience',
        min: null,
        max: null,
        currency: null,
        period: null,
        annualMin: null,
        annualMax: null,
      }),
    ).toBe('Depends on experience');
  });

  it('says "Not disclosed" when there is nothing at all', () => {
    expect(
      formatSalary({
        raw: null,
        min: null,
        max: null,
        currency: null,
        period: null,
        annualMin: null,
        annualMax: null,
      }),
    ).toBe('Not disclosed');
  });
});

describe('formatAnnual', () => {
  it('uses LPA and Cr for INR', () => {
    expect(formatAnnual(1_400_000, 'INR')).toBe('₹14.0 LPA');
    expect(formatAnnual(15_000_000, 'INR')).toBe('₹1.50 Cr');
  });

  it('uses k and M elsewhere', () => {
    expect(formatAnnual(150_000, 'USD')).toBe('$150k');
    expect(formatAnnual(1_200_000, 'USD')).toBe('$1.2M');
  });
});

describe('relative dates', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');

  it('describes recency in the coarsest sensible unit', () => {
    expect(formatRelativeDate('2026-09-05T11:59:30Z', now)).toBe('Just now');
    expect(formatRelativeDate('2026-09-05T09:00:00Z', now)).toBe('3h ago');
    expect(formatRelativeDate('2026-09-01T12:00:00Z', now)).toBe('4d ago');
    expect(formatRelativeDate('2026-06-05T12:00:00Z', now)).toBe('3mo ago');
  });

  it('is empty for unknown dates', () => {
    expect(formatRelativeDate(null, now)).toBe('');
    expect(formatRelativeDate('not a date', now)).toBe('');
  });

  it('counts whole days', () => {
    expect(daysSince('2026-08-29T12:00:00Z', now)).toBe(7);
    expect(daysSince(null, now)).toBeNull();
  });
});
