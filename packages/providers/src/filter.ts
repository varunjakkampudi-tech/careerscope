/**
 * The provider-side pre-filter.
 *
 * ATS boards are company-scoped, not query-scoped: there is no way to ask
 * Greenhouse for "senior backend roles". You fetch Databricks' 869 postings and
 * decide locally. So every board provider pulls a whole board and runs it
 * through here.
 *
 * This is deliberately **generous**, and it is not the matching engine. Its only
 * job is to stop tens of thousands of obviously-unrelated postings from being
 * fetched in detail and scored — an accountant role does not need a 4 KB
 * description download to be rejected. Everything that survives is scored
 * properly in `@careerscope/matching`, which is the authority on whether a job is
 * an 85% match.
 *
 * The asymmetry matters: a false positive here costs one detail request. A
 * false negative is a job the user never learns exists. So when in doubt, keep
 * it — an unparseable location passes, a missing date passes, and a job with no
 * target titles configured passes.
 */

import {
  METROS,
  matchesExcludedKeyword,
  type EmploymentType,
  type ProviderQuery,
  type RawJob,
} from '@careerscope/shared';

/**
 * How much of a target title must appear in the job title. One word out of two
 * ("engineer" from "backend engineer") is enough to survive to scoring; the
 * engine then decides what that overlap is actually worth.
 */
const TITLE_OVERLAP_THRESHOLD = 0.5;

/** Words that carry no signal about what the role is. */
const TITLE_STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'the',
  'of',
  'for',
  'to',
  'in',
  'at',
  'with',
  'i',
  'ii',
  'iii',
  'iv',
  'senior',
  'sr',
  'junior',
  'jr',
  'lead',
  'staff',
  'principal',
  'associate',
  'entry',
  'level',
  'mid',
  'remote',
  'hybrid',
  'onsite',
  'contract',
  'intern',
  'internship',
  'full',
  'part',
  'time',
  'fulltime',
  'parttime',
]);

/**
 * Titles that mean the same job. Without this, a user targeting "Software
 * Engineer" never sees a "Software Development Engineer" or an "SDE II" — which
 * on Indian boards is most of the market.
 */
const TITLE_SYNONYMS: Record<string, string> = {
  sde: 'engineer',
  swe: 'engineer',
  sdet: 'engineer',
  dev: 'developer',
  developer: 'engineer',
  engineering: 'engineer',
  programmer: 'engineer',
  architect: 'engineer',
  fullstack: 'full-stack',
  frontend: 'front-end',
  backend: 'back-end',
  devops: 'sre',
  reliability: 'sre',
  ml: 'machine-learning',
  ai: 'machine-learning',
  analytics: 'data',
  scientist: 'data',
  qa: 'quality',
  sdi: 'engineer',
};

/* -------------------------------------------------------------------------- */
/* The filter                                                                 */
/* -------------------------------------------------------------------------- */

/** Optional inputs to the filter functions. */
export interface FilterOptions {
  /** Injected so recency tests do not depend on the wall clock. */
  now?: number;
}

/**
 * Should this posting be carried forward to detail fetching and scoring?
 *
 * Only the checks that mirror a **hard gate** in the matching engine are applied
 * strictly (remote-only, employment type, the search window). Title and location
 * are graded dimensions in the engine, so here they are used loosely — enough to
 * discard the clearly-unrelated, never enough to pre-empt a score.
 */
export function matchesQuery(
  job: RawJob,
  query: ProviderQuery,
  options: FilterOptions = {},
): boolean {
  if (query.remoteOnly && job.isRemote !== true && !looksRemote(job)) return false;
  if (!withinWindow(job.postedAt, query.postedWithinDays, options.now)) return false;
  if (!employmentTypeAllowed(job.employmentType, query.employmentTypes)) return false;
  if (hasExcludedKeyword(job, query.excludeKeywords)) return false;
  if (!titleAllowed(job.title, query.titles)) return false;
  return locationAllowed(job, query.locations);
}

/**
 * True when the title plausibly relates to anything the user is looking for.
 *
 * With no target titles configured, everything passes — an empty preference
 * means "no opinion", not "nothing".
 */
export function titleAllowed(title: string, targets: readonly string[]): boolean {
  if (targets.length === 0) return true;
  return titleRelevance(title, targets) >= TITLE_OVERLAP_THRESHOLD;
}

/**
 * The best overlap between a job title and any target title, 0..1.
 *
 * Measured against the *target's* tokens rather than the job's, so a long,
 * decorated job title ("Senior Backend Engineer, Payments Platform — Bangalore")
 * still scores 1.0 for the target "Backend Engineer". Scoring the other way
 * round would penalise exactly the listings that describe themselves best.
 */
export function titleRelevance(title: string, targets: readonly string[]): number {
  const jobTokens = titleTokens(title);
  if (jobTokens.size === 0) return 0;

  let best = 0;
  for (const target of targets) {
    const wanted = titleTokens(target);
    if (wanted.size === 0) continue;
    let hits = 0;
    for (const token of wanted) if (jobTokens.has(token)) hits += 1;
    best = Math.max(best, hits / wanted.size);
  }
  return best;
}

/** Lowercased, de-punctuated, stopword-stripped, synonym-folded title tokens. */
export function titleTokens(title: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of title.toLowerCase().split(/[^a-z0-9+#]+/)) {
    if (!word || TITLE_STOPWORDS.has(word)) continue;
    tokens.add(TITLE_SYNONYMS[word] ?? word);
  }
  return tokens;
}

/**
 * True when the posting could plausibly be in one of the user's locations.
 *
 * Remote roles always pass. So does a posting whose location we could not read —
 * dropping a job because a board wrote its location oddly would be the filter
 * making a decision it has no evidence for.
 */
export function locationAllowed(
  job: Pick<RawJob, 'location' | 'isRemote'>,
  locations: readonly string[],
): boolean {
  if (locations.length === 0) return true;
  if (job.isRemote === true) return true;

  const tokens = locationTokens(job.location ?? '');
  if (tokens.size === 0) return true;
  if (tokens.has('remote') || tokens.has('anywhere')) return true;

  for (const wanted of locations) {
    for (const token of locationTokens(wanted)) {
      if (tokens.has(token)) return true;
    }
  }
  return false;
}

/**
 * Location words worth comparing. Administrative filler ("area", "district",
 * "metropolitan") is dropped so "Metropolitan City of Milan" and "Milan" match,
 * and so two unrelated cities do not match on the word "area".
 */
export function locationTokens(location: string): Set<string> {
  const tokens = new Set<string>();
  const words = location
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let padded = ` ${words.join(' ')} `;

  // Multi-word names first ("new york", "united states") — once split into
  // words they would be two meaningless tokens.
  for (const [phrase, canonical] of PHRASE_ALIASES) {
    const needle = ` ${phrase} `;
    if (!padded.includes(needle)) continue;
    tokens.add(canonical);
    padded = padded.split(needle).join(' ');
  }

  for (const word of padded.split(' ')) {
    if (!word) continue;
    // Alias before the length check: "uk", "us" and "nyc" are short on purpose.
    const alias = WORD_ALIASES.get(word);
    if (alias) {
      tokens.add(alias);
      continue;
    }
    if (word.length < 3 || LOCATION_STOPWORDS.has(word)) continue;
    tokens.add(word);
  }
  return tokens;
}

/** Filler words dropped before comparing locations. */
const LOCATION_STOPWORDS = new Set([
  'and',
  'the',
  'city',
  'area',
  'region',
  'state',
  'district',
  'metropolitan',
  'greater',
  'province',
  'county',
  'office',
  'based',
  'multiple',
  'locations',
  'location',
  'or',
  'any',
  'all',
  'other',
  'various',
  'hybrid',
  'onsite',
  'flexible',
  'optional',
]);

/**
 * Same place, different name. Cities that share a job market come from the
 * matching engine's METROS table (first entry is canonical), so the pre-filter
 * and the scorer agree; the rest are renamed cities and country names.
 */
const LOCATION_ALIASES: readonly (readonly [string, string])[] = [
  ...METROS.flatMap((metro) => metro.map((name) => [name, metro[0] ?? name] as const)),
  ['bangaluru', 'bangalore'],
  ['calcutta', 'kolkata'],
  ['us', 'us'],
  ['usa', 'us'],
  ['united states', 'us'],
  ['united states of america', 'us'],
  ['uk', 'uk'],
  ['gb', 'uk'],
  ['united kingdom', 'uk'],
  ['great britain', 'uk'],
];

/** Multi-word aliases, longest first so "united states of america" wins over "united states". */
const PHRASE_ALIASES = LOCATION_ALIASES.filter(([name]) => name.includes(' ')).sort(
  (left, right) => right[0].length - left[0].length,
);

/** Single-word aliases. */
const WORD_ALIASES = new Map(LOCATION_ALIASES.filter(([name]) => !name.includes(' ')));

/**
 * Inside the search window? A posting with no date passes: most boards that
 * omit the date are ones which only ever list current openings, and dropping
 * them would silently remove entire sources.
 */
export function withinWindow(
  postedAt: string | undefined,
  days: number,
  now = Date.now(),
): boolean {
  if (!postedAt) return true;
  const at = Date.parse(postedAt);
  if (!Number.isFinite(at)) return true;
  // Tomorrow's date is a board's timezone bug, not a stale posting.
  return at >= now - days * 86_400_000;
}

/** An unstated employment type passes; only a stated mismatch is rejected. */
export function employmentTypeAllowed(
  type: EmploymentType | null | undefined,
  allowed: readonly EmploymentType[],
): boolean {
  if (!type || allowed.length === 0) return true;
  return allowed.includes(type);
}

/**
 * The user's exclude list, applied to the title and company only.
 *
 * Not to the description: a backend role that mentions "sales engineering" once
 * in a paragraph about who you would work with is not a sales job, and matching
 * on the body would throw it away. The matching engine runs the same list
 * against the full text as a hard gate, where the cost of a mistake is a score
 * rather than a silent disappearance.
 */
export function hasExcludedKeyword(
  job: Pick<RawJob, 'title' | 'companyName'>,
  keywords: readonly string[],
): boolean {
  if (keywords.length === 0) return false;
  const haystack = `${job.title} ${job.companyName}`;
  return keywords.some((word) => matchesExcludedKeyword(haystack, word));
}

/** Wording that marks a job as remote when the board sets no remote flag. */
const REMOTE_HINT = /\b(?:remote|work from home|wfh|anywhere|distributed)\b/i;

/** A board that has no remote flag but says so in the location or title. */
function looksRemote(job: Pick<RawJob, 'title' | 'location'>): boolean {
  return REMOTE_HINT.test(`${job.title} ${job.location ?? ''}`);
}
