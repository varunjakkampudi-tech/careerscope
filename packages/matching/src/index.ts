/**
 * Public entry point of `@careerscope/matching`, the matching engine. Collaborators:
 * `@careerscope/shared` for types and weights, and the search worker for scoring.
 *
 * Deterministic, pure, and unit-tested: given the same job and the same
 * candidate it returns the same score, and the `MatchBreakdown` it returns
 * explains that score dimension by dimension. */

export {
  extractDemands,
  extractDemandedSkills,
  extractYears,
  detectRemote,
  detectEmploymentType,
} from './demands.js';
export type { DemandSource } from './demands.js';

export {
  clamp01,
  scoreCompensation,
  scoreExperience,
  scoreLocation,
  scoreRecency,
  scoreSeniority,
  scoreSkills,
  scoreTitle,
} from './dimensions.js';
export type { SkillOutcome } from './dimensions.js';

export {
  candidateSeniority,
  levelOf,
  levelToLabel,
  seniorityOf,
  yearsToLevel,
} from './seniority.js';

export {
  applyConfidenceCeiling,
  combine,
  hardGate,
  hasReadableDescription,
  isFlaggedCompany,
  scoreJob,
  MATCH_SCORING_VERSION,
  MIN_FULL_DESCRIPTION_CHARS,
} from './score.js';
export type { ScoreOptions } from './score.js';

export { buildCandidateContext } from './context.js';
