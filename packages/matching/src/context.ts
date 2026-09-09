import {
  normalizeSkillList,
  parseCompensation,
  type CandidateContext,
  type MatchableProfile,
} from '@job-radar/shared';

/**
 * Assembling the candidate side of a comparison.
 *
 * Built once per run and reused for every job, so the engine never reaches for
 * the database mid-scoring. Two sources feed it — what the user typed and what
 * the resume said — and where they disagree the user wins, because they edited
 * the form after seeing the parse.
 */
export function buildCandidateContext(
  profile: MatchableProfile,
  resumeText = '',
): CandidateContext {
  const { candidate, preferences, application, derived } = profile;

  return {
    skills: normalizeSkillList([...preferences.techStack, ...(derived?.techStack ?? [])]),
    recentSkills: normalizeSkillList(derived?.recentSkills ?? []),
    titles: dedupe([...preferences.titles, ...(derived?.titles ?? [])]),
    yearsOfExperience: resolveYears(application.yearsOfExperience, derived?.yearsOfExperience),
    locations: dedupe(preferences.locations),
    homeLocation: candidate.location.trim(),
    remoteOnly: preferences.remoteOnly,
    willingToRelocate: application.willingToRelocate,
    expectedSalary: annualFloor(application.expectedCtc),
    minSalary: preferences.minSalary,
    employmentTypes: preferences.employmentTypes,
    excludeKeywords: preferences.excludeKeywords,
    excludeCompanies: preferences.excludeCompanies,
    resumeText,
  };
}

/**
 * The bottom of an expectation, not the top. Someone who writes "18–22 LPA" is
 * saying 18 is acceptable, and scoring against 22 would mark every offer they'd
 * happily take as a shortfall.
 */
function annualFloor(ctc: string): number | null {
  const parsed = parseCompensation(ctc);
  return parsed.annualMin ?? parsed.annualMax;
}

/** The typed figure wins; the resume only fills a zero the user never touched. */
function resolveYears(entered: number, derived: number | null | undefined): number {
  if (entered > 0) return entered;
  return derived != null && derived > 0 ? derived : 0;
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(trimmed);
  }
  return out;
}
