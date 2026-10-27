/**
 * Builds the candidate side of a match from a stored profile and its parsed resume. Called by the
 * search worker once per run; consumes types from `@careerscope/shared`.
 */

import {
  normalizeSkillList,
  parseCompensation,
  type CandidateContext,
  type MatchableProfile,
} from '@careerscope/shared';

/**
 * Assembling the candidate side of a comparison.
 *
 * Built once per run and reused for every job, so the engine never reaches for
 * the database mid-scoring. Two sources feed it — what the user typed and what
 * the resume said.
 *
 * They are not treated the same way. An explicitly typed experience value,
 * including zero, wins over the resume's estimate. Only unknown experience may
 * be filled from resume evidence (see resolveYears).
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
    expectedCurrency: parseCompensation(application.expectedCtc).currency,
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

/** An explicit candidate value (including zero) wins; the resume fills unknowns. */
function resolveYears(entered: number | null, derived: number | null | undefined): number | null {
  if (entered !== null) return entered;
  return derived ?? null;
}

/** Trim and case-insensitively dedupe, keeping the first spelling seen and dropping blanks. */
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
