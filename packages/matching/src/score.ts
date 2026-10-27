/**
 * Turning seven dimension scores into one number, with the gates and clamps that
 * make that number mean something. Uses `demands.ts` and `dimensions.ts`.
 *
 * Three rules keep the headline honest:
 *   1. Hard eligibility gives a listing zero and says why, rather than letting
 *      a disqualifying detail get averaged away by six good dimensions. The
 *      listing remains visible; eligibility is advice, not a discovery filter.
 *   2. A listing whose description was never fetched is capped, so crossing the
 *      user's threshold always implies the JD was actually read.
 *   3. The full breakdown ships with every lead, so any score can be audited.
 */

import {
  LOW_CONFIDENCE_SCORE_CEILING,
  MATCH_WEIGHTS,
  type CandidateContext,
  type Job,
  type JobDemands,
  type MatchBreakdown,
  type MatchDimension,
  type MatchDimensions,
  type MatchDimensionScore,
  matchesExcludedKeyword,
} from '@careerscope/shared';
import { extractDemands } from './demands.js';
import {
  clamp01,
  scoreCompensation,
  scoreExperience,
  scoreLocation,
  scoreRecency,
  scoreSeniority,
  scoreSkills,
  scoreTitle,
} from './dimensions.js';

/** Increment when the deterministic scoring rules or weights materially change. */
export const MATCH_SCORING_VERSION = 'deterministic-v2';

/**
 * Below this many characters a "description" is a teaser — a search-results
 * snippet, or a title echoed back at us — and any skill coverage read from it is
 * an accident of what happened to fit in the excerpt.
 */
export const MIN_FULL_DESCRIPTION_CHARS = 400;

/** Optional inputs to `scoreJob`; `now` and `demands` exist so callers and tests stay deterministic. */
export interface ScoreOptions {
  /** Search window in days; recency decays across it. Defaults to 30. */
  windowDays?: number;
  now?: number;
  /** Demands, when the caller has already extracted them for this job. */
  demands?: JobDemands;
}

/** Score one job against one candidate. Pure — no I/O, no clock beyond `now`. */
export function scoreJob(
  job: Job,
  candidate: CandidateContext,
  options: ScoreOptions = {},
): MatchBreakdown {
  const { windowDays = 30, now = Date.now() } = options;

  const flaggedCompany = isFlaggedCompany(job, candidate);
  const gate = hardGate(job, candidate);
  if (gate) return excludedBreakdown(gate, flaggedCompany, candidate.resumeConsidered);

  // Recomputed rather than read off `job.techStack`, because scoring needs the
  // required/preferred weighting that the stored list has already flattened away.
  const demands = options.demands ?? extractDemands(job);

  const skills = scoreSkills(demands, candidate);
  const dimensions: MatchDimensions = {
    skills: skills.dimension,
    title: scoreTitle(job.title, candidate),
    seniority: scoreSeniority(job.title, demands, candidate),
    experience: scoreExperience(demands, candidate),
    location: scoreLocation(job, candidate),
    compensation: scoreCompensation(job, candidate),
    recency: scoreRecency(job, windowDays, now),
  };

  const heuristicScore = combine(dimensions);
  const confidence = hasReadableDescription(job) ? 'high' : 'low';
  const score = applyConfidenceCeiling(heuristicScore, confidence);
  const resumeSkillSet = new Set(candidate.resumeSkills.map((skill) => skill.toLowerCase()));

  return {
    scoringVersion: MATCH_SCORING_VERSION,
    score,
    heuristicScore,
    dimensions,
    matchedSkills: skills.matched,
    missingSkills: skills.missing,
    confidence,
    excludedReason: null,
    flaggedCompany,
    llmScore: null,
    llmRationale: null,
    resumeConsidered: candidate.resumeConsidered,
    // Only the matched skills that actually came from the resume - not every
    // resume skill regardless of whether this job needed it - so the evidence
    // reads as "the resume moved this score", not "here is the whole resume".
    resumeSkills: skills.matched.filter((skill) => resumeSkillSet.has(skill.toLowerCase())),
  };
}

/** Weighted mean of the dimensions, rounded to kill float noise in stored JSON. */
export function combine(dimensions: MatchDimensions): number {
  let total = 0;
  let weight = 0;
  for (const key of Object.keys(MATCH_WEIGHTS) as MatchDimension[]) {
    const d = dimensions[key];
    total += d.score * d.weight;
    weight += d.weight;
  }
  return weight === 0 ? 0 : round4(total / weight);
}

/** Caps a low-confidence score at `LOW_CONFIDENCE_SCORE_CEILING`; high-confidence scores pass through. */
export function applyConfidenceCeiling(score: number, confidence: 'high' | 'low'): number {
  return confidence === 'low' ? Math.min(score, LOW_CONFIDENCE_SCORE_CEILING) : score;
}

/**
 * Whether there is enough description to have scored against. The stored flag is
 * authoritative when a provider set it; the length check catches providers that
 * claim a full description and return two sentences.
 */
export function hasReadableDescription(job: Job): boolean {
  return job.hasFullDescription && job.descriptionText.trim().length >= MIN_FULL_DESCRIPTION_CHARS;
}

/* -------------------------------------------------------------------------- */
/* Gates and flags                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Reasons a listing receives no match score, or null when no hard constraint
 * applies. This does not remove listings from discovery. Kept ahead of scoring
 * so an ineligible job never pays for skill extraction over a full JD.
 */
export function hardGate(job: Job, candidate: CandidateContext): string | null {
  const haystack = `${job.title}\n${job.company.name}\n${job.descriptionText}`.toLowerCase();

  for (const keyword of candidate.excludeKeywords) {
    if (matchesExcludedKeyword(haystack, keyword)) {
      return `Mentions an excluded keyword: "${keyword}"`;
    }
  }

  if (candidate.remoteOnly && !job.isRemote) {
    return 'You asked for remote roles only';
  }

  // A null employment type means the posting never said, which is not a mismatch.
  if (
    job.employmentType !== null &&
    candidate.employmentTypes.length > 0 &&
    !candidate.employmentTypes.includes(job.employmentType)
  ) {
    return `Employment type "${job.employmentType}" is not one you selected`;
  }

  return null;
}

/**
 * The do-not-apply list is a flag, never a gate. The user still wants to see the
 * role — to know the market, or to reconsider — they just don't want it applied
 * to on their behalf.
 */
export function isFlaggedCompany(job: Job, candidate: CandidateContext): boolean {
  const name = companyTokens(job.company.name);
  if (!name) return false;
  return candidate.excludeCompanies.some((excluded) => {
    const value = companyTokens(excluded);
    // Token-boundary containment either way: "Meta" flags "Meta Platforms"
    // (and the reverse) but never "Metabase".
    return value !== '' && (name.includes(value) || value.includes(name));
  });
}

/** Lowercased alphanumeric tokens padded with spaces, so substring tests respect word boundaries. */
function companyTokens(value: string): string {
  const tokens = value
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
  return tokens.length === 0 ? '' : ` ${tokens.join(' ')} `;
}

/* -------------------------------------------------------------------------- */

/** Zero-score result for a gated listing, carrying the reason so the UI can explain it. */
function excludedBreakdown(
  reason: string,
  flaggedCompany: boolean,
  resumeConsidered: boolean,
): MatchBreakdown {
  return {
    scoringVersion: MATCH_SCORING_VERSION,
    score: 0,
    heuristicScore: 0,
    dimensions: notScoredDimensions(),
    matchedSkills: [],
    missingSkills: [],
    confidence: 'high',
    excludedReason: reason,
    flaggedCompany,
    llmScore: null,
    llmRationale: null,
    resumeConsidered,
    resumeSkills: [],
  };
}

/** Placeholder dimensions for an excluded lead, so the drawer renders sensibly. */
function notScoredDimensions(): MatchDimensions {
  const blank: MatchDimensionScore = { score: 0, weight: 0, reason: 'Not scored — excluded' };
  return Object.fromEntries(
    (Object.keys(MATCH_WEIGHTS) as MatchDimension[]).map((key) => [
      key,
      { ...blank, weight: MATCH_WEIGHTS[key] },
    ]),
  ) as MatchDimensions;
}

/** Clamp to 0..1 and round to four decimals, which keeps stored JSON stable. */
function round4(value: number): number {
  return Math.round(clamp01(value) * 10_000) / 10_000;
}
