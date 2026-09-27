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
 * the resume said.
 *
 * They are not treated the same way. Years of experience is a real conflict -
 * a typed non-zero value always wins over the resume's guess (see
 * resolveYears), because the user edited the form after seeing the parse.
 * Skills and titles are not a conflict to resolve: the resume's contribution
 * is unioned into the typed list, additive and permanent for as long as the
 * resume is on file. There is no per-skill exclusion - the only way to remove
 * a resume-derived skill or title from every future match is to delete the
 * resume itself (see resumeSkills/resumeConsidered on CandidateContext, which
 * exist specifically so this always-on contribution is visible in match
 * evidence, not silently folded into "skills" as if the user had typed it).
 */
export function buildCandidateContext(
  profile: MatchableProfile,
  resumeText = '',
): CandidateContext {
  const { candidate, preferences, application, derived } = profile;
  const resumeSkills = normalizeSkillList(derived?.techStack ?? []);

  return {
    skills: normalizeSkillList([...preferences.techStack, ...resumeSkills]),
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
    resumeConsidered: derived != null,
    resumeSkills,
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
