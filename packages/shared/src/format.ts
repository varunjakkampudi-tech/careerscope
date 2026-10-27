/**
 * Parsing and display helpers shared by the API (exporter, matching engine) and
 * the web client. Keeping them here guarantees a salary rendered in the table
 * and the same salary written to the spreadsheet agree.
 */

import type { Salary } from './schemas.js';

/* -------------------------------------------------------------------------- */
/* Compensation                                                               */
/* -------------------------------------------------------------------------- */

/** Periods per year used to annualise a quoted salary (260 working days, 2080 working hours). */
const PERIOD_MULTIPLIER: Record<NonNullable<Salary['period']>, number> = {
  year: 1,
  month: 12,
  week: 52,
  day: 260,
  hour: 2080,
};

/** Annualise a figure quoted over some other period. */
export function toAnnual(amount: number, period: Salary['period']): number {
  return Math.round(amount * PERIOD_MULTIPLIER[period ?? 'year']);
}

/**
 * Parse a free-text compensation string into an annual amount.
 *
 * Handles the formats these boards actually emit, including the Indian units
 * that plain number parsing gets wrong by two orders of magnitude:
 *   "14 LPA" · "7.1 lakh" · "₹12,00,000" · "12-18 LPA" · "$120k - $150k"
 *   "1.2 Cr" · "₹80,000/month" · "50 per hour"
 *
 * Returns null when there is no number at all, so callers can distinguish
 * "undisclosed" from "zero".
 */
export function parseCompensation(input: string | null | undefined): {
  min: number | null;
  max: number | null;
  currency: string | null;
  period: Salary['period'];
  annualMin: number | null;
  annualMax: number | null;
} {
  const empty = {
    min: null,
    max: null,
    currency: null,
    period: null,
    annualMin: null,
    annualMax: null,
  } as const;
  if (!input) return { ...empty };

  const text = input.toLowerCase().replace(/,/g, '').trim();
  if (!text || /not disclosed|not specified|competitive|negotiable|unpaid/.test(text)) {
    return { ...empty };
  }

  const currency = detectCurrency(text);
  const period = detectPeriod(text);

  // Grab every number together with the unit suffix immediately following it,
  // so "12-18 LPA" applies the lakh multiplier to both ends of the range. A unit
  // must end at a letter boundary and `m` is only a standalone "m" or "million",
  // so "6 months" and "2 years" never read as 6,000,000 or 2 lakh.
  const parsed: { raw: number; unit: string | undefined }[] = [];
  for (const m of text.matchAll(
    /(\d+(?:\.\d+)?)(?:\s*(cr(?:ore)?|lpa|lakhs?|lacs?|l|k|m(?:illion)?)(?![a-z]))?/g,
  )) {
    const raw = Number.parseFloat(m[1] ?? '');
    if (!Number.isFinite(raw)) continue;
    const unit = m[2];
    // "40 hours/week" and "2 years" are durations, not pay.
    if (!unit && DURATION_AFTER.test(text.slice((m.index ?? 0) + m[0].length))) continue;
    parsed.push({ raw, unit });
  }
  const trailingUnit = [...parsed].reverse().find((entry) => entry.unit)?.unit;
  const values: number[] = parsed.map((entry) => applyUnit(entry.raw, entry.unit));
  if (values.length === 0) return { ...empty };

  // "12-18 LPA" leaves the first number bare; the unit at the end governs both.
  if (trailingUnit && values.length > 1) {
    for (let i = 0; i < values.length; i += 1) {
      const entry = parsed[i];
      if (entry && !entry.unit) values[i] = applyUnit(entry.raw, trailingUnit);
    }
  }

  const sorted = values.filter((v) => v > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return { ...empty };

  const min = sorted[0] ?? null;
  const max = sorted.length > 1 ? (sorted[sorted.length - 1] ?? null) : min;

  return {
    min,
    max,
    currency,
    period,
    annualMin: min === null ? null : toAnnual(min, period),
    annualMax: max === null ? null : toAnnual(max, period),
  };
}

/** A duration word straight after a bare number: that number is a length of time, not an amount. */
const DURATION_AFTER = /^\s*(?:hours?|hrs?|years?|yrs?|months?|mos?|weeks?|wks?|days?)(?![a-z])/;

function applyUnit(value: number, unit: string | undefined): number {
  switch (unit) {
    case 'cr':
    case 'crore':
      return value * 10_000_000;
    case 'lpa':
    case 'lakh':
    case 'lakhs':
    case 'lac':
    case 'lacs':
    case 'l':
      return value * 100_000;
    case 'k':
      return value * 1_000;
    case 'm':
    case 'million':
      return value * 1_000_000;
    default:
      return value;
  }
}

function detectCurrency(text: string): string | null {
  // Explicit symbols first: they are unambiguous, whereas the code and unit
  // words below can only be trusted as whole words ("hours" is not "rs").
  if (text.includes('₹')) return 'INR';
  if (text.includes('$')) return 'USD';
  if (text.includes('€')) return 'EUR';
  if (text.includes('£')) return 'GBP';
  if (/(?<![a-z])(?:inr|rs|rupees?)(?![a-z])/.test(text)) return 'INR';
  if (/(?<![a-z])usd(?![a-z])/.test(text)) return 'USD';
  if (/(?<![a-z])eur(?:os?)?(?![a-z])/.test(text)) return 'EUR';
  if (/(?<![a-z])gbp(?![a-z])/.test(text)) return 'GBP';
  if (/(?<![a-z])(?:lpa|lakhs?|lacs?|crores?|cr)(?![a-z])/.test(text)) return 'INR';
  return null;
}

function detectPeriod(text: string): Salary['period'] {
  if (/per hour|\/\s*hr|hourly|\/hour|an hour/.test(text)) return 'hour';
  if (/per day|\/\s*day|daily|a day/.test(text)) return 'day';
  if (/per week|\/\s*wk|weekly|\/week|a week/.test(text)) return 'week';
  if (/per month|\/\s*mo\b|monthly|\/month|a month/.test(text)) return 'month';
  if (/per year|\/\s*yr|annual|yearly|\/year|a year|lpa|p\.?\s?a\.?\b/.test(text)) return 'year';
  return null;
}

/** Format an annual amount compactly: ₹14.0 LPA, $150k, €90k. */
export function formatAnnual(amount: number | null, currency: string | null): string {
  if (amount === null || !Number.isFinite(amount)) return '';
  if (currency === 'INR') {
    if (amount >= 10_000_000) return `₹${(amount / 10_000_000).toFixed(2)} Cr`;
    return `₹${(amount / 100_000).toFixed(1)} LPA`;
  }
  const symbol =
    currency === 'USD' ? '$' : currency === 'EUR' ? '€' : currency === 'GBP' ? '£' : '';
  if (amount >= 1_000_000) return `${symbol}${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${symbol}${Math.round(amount / 1_000)}k`;
  return `${symbol}${Math.round(amount)}`;
}

/**
 * The single string shown in the Package column. Falls back to the board's own
 * wording before giving up, so we never blank out a salary we were told.
 */
export function formatSalary(salary: Salary): string {
  const { annualMin, annualMax, currency, raw } = salary;
  if (annualMin === null && annualMax === null) return raw?.trim() || 'Not disclosed';
  if (annualMin !== null && annualMax !== null && annualMin !== annualMax) {
    return `${formatAnnual(annualMin, currency)} – ${formatAnnual(annualMax, currency)}`;
  }
  return formatAnnual(annualMax ?? annualMin, currency) || raw?.trim() || 'Not disclosed';
}

/* -------------------------------------------------------------------------- */
/* Display                                                                    */
/* -------------------------------------------------------------------------- */

/** Render a 0..1 score as a whole-number percentage. */
export function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}

/** "3d ago" / "2h ago" / "Just now". Empty string when the date is unknown. */
export function formatRelativeDate(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const diffMs = now - ts;
  if (diffMs < 0) return 'Just now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

/** Whole days since `iso`, or null when unparseable. */
export function daysSince(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return Math.max(0, Math.floor((now - ts) / 86_400_000));
}
