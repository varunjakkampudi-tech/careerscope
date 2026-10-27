/**
 * Seniority detection from titles and years of experience. Used by `demands.ts` and
 * `dimensions.ts`; the level scale itself lives in `@careerscope/shared`.
 */

import { SENIORITY_LEVELS, type SeniorityLabel } from '@careerscope/shared';

/**
 * Title patterns, highest rung first: "senior staff engineer" must read as staff, not senior, so
 * the first match wins.
 */
const PATTERNS: { label: SeniorityLabel; re: RegExp }[] = [
  {
    label: 'principal',
    // "fellow" is a level only as a title word ("Fellow", "Distinguished Fellow",
    // "Engineering Fellow"), never inside a sentence-like title or "Fellowship".
    re: /\b(?:principal|distinguished|architect|head of|director|vp|chief)\b|^\s*fellow\b|\bfellow\s*$|\b(?:technical|engineering|research|senior)\s+fellow\b/i,
  },
  {
    label: 'staff',
    // "lead" and "manager" are staff only where they name an engineering leadership
    // role. "Lead Generation Executive" and "Account Manager" say nothing about level.
    re: /\b(?:staff|sde\s*(?:iii|3)|l[56]|tech(?:nical)?\s+lead|(?:team|engineering|development|dev|squad)\s+lead(?:er)?|engineering\s+manager)\b|^\s*lead\s+(?:[\w+#.]+[\s/-]+){0,2}?(?:engineer|developer|architect|programmer|scientist|designer|analyst|sre|devops)\b|[,(–-]\s*lead\s*\)?\s*$/i,
  },
  { label: 'senior', re: /\b(senior|sr\.?|snr|sde\s*(?:ii|2)|l4|iii|iv)\b/i },
  {
    label: 'junior',
    re: /\b(junior|jr\.?|entry[- ]level|graduate|associate engineer|sde\s*(?:i|1)\b|l[123])\b/i,
  },
  { label: 'intern', re: /\b(intern|internship|trainee|apprentice|fresher)\b/i },
];

/** The level a title advertises, or null when it doesn't say. */
export function seniorityOf(title: string): SeniorityLabel | null {
  for (const { label, re } of PATTERNS) {
    if (re.test(title)) return label;
  }
  return null;
}

/**
 * The candidate's level, inferred from their titles and then floored by years of
 * experience. Titles alone are unreliable — consultancies hand out "Associate"
 * to people with six years — so known experience acts as a floor, never a
 * ceiling. Missing experience does not imply an intern-level candidate.
 */
export function candidateSeniority(titles: string[], years: number | null): SeniorityLabel | null {
  let best = -1;
  for (const title of titles) {
    const label = seniorityOf(title);
    if (label && SENIORITY_LEVELS[label] > best) best = SENIORITY_LEVELS[label];
  }

  const byYears = years === null ? -1 : SENIORITY_LEVELS[yearsToLevel(years)];
  const level = Math.max(best, byYears);
  if (level < 0) return null;
  return levelToLabel(level);
}

/** Conventional Indian/US software ladder mapped onto years served. */
export function yearsToLevel(years: number): SeniorityLabel {
  if (years < 1) return 'intern';
  if (years < 2.5) return 'junior';
  if (years < 5) return 'mid';
  if (years < 9) return 'senior';
  if (years < 13) return 'staff';
  return 'principal';
}

/** Inverse of `levelOf`, clamped to the ladder and rounded to the nearest rung. */
export function levelToLabel(level: number): SeniorityLabel {
  const entries = Object.entries(SENIORITY_LEVELS) as [SeniorityLabel, number][];
  const clamped = Math.max(0, Math.min(entries.length - 1, Math.round(level)));
  return entries.find(([, value]) => value === clamped)?.[0] ?? 'mid';
}

/** Numeric rung for a seniority label, for comparisons. */
export function levelOf(label: SeniorityLabel): number {
  return SENIORITY_LEVELS[label];
}
