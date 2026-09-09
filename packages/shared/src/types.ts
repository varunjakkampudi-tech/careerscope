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
  yearsOfExperience: number;
  locations: string[];
  homeLocation: string;
  remoteOnly: boolean;
  willingToRelocate: boolean;
  /** Annual figure, normalised from the profile's "14 LPA" style input. */
  expectedSalary: number | null;
  minSalary: number | null;
  employmentTypes: EmploymentType[];
  excludeKeywords: string[];
  excludeCompanies: string[];
  /** Full resume text, used by the optional LLM rerank pass. */
  resumeText: string;
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

export interface Paginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * Profile fields the matching engine actually consumes. `Profile` satisfies this
 * structurally, so the API can pass a stored profile straight through.
 */
export type MatchableProfile = {
  candidate: Pick<Candidate, 'location'>;
  preferences: Preferences;
  application: ApplicationDetails;
  derived: DerivedResume | null;
};
