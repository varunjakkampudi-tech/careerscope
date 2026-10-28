/**
 * Types that are shared but never cross the wire, so they carry no Zod schema:
 * the provider ingestion contract, the matching engine's inputs, and small
 * helpers used by both the API and the web client.
 */

import type { EmploymentType, SeniorityLabel, SourceId } from './constants.js';
import type {
  ApplicationDetails,
  Candidate,
  DerivedResume,
  MatchBreakdown,
  Preferences,
  Salary,
} from './schemas.js';

/* -------------------------------------------------------------------------- */
/* Provider ingestion                                                         */
/* -------------------------------------------------------------------------- */

/**
 * What a provider yields before normalisation. Everything is optional except the
 * few fields we cannot dedupe or display without, because boards are wildly
 * inconsistent about what they return.
 */
export interface RawJob {
  source: SourceId;
  /** The board's own id. Combined with `source` to detect re-fetches. */
  sourceJobId: string;
  title: string;
  companyName: string;
  location?: string;
  isRemote?: boolean;
  employmentType?: EmploymentType | null;
  /** Raw description — HTML or plain text; normalisation strips tags. */
  description?: string;
  descriptionIsHtml?: boolean;
  /**
   * False when the provider only returned a teaser. Drives the low-confidence
   * clamp in the matching engine.
   */
  hasFullDescription: boolean;
  salaryRaw?: string;
  salaryMin?: number;
  salaryMax?: number;
  salaryCurrency?: string;
  salaryPeriod?: Salary['period'];
  postedAt?: string;
  applyUrl?: string;
  sourceUrl: string;
  /**
   * The board this posting originally came from, when an aggregator reports it.
   * Only JSearch populates this; every other source is itself the origin.
   */
  sourcePublisher?: string;
  /** Anything the provider knows about the employer, used to seed `companies`. */
  companyWebsite?: string;
  companyCareersUrl?: string;
  /**
   * A careers address the ATS itself published. Only Recruitee returns one, and
   * because it comes from the employer's own board configuration it is
   * `verified` provenance — unlike anything scraped or, worse, constructed.
   * Enrichment never invents this field; when it is absent the UI says so.
   */
  companyCareersEmail?: string;
  companyLinkedinUrl?: string;
  /** ATS slug when the provider is itself an ATS, e.g. "greenhouse". */
  atsType?: string;
}

/** Everything a provider needs to run one search. */
export interface ProviderQuery {
  titles: string[];
  locations: string[];
  /**
   * Words that disqualify a posting, not words to search for. Named explicitly
   * because a bare `keywords` reads as the opposite, and a provider that
   * searched for these instead of excluding them would return exactly the jobs
   * the user asked never to see.
   */
  excludeKeywords: string[];
  remoteOnly: boolean;
  employmentTypes: EmploymentType[];
  postedWithinDays: number;
  maxResults: number;
}

/** Same grouping as the `kind` field of `sourceInfoSchema`. */
export type SourceKind = 'ats' | 'api' | 'remote' | 'scrape' | 'email';

/* -------------------------------------------------------------------------- */
/* Matching engine input                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The candidate side of a comparison. Assembled once per run from the stored
 * profile plus the parsed resume, then reused for every job — the engine never
 * touches the database.
 */
export interface CandidateContext {
  skills: string[];
  /** Skills from the most recent role; weighted above older ones. */
  recentSkills: string[];
  titles: string[];
  /** Null means the candidate has not supplied usable experience evidence. */
  yearsOfExperience: number | null;
  locations: string[];
  homeLocation: string;
  remoteOnly: boolean;
  willingToRelocate: boolean;
  /** Annual figure, normalised from the profile's "14 LPA" style input. */
  expectedSalary: number | null;
  /**
   * Currency of `expectedSalary` (ISO code), or null when the expectation names none.
   * A null currency is never treated as a mismatch.
   */
  expectedCurrency: string | null;
  minSalary: number | null;
  employmentTypes: EmploymentType[];
  excludeKeywords: string[];
  excludeCompanies: string[];
  /** Full resume text. */
  resumeText: string;
  /**
   * False when no parsed resume was available to build this context — distinct
   * from a resume that was considered and simply contributed nothing. Without
   * this, "no resume" and "resume matched zero skills" render identically.
   */
  resumeConsidered: boolean;
  /** Skills sourced from the resume specifically, not the profile's typed tech
   * stack — so the resume's contribution is visible in match evidence, not
   * silently folded into the combined skills list. */
  resumeSkills: string[];
}

/** A skill demanded by a job description, weighted by how hard the ask was. */
export interface DemandedSkill {
  skill: string;
  /** 1.0 for required, 0.5 for preferred/nice-to-have. */
  weight: number;
}

/** What the engine reads out of a job description before scoring. */
export interface JobDemands {
  skills: DemandedSkill[];
  minYears: number | null;
  maxYears: number | null;
  seniority: SeniorityLabel | null;
  isRemote: boolean;
  employmentType: EmploymentType | null;
}

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                       */
/* -------------------------------------------------------------------------- */

/** Generic page of results with the total match count and the paging window used. */
export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Profile fields the matching engine actually consumes. `Profile` satisfies this
 * structurally, so the API can pass a stored profile straight through.
 *
 * The consumer declares its own minimum. `application` is narrowed to the three
 * fields `packages/matching/src/context.ts` reads. The `MatchingProfile`
 * snapshot in `packages/core/src/profile.ts` carries exactly those three
 * (data minimisation). If `context.ts` ever reads a fourth field, this type
 * makes that a compile error where it is read, instead of a silent `undefined`
 * inside scoring.
 *
 * Callers passing a wider object, such as a stored `Profile`, still satisfy
 * this structurally.
 */
export type MatchableProfile = {
  candidate: Pick<Candidate, 'location'>;
  preferences: Preferences;
  application: Pick<ApplicationDetails, 'expectedCtc' | 'yearsOfExperience' | 'willingToRelocate'>;
  derived: DerivedResume | null;
};

/* -------------------------------------------------------------------------- */
/* Search, collected-job and profile-write shapes used by the web client      */
/* -------------------------------------------------------------------------- */

/**
 * These describe the validated shapes that `@careerscope/core` parses with Zod. They live here so the
 * web client can name them without importing the server-side package. Core asserts at compile time
 * that its schema-derived types stay identical to these (see the `AssertSame` checks in
 * `packages/core/src/commands.ts`, `jobs.ts` and `profile.ts`).
 */

/** Job boards the launch search worker can run. */
export type SearchSourceName =
  'remoteok' | 'himalayas' | 'greenhouse' | 'lever' | 'ashby' | 'workable';

/** Body of a search request after validation. */
export type CreateSearch = {
  query: string;
  useProfileTitles?: boolean | undefined;
  origin: 'manual' | 'scheduled';
  sources: SearchSourceName[];
};

/** One job as stored for a run or lead. */
export type CollectedJob = {
  fingerprint: string;
  sourceJobId?: string | undefined;
  title: string;
  company: string;
  location: string;
  description: string;
  source: SearchSourceName;
  sourceUrl: string;
  sourceLinks?: { source: SearchSourceName; url: string }[] | undefined;
  applyUrl: string;
  postedAt: string | null;
  match: MatchBreakdown | null;
};

/** Validated profile content a client may write. */
export type WritableProfile = {
  candidate: Candidate;
  preferences: Preferences;
  application: ApplicationDetails;
  accessibility: { reducedMotion: boolean };
};

/** Compile-time equality check used by core to keep its Zod-derived types in step with the ones above. */
export type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
