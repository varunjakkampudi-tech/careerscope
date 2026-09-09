import { createHash } from 'node:crypto';
import { detectEmploymentType, detectRemote, extractYears } from '@job-radar/matching';
import {
  extractSkills,
  parseCompensation,
  toAnnual,
  type EmploymentType,
  type Job,
  type RawJob,
  type Salary,
} from '@job-radar/shared';
import { descriptionToText, snippet } from './html.js';

/**
 * The boundary between "what a board said" and "what the app knows".
 *
 * Every provider yields `RawJob`, in whatever shape its board happens to use.
 * Everything downstream — scoring, storage, the leads table, the export — reads
 * `Job`. This module is the only place that translation happens, so a field is
 * derived once and identically no matter which of the fourteen sources supplied
 * it.
 *
 * Two rules run through all of it:
 *
 *  - **Never invent.** An absent salary stays null rather than becoming zero; an
 *    unparseable date stays null rather than becoming "now". A null renders as
 *    "Not disclosed", which is true. A fabricated value is a lie the user would
 *    act on.
 *  - **Never inflate confidence.** `hasFullDescription` reflects what was
 *    actually fetched, because the matching engine caps thin listings below the
 *    user's threshold on the strength of it.
 */

export interface NormalizeOptions {
  /** Injected for deterministic tests. */
  now?: number;
}

/** Turn one provider result into the record the rest of the app uses. */
export function normalizeJob(raw: RawJob, options: NormalizeOptions = {}): Job {
  const nowIso = new Date(options.now ?? Date.now()).toISOString();

  const title = collapse(raw.title) || 'Untitled role';
  const companyName = collapse(raw.companyName) || 'Unknown company';
  const descriptionText = descriptionToText(raw.description, raw.descriptionIsHtml);

  // Skills are read from the title too: "Senior React Native Engineer" names a
  // stack that the body of a thin listing may never repeat.
  const techStack = extractSkills(`${title}\n${descriptionText}`);

  const searchable = `${title}\n${descriptionText}`;
  const isRemote = detectRemote(`${searchable}\n${raw.location ?? ''}`, raw.isRemote === true);
  const location = normalizeLocation(raw.location, isRemote);

  const employmentType: EmploymentType | null =
    raw.employmentType ?? detectEmploymentType(searchable);

  const fingerprint = jobFingerprint(title, companyName, location, isRemote);

  return {
    id: fingerprint,
    fingerprint,
    source: raw.source,
    sourceJobId: raw.sourceJobId,
    title,
    company: {
      id: companySlug(companyName),
      name: companyName,
      website: normalizeUrl(raw.companyWebsite),
      careersUrl: normalizeUrl(raw.companyCareersUrl),
      atsPortalUrl: null,
      careersEmail: null,
      emailConfidence: 'unverified',
    },
    location,
    isRemote,
    employmentType,
    salary: normalizeSalary(raw),
    postedAt: normalizeDate(raw.postedAt, options.now),
    descriptionText,
    // A board claiming a full description while sending nothing is claiming
    // wrong; the flag follows the text, not the claim.
    hasFullDescription: raw.hasFullDescription && descriptionText.length > 0,
    techStack,
    requiredYears: descriptionText ? extractYears(descriptionText) : { min: null, max: null },
    applyUrl: normalizeUrl(raw.applyUrl) ?? raw.sourceUrl,
    sourceUrl: raw.sourceUrl,
    sourcePublisher: collapse(raw.sourcePublisher ?? '') || null,
    firstSeenAt: nowIso,
    lastSeenAt: nowIso,
  };
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Stable id for "the same opening", used to collapse the copies that appear
 * when one role is posted to Greenhouse, syndicated to LinkedIn, and scraped
 * from Naukri.
 *
 * Location is part of the key on purpose: "Software Engineer" in Bangalore and
 * the same title in Hyderabad are two jobs a candidate would answer
 * differently, and merging them would hide one of them. Remote roles key on
 * "remote" instead, since the same remote posting is listed under a dozen
 * different office cities.
 */
export function jobFingerprint(
  title: string,
  company: string,
  location: string,
  isRemote = false,
): string {
  const key = [
    canonicalTitle(title),
    canonicalCompany(company),
    isRemote ? 'remote' : canonicalLocation(location),
  ].join('|');
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

/**
 * Strip the decoration boards bolt onto titles — trailing req ids, bracketed
 * locations, "(Remote)", gendered German suffixes — so the same role posted
 * twice produces one key.
 */
export function canonicalTitle(title: string): string {
  return collapse(
    title
      .toLowerCase()
      .replace(/\((?:m\/f\/d|m\/w\/d|f\/m\/x|all genders)\)/g, ' ')
      .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
      .replace(/\b(?:job\s*)?(?:id|req(?:uisition)?|ref)[\s#:-]*[a-z0-9-]{3,}\b/g, ' ')
      // A trailing "- JR-2291" or "- 88213": a code, not part of the role.
      .replace(/[–—-]\s*[a-z]{0,4}[\s#:-]*\d{3,}[a-z0-9-]*\s*$/g, ' ')
      .replace(/[^a-z0-9+#.\s]/g, ' '),
  );
}

/** Drop the legal suffixes that make "Acme" and "Acme Pvt Ltd" look different. */
export function canonicalCompany(company: string): string {
  return collapse(
    company
      .toLowerCase()
      .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
      .replace(
        /\b(?:pvt|private|pte|ltd|limited|llp|llc|inc|incorporated|corp|corporation|co|company|gmbh|plc|technologies|technology|solutions|labs|systems|india)\b\.?/g,
        ' ',
      )
      .replace(/[^a-z0-9+&\s]/g, ' '),
  );
}

/**
 * Reduce a location to its city. Boards write the same place a dozen ways
 * ("Bengaluru, Karnataka, India", "Bangalore, KA", "Bangalore/Hybrid"), and
 * only the leading city token is reliably comparable.
 */
export function canonicalLocation(location: string): string {
  const first = location
    .toLowerCase()
    .split(/[,/|;·]|\s+-\s+/)[0]
    ?.replace(/\b(?:hybrid|on-?site|in-?office|remote|wfh)\b/g, ' ');
  const city = collapse((first ?? '').replace(/[^a-z0-9\s]/g, ' '));
  return CITY_ALIASES[city] ?? city;
}

/** Cities whose two names appear interchangeably in the same market. */
const CITY_ALIASES: Record<string, string> = {
  bengaluru: 'bangalore',
  bangaluru: 'bangalore',
  gurugram: 'gurgaon',
  mumbai: 'mumbai',
  bombay: 'mumbai',
  calcutta: 'kolkata',
  madras: 'chennai',
  trivandrum: 'thiruvananthapuram',
  'new delhi': 'delhi',
  ncr: 'delhi',
  noida: 'noida',
  'san francisco bay area': 'san francisco',
  sf: 'san francisco',
  nyc: 'new york',
  'new york city': 'new york',
};

/** URL-safe, stable company key. Same input, same id, across runs and sources. */
export function companySlug(name: string): string {
  const slug = canonicalCompany(name).replace(/\s+/g, '-');
  // A name made entirely of stripped suffixes ("Pvt Ltd") slugs to nothing;
  // hashing the original keeps the id unique instead of colliding on ''.
  return slug || `c-${createHash('sha1').update(name.toLowerCase()).digest('hex').slice(0, 10)}`;
}

/* -------------------------------------------------------------------------- */
/* Field normalisation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Salary, preferring structured numbers over prose.
 *
 * Boards that send `salaryMin`/`salaryMax` have already done the parsing; text
 * is only parsed when there are no numbers to trust. The original wording is
 * always kept, because "12–18 LPA + ESOPs" tells the user something the two
 * numbers do not.
 */
export function normalizeSalary(raw: RawJob): Salary {
  const rawText = raw.salaryRaw?.trim() || null;
  const hasNumbers = isFiniteNumber(raw.salaryMin) || isFiniteNumber(raw.salaryMax);

  if (hasNumbers) {
    const min = isFiniteNumber(raw.salaryMin) ? raw.salaryMin : null;
    const max = isFiniteNumber(raw.salaryMax) ? raw.salaryMax : null;
    const period = raw.salaryPeriod ?? 'year';
    // Some boards send min and max the wrong way round.
    const lo = min !== null && max !== null ? Math.min(min, max) : min;
    const hi = min !== null && max !== null ? Math.max(min, max) : max;
    return {
      raw: rawText,
      min: lo,
      max: hi,
      currency: raw.salaryCurrency ?? null,
      period,
      annualMin: lo === null ? null : toAnnual(lo, period),
      annualMax: hi === null ? null : toAnnual(hi, period),
    };
  }

  const parsed = parseCompensation(rawText);
  return {
    raw: rawText,
    min: parsed.min,
    max: parsed.max,
    currency: raw.salaryCurrency ?? parsed.currency,
    period: parsed.period,
    annualMin: parsed.annualMin,
    annualMax: parsed.annualMax,
  };
}

/** Tidy a location string, or say "Remote" when that is all we know. */
export function normalizeLocation(location: string | undefined, isRemote: boolean): string {
  const cleaned = collapse((location ?? '').replace(/\s*[,|/]\s*/g, ', ')).replace(
    /^,\s*|,\s*$/g,
    '',
  );
  if (cleaned) return titleCaseLocation(cleaned);
  return isRemote ? 'Remote' : 'Location not stated';
}

function titleCaseLocation(value: string): string {
  // Only fix strings that are shouting or whispering; "Bengaluru, KA" is
  // already correct and re-casing it would turn "KA" into "Ka".
  if (value !== value.toUpperCase() && value !== value.toLowerCase()) return value;
  return value.replace(/\b[a-z]+/gi, (word) =>
    word.length <= 2 ? word.toUpperCase() : word[0]!.toUpperCase() + word.slice(1).toLowerCase(),
  );
}

/**
 * An ISO timestamp, or null.
 *
 * Boards send epoch seconds, epoch milliseconds, ISO strings and their own
 * formats. A date in the future is a board bug (or a timezone artefact); it is
 * clamped to now rather than dropped, so the listing still sorts as fresh
 * instead of vanishing from a recency filter.
 */
export function normalizeDate(
  input: string | number | undefined | null,
  now = Date.now(),
): string | null {
  if (input === undefined || input === null || input === '') return null;

  let ms: number;
  if (typeof input === 'number') {
    ms = input < 1e12 ? input * 1000 : input;
  } else if (/^\d{9,13}$/.test(input.trim())) {
    const digits = Number(input.trim());
    ms = digits < 1e12 ? digits * 1000 : digits;
  } else {
    ms = Date.parse(input);
  }

  if (!Number.isFinite(ms)) return null;
  // Before 1990 is a parse artefact, not a job posting.
  if (ms < 631_152_000_000) return null;
  return new Date(Math.min(ms, now)).toISOString();
}

/** An absolute http(s) URL, or null. Relative and `javascript:` links are dropped. */
export function normalizeUrl(input: string | undefined | null): string | null {
  const value = input?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Deduplication                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Collapse the same opening seen through several sources into one lead, keeping
 * the most informative copy.
 *
 * "Most informative" is ordered deliberately: a full description outranks
 * everything, because it is what lets the job score above the low-confidence
 * ceiling at all. After that, a disclosed salary, then a longer description,
 * then an ATS source — an ATS link applies directly, while an aggregator link
 * usually bounces through a redirect that may already be dead.
 */
export function dedupeJobs(jobs: readonly Job[]): Job[] {
  const best = new Map<string, Job>();
  for (const job of jobs) {
    const existing = best.get(job.fingerprint);
    if (!existing) {
      best.set(job.fingerprint, job);
      continue;
    }
    best.set(job.fingerprint, mergeDuplicates(existing, job));
  }
  return [...best.values()];
}

const SOURCE_RANK: Record<string, number> = {
  greenhouse: 5,
  lever: 5,
  ashby: 5,
  workable: 5,
  smartrecruiters: 5,
  recruitee: 5,
  remotive: 3,
  himalayas: 3,
  remoteok: 3,
  adzuna: 2,
  jooble: 2,
  jsearch: 2,
  linkedin: 1,
  naukri: 1,
  indeed: 1,
  foundit: 1,
  cutshort: 1,
};

/**
 * Pick the better of two copies, then backfill the winner from the loser — a
 * scraped duplicate often carries the salary the ATS payload omitted, and there
 * is no reason to throw that away just because its description was thinner.
 */
export function mergeDuplicates(a: Job, b: Job): Job {
  const winner = richness(b) > richness(a) ? b : a;
  const other = winner === a ? b : a;

  return {
    ...winner,
    company: {
      ...winner.company,
      website: winner.company.website ?? other.company.website,
      careersUrl: winner.company.careersUrl ?? other.company.careersUrl,
      atsPortalUrl: winner.company.atsPortalUrl ?? other.company.atsPortalUrl,
      careersEmail: winner.company.careersEmail ?? other.company.careersEmail,
    },
    salary: hasSalary(winner.salary) ? winner.salary : other.salary,
    postedAt: winner.postedAt ?? other.postedAt,
    sourcePublisher: winner.sourcePublisher ?? other.sourcePublisher,
    employmentType: winner.employmentType ?? other.employmentType,
    isRemote: winner.isRemote || other.isRemote,
    techStack: [...new Set([...winner.techStack, ...other.techStack])],
    requiredYears: {
      min: winner.requiredYears.min ?? other.requiredYears.min,
      max: winner.requiredYears.max ?? other.requiredYears.max,
    },
    firstSeenAt: earlier(winner.firstSeenAt, other.firstSeenAt),
    lastSeenAt: later(winner.lastSeenAt, other.lastSeenAt),
  };
}

function richness(job: Job): number {
  let score = 0;
  if (job.hasFullDescription) score += 1000;
  if (hasSalary(job.salary)) score += 200;
  score += Math.min(job.descriptionText.length / 100, 100);
  score += SOURCE_RANK[job.source] ?? 0;
  return score;
}

function hasSalary(salary: Salary): boolean {
  return salary.annualMin !== null || salary.annualMax !== null;
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function earlier(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function later(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

/** One-line description of a job, for run logs. */
export function describeJob(job: Job): string {
  return snippet(`${job.title} · ${job.company.name} · ${job.location}`, 120);
}

/* -------------------------------------------------------------------------- */
/* Board vocabulary                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The next two functions translate a board's spelling of a value into the app's.
 * They live here rather than beside the ATS adapters because the remote feeds
 * need them just as much — Himalayas writes "Full Time" and "annual" — and a
 * second copy is how the two families would drift apart.
 */

/**
 * Read an employment type out of whatever the board called it.
 *
 * The six ATSs write the same five types in five different casings —
 * `FullTime`, `full_time`, `Full-time`, `fulltime` — and the shared detector
 * only recognises prose. Normalising first means one detector serves all of
 * them instead of each adapter carrying its own lookup table.
 */
export function employmentTypeFrom(raw: string | null | undefined): EmploymentType | null {
  if (!raw) return null;
  const spaced = raw
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(full|part)\s*time\b/gi, '$1-time')
    .trim();
  return detectEmploymentType(spaced);
}

/**
 * Read a pay period out of whatever the board called it.
 *
 * Each ATS spells the same five periods differently — Lever writes
 * `per-year-salary`, Ashby writes `1 YEAR`, Recruitee writes `yearly` — and the
 * cost of getting it wrong is a 2080× error in the annualised figure the user
 * compares against their expected CTC. An unrecognised interval returns null so
 * that `normalizeSalary` treats the amount as annual rather than silently
 * multiplying it.
 */
export function periodFrom(interval: string | null | undefined): Salary['period'] {
  const value = (interval ?? '').toLowerCase();
  if (!value) return null;
  if (value.includes('hour')) return 'hour';
  if (value.includes('week')) return 'week';
  if (value.includes('month')) return 'month';
  if (value.includes('year') || value.includes('annual')) return 'year';
  // Checked last: "daily" is distinctive, but "day" appears inside other words.
  if (/\bday|daily\b/.test(value)) return 'day';
  return null;
}
