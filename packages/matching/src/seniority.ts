import { SENIORITY_LEVELS, type SeniorityLabel } from '@job-radar/shared';

/**
 * Reading a level out of a job title, and comparing two levels.
 *
 * Order matters in the patterns below: "senior staff engineer" must read as
 * staff, not senior, so the higher rungs are tested first.
 */

const PATTERNS: { label: SeniorityLabel; re: RegExp }[] = [
  {
    label: 'principal',
    re: /\b(principal|distinguished|fellow|architect|head of|director|vp|chief)\b/i,
  },
  { label: 'staff', re: /\b(staff|lead|leader|manager|sde\s*(?:iii|3)|l[56]|tech lead)\b/i },
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
 * to people with six years — so experience acts as a floor, never a ceiling.
 */
export function candidateSeniority(titles: string[], years: number): SeniorityLabel {
  let best = -1;
  for (const title of titles) {
    const label = seniorityOf(title);
    if (label && SENIORITY_LEVELS[label] > best) best = SENIORITY_LEVELS[label];
  }

  const byYears = yearsToLevel(years);
  const level = Math.max(best, SENIORITY_LEVELS[byYears]);
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

export function levelToLabel(level: number): SeniorityLabel {
  const entries = Object.entries(SENIORITY_LEVELS) as [SeniorityLabel, number][];
  const clamped = Math.max(0, Math.min(entries.length - 1, Math.round(level)));
  return entries.find(([, value]) => value === clamped)?.[0] ?? 'mid';
}

export function levelOf(label: SeniorityLabel): number {
  return SENIORITY_LEVELS[label];
}
