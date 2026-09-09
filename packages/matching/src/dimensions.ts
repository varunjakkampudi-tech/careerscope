import {
  FAMILY_CREDIT,
  MATCH_WEIGHTS,
  daysSince,
  skillFamily,
  skillRarity,
  type CandidateContext,
  type Job,
  type JobDemands,
  type MatchDimensionScore,
} from '@job-radar/shared';
import { candidateSeniority, levelOf, seniorityOf } from './seniority.js';

/**
 * The seven dimension scorers. Each returns 0..1 plus a one-line reason, which
 * the UI shows on hover — an "87%" nobody can audit is worth very little.
 */

const dim = (
  key: keyof typeof MATCH_WEIGHTS,
  score: number,
  reason: string,
): MatchDimensionScore => ({
  score: clamp01(score),
  weight: MATCH_WEIGHTS[key],
  reason,
});

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/* -------------------------------------------------------------------------- */
/* Skills                                                                     */
/* -------------------------------------------------------------------------- */

export interface SkillOutcome {
  dimension: MatchDimensionScore;
  matched: string[];
  missing: string[];
}

/** Full credit for a skill used in the latest role, near-full for an older one. */
const RECENT_CREDIT = 1;
const HELD_CREDIT = 0.9;
const RELATED_RECENT_CREDIT = 0.5;

/**
 * Coverage of the skills the *job* demands — not of the candidate's whole stack.
 *
 * Each demanded skill contributes `askWeight × rarity`, so a FastAPI requirement
 * moves the needle more than a JavaScript one: everyone lists JavaScript, which
 * makes it weak evidence either way. Credit is graded rather than binary, since
 * Vue experience is real evidence for a React role even though it isn't React.
 */
export function scoreSkills(demands: JobDemands, candidate: CandidateContext): SkillOutcome {
  const held = new Set(candidate.skills.map(lower));
  const recent = new Set(candidate.recentSkills.map(lower));
  // With no dated experience there is no "recent" to speak of, and discounting
  // every skill uniformly would just depress the whole run.
  const recencyKnown = recent.size > 0;

  const heldFamilies = new Map<string, string>();
  for (const skill of candidate.skills) {
    const family = skillFamily(skill);
    if (family && !heldFamilies.has(family)) heldFamilies.set(family, skill);
  }

  const matched: string[] = [];
  const missing: string[] = [];
  let earned = 0;
  let possible = 0;

  for (const { skill, weight } of demands.skills) {
    const ask = weight * skillRarity(skill);
    possible += ask;

    if (held.has(lower(skill))) {
      const credit = !recencyKnown || recent.has(lower(skill)) ? RECENT_CREDIT : HELD_CREDIT;
      earned += ask * credit;
      matched.push(skill);
      continue;
    }

    const family = skillFamily(skill);
    const relative = family ? heldFamilies.get(family) : undefined;
    if (relative) {
      const credit = recent.has(lower(relative)) ? RELATED_RECENT_CREDIT : FAMILY_CREDIT;
      earned += ask * credit;
      // Adjacent, not equivalent — the UI still shows this as a gap to close.
      missing.push(skill);
      continue;
    }

    missing.push(skill);
  }

  if (possible === 0) {
    // A posting with no detectable technology — a recruiter teaser, usually.
    // Neutral rather than zero, and the confidence clamp handles the rest.
    return {
      dimension: dim('skills', 0.5, 'No technologies named in the posting'),
      matched: [],
      missing: [],
    };
  }

  const score = earned / possible;
  return {
    dimension: dim(
      'skills',
      score,
      `${matched.length} of ${demands.skills.length} requested skills, weighted by how rare and how firmly asked`,
    ),
    matched,
    missing,
  };
}

/* -------------------------------------------------------------------------- */
/* Title                                                                      */
/* -------------------------------------------------------------------------- */

/** Words that appear in nearly every title and so carry no signal. */
const TITLE_STOPWORDS = new Set([
  'senior',
  'sr',
  'junior',
  'jr',
  'lead',
  'staff',
  'principal',
  'associate',
  'i',
  'ii',
  'iii',
  'iv',
  'the',
  'a',
  'an',
  'of',
  'and',
  'for',
  'to',
  'in',
  'at',
  'with',
  'remote',
  'hybrid',
  'onsite',
  'contract',
  'fulltime',
  'permanent',
  'urgent',
  'hiring',
  'immediate',
  'joiner',
  'joiners',
]);

/** Role families, so "SDE" and "Software Engineer" aren't strangers. */
const ROLE_FAMILIES: { family: string; re: RegExp }[] = [
  {
    family: 'frontend',
    re: /\b(front[- ]?end|ui|web)\s*(?:engineer|developer|dev)\b|\bfrontend\b/i,
  },
  {
    family: 'backend',
    re: /\b(back[- ]?end|server[- ]side)\s*(?:engineer|developer|dev)\b|\bbackend\b/i,
  },
  { family: 'fullstack', re: /\bfull[- ]?stack\b/i },
  {
    family: 'mobile',
    re: /\b(android|ios|mobile|react native|flutter)\s*(?:engineer|developer|dev)?\b/i,
  },
  {
    family: 'data',
    re: /\b(data\s*(?:engineer|scientist|analyst)|analytics|machine learning|ml|ai)\b/i,
  },
  {
    family: 'devops',
    re: /\b(devops|sre|site reliability|platform|infrastructure|cloud)\s*(?:engineer)?\b/i,
  },
  { family: 'qa', re: /\b(qa|quality|test|sdet|automation)\s*(?:engineer|analyst)?\b/i },
  { family: 'generic', re: /\b(software|application|sde|swe)\s*(?:engineer|developer|dev)?\b/i },
];

function roleFamilies(title: string): Set<string> {
  const out = new Set<string>();
  for (const { family, re } of ROLE_FAMILIES) {
    if (re.test(title)) out.add(family);
  }
  return out;
}

/**
 * How close the posting's title is to the roles the candidate targets. Scored as
 * the best match across their titles, because a candidate is not penalised for
 * also being open to something else.
 */
export function scoreTitle(jobTitle: string, candidate: CandidateContext): MatchDimensionScore {
  if (candidate.titles.length === 0) {
    return dim('title', 0.5, 'No target roles set');
  }

  const jobTokens = tokenizeTitle(jobTitle);
  const jobFamilies = roleFamilies(jobTitle);

  let best = 0;
  let bestTitle = candidate.titles[0] ?? '';
  for (const target of candidate.titles) {
    const targetTokens = tokenizeTitle(target);
    const overlap = jaccard(jobTokens, targetTokens);
    const familyOverlap = intersects(jobFamilies, roleFamilies(target));
    // Family agreement carries most of the weight: "SDE II" and "Software
    // Engineer" share no tokens at all but are the same job.
    const score = familyOverlap ? 0.6 + 0.4 * overlap : overlap;
    if (score > best) {
      best = score;
      bestTitle = target;
    }
  }

  const reason =
    best >= 0.6
      ? `Close to your target "${bestTitle}"`
      : best > 0.25
        ? `Partly overlaps "${bestTitle}"`
        : `Different role family to "${bestTitle}"`;
  return dim('title', best, reason);
}

function tokenizeTitle(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9+#. ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1 && !TITLE_STOPWORDS.has(t)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / (a.size + b.size - shared);
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const value of a) if (b.has(value)) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Seniority                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Distance on the seniority ladder. A gap of two rungs or more caps the
 * dimension at 0.5 — a principal role and a junior candidate is not a near miss
 * however well the skills line up.
 */
export function scoreSeniority(
  jobTitle: string,
  demands: JobDemands,
  candidate: CandidateContext,
): MatchDimensionScore {
  const jobLabel = seniorityOf(jobTitle) ?? demands.seniority;
  if (!jobLabel) {
    return dim('seniority', 0.7, 'Posting does not state a level');
  }

  const mine = candidateSeniority(candidate.titles, candidate.yearsOfExperience);
  const gap = Math.abs(levelOf(jobLabel) - levelOf(mine));
  const raw = 1 - Math.min(1, gap / 3);
  const score = gap >= 2 ? Math.min(0.5, raw) : raw;

  const reason =
    gap === 0
      ? `Both ${jobLabel} level`
      : `${jobLabel} role, you read as ${mine} (${gap} rung${gap === 1 ? '' : 's'} apart)`;
  return dim('seniority', score, reason);
}

/* -------------------------------------------------------------------------- */
/* Experience                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Years asked for versus years held. Being over the band costs less than being
 * under it — an extra two years is rarely disqualifying, two years short often
 * is — and a posting that says nothing is neutral, not a miss.
 */
export function scoreExperience(
  demands: JobDemands,
  candidate: CandidateContext,
): MatchDimensionScore {
  const { minYears, maxYears } = demands;
  if (minYears === null && maxYears === null) {
    return dim('experience', 0.7, 'Posting does not state an experience range');
  }

  const years = candidate.yearsOfExperience;
  const low = minYears ?? 0;
  const high = maxYears ?? Infinity;

  if (years >= low && years <= high) {
    return dim(
      'experience',
      1,
      `Your ${round(years)} years sit inside the ${describeBand(demands)} ask`,
    );
  }

  if (years < low) {
    const short = low - years;
    return dim(
      'experience',
      1 - Math.min(1, short / 4),
      `${round(short)} year${short === 1 ? '' : 's'} short of the ${low}-year minimum`,
    );
  }

  const over = years - high;
  return dim(
    'experience',
    1 - Math.min(0.5, over / 8),
    `${round(over)} year${over === 1 ? '' : 's'} above the ${high}-year ceiling`,
  );
}

function describeBand(demands: JobDemands): string {
  if (demands.minYears !== null && demands.maxYears !== null) {
    return `${demands.minYears}–${demands.maxYears} year`;
  }
  if (demands.minYears !== null) return `${demands.minYears}+ year`;
  return `up to ${demands.maxYears} year`;
}

/* -------------------------------------------------------------------------- */
/* Location                                                                   */
/* -------------------------------------------------------------------------- */

/** Cities that share a job market, so a Gurgaon role suits a Delhi candidate. */
const METROS: string[][] = [
  ['delhi', 'new delhi', 'gurgaon', 'gurugram', 'noida', 'ghaziabad', 'faridabad', 'ncr'],
  ['bangalore', 'bengaluru', 'whitefield', 'electronic city'],
  ['mumbai', 'navi mumbai', 'thane', 'pune'],
  ['hyderabad', 'secunderabad', 'gachibowli', 'hitec city', 'telangana'],
  ['chennai', 'madras'],
  ['kochi', 'cochin', 'ernakulam', 'trivandrum', 'thiruvananthapuram'],
  ['san francisco', 'bay area', 'palo alto', 'mountain view', 'san jose', 'sunnyvale'],
  ['new york', 'nyc', 'brooklyn', 'jersey city'],
];

function metroOf(place: string): string[] | null {
  const value = lower(place);
  return METROS.find((metro) => metro.some((city) => value.includes(city))) ?? null;
}

/**
 * Where the job is against where the candidate can work. Remote satisfies
 * everyone; a willingness to relocate earns partial credit rather than full,
 * because relocating is a real cost even when someone is open to it.
 */
export function scoreLocation(job: Job, candidate: CandidateContext): MatchDimensionScore {
  if (job.isRemote) {
    return dim('location', 1, 'Remote role');
  }
  if (candidate.remoteOnly) {
    return dim('location', 0, 'You asked for remote only and this role is not remote');
  }

  const wanted = [candidate.homeLocation, ...candidate.locations].filter(Boolean);
  if (wanted.length === 0) {
    return dim('location', 0.6, 'No preferred locations set');
  }

  const jobPlace = lower(job.location);
  if (!jobPlace) {
    return dim('location', 0.5, 'Posting does not state a location');
  }

  for (const place of wanted) {
    if (jobPlace.includes(lower(place)) || lower(place).includes(jobPlace)) {
      return dim('location', 1, `In ${job.location}`);
    }
  }

  const jobMetro = metroOf(job.location);
  if (jobMetro && wanted.some((place) => metroOf(place) === jobMetro)) {
    return dim('location', 0.85, `${job.location} is in a metro you selected`);
  }

  if (candidate.willingToRelocate) {
    return dim('location', 0.6, `${job.location} — outside your list, but you can relocate`);
  }
  return dim('location', 0.2, `${job.location} is outside your preferred locations`);
}

/* -------------------------------------------------------------------------- */
/* Compensation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Pay against expectation.
 *
 * Undisclosed salary scores a neutral 0.6 rather than 0. Most Indian postings
 * hide the range, and zeroing 8% of the total for every one of them would push
 * otherwise-excellent matches under the threshold for a reason that says nothing
 * about fit.
 */
export function scoreCompensation(job: Job, candidate: CandidateContext): MatchDimensionScore {
  const target = candidate.expectedSalary ?? candidate.minSalary;
  const { annualMin, annualMax } = job.salary;

  if (annualMin === null && annualMax === null) {
    return dim('compensation', 0.6, 'Salary not disclosed');
  }
  if (target === null) {
    return dim('compensation', 0.7, 'No expected package set');
  }

  const top = annualMax ?? annualMin ?? 0;
  const bottom = annualMin ?? annualMax ?? 0;

  if (top >= target) {
    const comfortable = bottom >= target;
    return dim(
      'compensation',
      comfortable ? 1 : 0.85,
      comfortable
        ? 'Whole range meets your expectation'
        : 'Top of the range meets your expectation',
    );
  }

  const ratio = top / target;
  return dim(
    'compensation',
    Math.max(0, (ratio - 0.6) / 0.4),
    `Tops out around ${Math.round(ratio * 100)}% of your expectation`,
  );
}

/* -------------------------------------------------------------------------- */
/* Recency                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How fresh the posting is. Old listings are often filled but never taken down,
 * so freshness is a weak positive signal — hence the smallest weight of the
 * seven.
 */
export function scoreRecency(job: Job, windowDays: number, now = Date.now()): MatchDimensionScore {
  if (!job.postedAt) {
    return dim('recency', 0.6, 'Posting date unknown');
  }
  const days = daysSince(job.postedAt, now);
  if (days === null) {
    return dim('recency', 0.6, 'Posting date unreadable');
  }
  if (days <= 7) {
    return dim('recency', 1, days <= 1 ? 'Posted today' : `Posted ${Math.round(days)} days ago`);
  }
  const span = Math.max(1, windowDays - 7);
  const decayed = 1 - 0.7 * Math.min(1, (days - 7) / span);
  return dim('recency', decayed, `Posted ${Math.round(days)} days ago`);
}

/* -------------------------------------------------------------------------- */

function lower(value: string): string {
  return value.trim().toLowerCase();
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
