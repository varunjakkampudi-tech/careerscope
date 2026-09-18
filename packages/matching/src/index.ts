/**
 * The matching engine.
 *
 * Deterministic, pure, and unit-tested: given the same job and the same
 * candidate it returns the same score, and the `MatchBreakdown` it returns
 * explains that score dimension by dimension. The optional Claude pass in
 * `rerank.ts` layers on top and never replaces it.
 */

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
  applyRerank,
  combine,
  hardGate,
  hasReadableDescription,
  isFlaggedCompany,
  scoreJob,
  LLM_BLEND_WEIGHT,
  MIN_FULL_DESCRIPTION_CHARS,
} from './score.js';
export type { ScoreOptions } from './score.js';

export { buildCandidateContext } from './context.js';

export {
  rerankLeads,
  DEFAULT_RERANK_BATCH_SIZE,
  DEFAULT_RERANK_CONCURRENCY,
  DEFAULT_RERANK_MODEL,
  DEFAULT_RERANK_TOP_N,
  MAX_DESCRIPTION_CHARS,
  MAX_RESUME_CHARS,
  RERANK_MAX_TOKENS,
} from './rerank.js';
export type { RerankClient, StructuredRerankClient, RerankInput, RerankOptions } from './rerank.js';
