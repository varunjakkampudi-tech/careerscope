/**
 * Enumerations and tunable constants shared by the API, the matching engine and
 * the web client. Keeping them here means a new job source or lead status is
 * added in exactly one place.
 */

/** Job sources, grouped by how they are reached. */
export const ATS_SOURCES = [
  'greenhouse',
  'lever',
  'ashby',
  'workable',
  'smartrecruiters',
  'recruitee',
] as const;

/** Aggregators that require a (free) API key. */
export const API_SOURCES = ['adzuna', 'jooble', 'jsearch'] as const;

/** Remote-first boards, no key required. */
export const REMOTE_SOURCES = ['remotive', 'remoteok', 'himalayas'] as const;

/** Logged-in scrapers. Opt-in only — see ENABLE_SCRAPERS. */
export const SCRAPE_SOURCES = ['linkedin', 'naukri', 'indeed', 'foundit', 'cutshort'] as const;

export const ALL_SOURCES = [
  ...ATS_SOURCES,
  ...API_SOURCES,
  ...REMOTE_SOURCES,
  ...SCRAPE_SOURCES,
  'gmail',
] as const;

export type AtsSource = (typeof ATS_SOURCES)[number];
export type ApiSource = (typeof API_SOURCES)[number];
export type RemoteSource = (typeof REMOTE_SOURCES)[number];
export type ScrapeSource = (typeof SCRAPE_SOURCES)[number];
export type SourceId = (typeof ALL_SOURCES)[number];

/** Human-readable labels for the UI. */
export const SOURCE_LABELS: Record<SourceId, string> = {
  greenhouse: 'Greenhouse',
  lever: 'Lever',
  ashby: 'Ashby',
  workable: 'Workable',
  smartrecruiters: 'SmartRecruiters',
  recruitee: 'Recruitee',
  adzuna: 'Adzuna',
  jooble: 'Jooble',
  jsearch: 'JSearch',
  remotive: 'Remotive',
  remoteok: 'RemoteOK',
  himalayas: 'Himalayas',
  linkedin: 'LinkedIn',
  naukri: 'Naukri',
  indeed: 'Indeed',
  foundit: 'Foundit',
  cutshort: 'Cutshort',
  gmail: 'Gmail job alerts',
};

/** Where a lead sits in the user's pipeline. */
export const LEAD_STATUSES = [
  'new',
  'saved',
  'applied',
  'interviewing',
  'rejected',
  'dismissed',
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const RUN_STATUSES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const EMPLOYMENT_TYPES = [
  'fulltime',
  'parttime',
  'contract',
  'internship',
  'temporary',
] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/**
 * Seniority ladder. Used both to read a level out of a job title and to compare
 * it against the candidate's target level.
 */
export const SENIORITY_LEVELS = {
  intern: 0,
  junior: 1,
  mid: 2,
  senior: 3,
  staff: 4,
  principal: 5,
} as const;
export type SeniorityLabel = keyof typeof SENIORITY_LEVELS;

/**
 * Weights for the match dimensions. They sum to 1.0, so the final score stays a
 * genuine 0..1 percentage. Exported so the UI can render the same breakdown the
 * engine used rather than duplicating the numbers.
 */
export const MATCH_WEIGHTS = {
  skills: 0.4,
  title: 0.15,
  seniority: 0.12,
  experience: 0.1,
  location: 0.1,
  compensation: 0.08,
  recency: 0.05,
} as const;

export type MatchDimension = keyof typeof MATCH_WEIGHTS;

export const MATCH_DIMENSION_LABELS: Record<MatchDimension, string> = {
  skills: 'Skills',
  title: 'Role title',
  seniority: 'Seniority',
  experience: 'Experience',
  location: 'Location',
  compensation: 'Compensation',
  recency: 'Freshness',
};

/**
 * A listing we only have a title and a short snippet for cannot honestly claim a
 * high match, so its score is capped here. Crossing the default 85% threshold
 * therefore always implies the full job description was actually read.
 */
export const LOW_CONFIDENCE_SCORE_CEILING = 0.8;

/**
 * Sources whose API returns a truncated snippet instead of the job description.
 *
 * Not a scoring input — the engine decides confidence per job, from the text it
 * actually received, because a source that usually sends a full description will
 * occasionally send an empty one. This list is the *advance* warning: it lets
 * the search screen say that a source's leads are capped at
 * {@link LOW_CONFIDENCE_SCORE_CEILING} before the run starts, rather than
 * leaving the user to work it out from results that never cross their
 * threshold.
 *
 * Jooble and Gmail alerts qualify. Adzuna and JSearch are excluded deliberately:
 * both return a real description most of the time and a snippet occasionally,
 * which is a per-job fact, not a per-source one.
 */
export const SNIPPET_ONLY_SOURCES: readonly SourceId[] = ['jooble', 'gmail'];

/** Default match threshold, as a fraction. The UI exposes this as a slider. */
export const DEFAULT_MATCH_THRESHOLD = 0.85;

/** Only consider listings posted within this many days by default. */
export const DEFAULT_SEARCH_DAYS = 30;

export const DEFAULT_MAX_RESULTS = 200;

/** Upload limits for resumes. */
export const MAX_RESUME_BYTES = 10 * 1024 * 1024;
export const ALLOWED_RESUME_MIME = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
] as const;
