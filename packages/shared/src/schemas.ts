import { z } from 'zod';
import {
  ALL_SOURCES,
  EMPLOYMENT_TYPES,
  LEAD_STATUSES,
  RUN_STATUSES,
  DEFAULT_MATCH_THRESHOLD,
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_DAYS,
  MATCH_WEIGHTS,
  type MatchDimension,
} from './constants.js';

/* -------------------------------------------------------------------------- */
/* Candidate profile                                                          */
/* -------------------------------------------------------------------------- */

export const candidateSchema = z.object({
  fullName: z.string().trim().min(1, 'Name is required').max(120),
  email: z.string().trim().email('Enter a valid email'),
  phone: z.string().trim().max(40).default(''),
  location: z.string().trim().min(1, 'Location is required').max(120),
  linkedin: z.string().trim().url().or(z.literal('')).default(''),
  github: z.string().trim().url().or(z.literal('')).default(''),
  portfolio: z.string().trim().url().or(z.literal('')).default(''),
});

export const preferencesSchema = z.object({
  /** Role titles the candidate is targeting, e.g. "Senior Software Engineer". */
  titles: z.array(z.string().trim().min(1)).min(1, 'Add at least one target role').max(25),
  /** Skills the candidate has. Seeded from the resume, editable by the user. */
  techStack: z.array(z.string().trim().min(1)).min(1, 'Add at least one skill').max(120),
  locations: z.array(z.string().trim().min(1)).max(25).default([]),
  remoteOnly: z.boolean().default(false),
  /** Annual figure in the profile currency. null = no floor. */
  minSalary: z.number().int().nonnegative().nullable().default(null),
  employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).min(1).default(['fulltime']),
  /** A listing containing any of these is excluded outright. */
  excludeKeywords: z.array(z.string().trim().min(1)).max(60).default([]),
  /** Shown in results but flagged — never auto-applied to. */
  excludeCompanies: z.array(z.string().trim().min(1)).max(200).default([]),
});

export const applicationSchema = z.object({
  currentCtc: z.string().trim().max(40).default(''),
  expectedCtc: z.string().trim().max(40).default(''),
  noticePeriodDays: z.number().int().min(0).max(365).default(0),
  willingToRelocate: z.boolean().default(true),
  yearsOfExperience: z.number().min(0).max(60).default(0),
});

export const profileSchema = z.object({
  id: z.string().optional(),
  candidate: candidateSchema,
  preferences: preferencesSchema,
  application: applicationSchema,
  resumeId: z.string().nullable().default(null),
  updatedAt: z.string().optional(),
});

export type Candidate = z.infer<typeof candidateSchema>;
export type Preferences = z.infer<typeof preferencesSchema>;
export type ApplicationDetails = z.infer<typeof applicationSchema>;
export type Profile = z.infer<typeof profileSchema>;

/** PUT /api/profile accepts a partial and deep-merges it. */
export const profileUpdateSchema = z.object({
  candidate: candidateSchema.partial().optional(),
  preferences: preferencesSchema.partial().optional(),
  application: applicationSchema.partial().optional(),
  resumeId: z.string().nullable().optional(),
});
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;

/* -------------------------------------------------------------------------- */
/* Resume                                                                     */
/* -------------------------------------------------------------------------- */

export const derivedResumeSchema = z.object({
  fullName: z.string().optional(),
  email: z.string().optional(),
  phone: z.string().optional(),
  location: z.string().optional(),
  linkedin: z.string().optional(),
  github: z.string().optional(),
  portfolio: z.string().optional(),
  /** Canonical skill names detected in the resume text. */
  techStack: z.array(z.string()),
  /** Skills seen in the most recent role — weighted higher when scoring. */
  recentSkills: z.array(z.string()).default([]),
  /** Job titles found in the experience section, most recent first. */
  titles: z.array(z.string()).default([]),
  yearsOfExperience: z.number().nullable(),
});
export type DerivedResume = z.infer<typeof derivedResumeSchema>;

export const resumeSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number(),
  /** Character count of the extracted text — a cheap parse-quality signal. */
  textLength: z.number(),
  derived: derivedResumeSchema,
  createdAt: z.string(),
});
export type Resume = z.infer<typeof resumeSchema>;

/* -------------------------------------------------------------------------- */
/* Companies                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How much to trust an enriched company field. Nothing is ever guessed: a value
 * is either observed from a real page/API or left null with a note explaining
 * why. The UI renders "unverified" rather than a fabricated link.
 */
export const confidenceSchema = z.enum(['verified', 'probable', 'unverified']);
export type Confidence = z.infer<typeof confidenceSchema>;

export const companySchema = z.object({
  id: z.string(),
  name: z.string(),
  website: z.string().nullable(),
  careersUrl: z.string().nullable(),
  /** Which applicant tracking system the company's portal runs on, if detected. */
  atsType: z.string().nullable(),
  atsPortalUrl: z.string().nullable(),
  careersEmail: z.string().nullable(),
  emailConfidence: confidenceSchema.default('unverified'),
  websiteConfidence: confidenceSchema.default('unverified'),
  linkedinUrl: z.string().nullable(),
  /** Free-text provenance, e.g. "careers page returned 404". */
  note: z.string().nullable(),
  resolvedAt: z.string().nullable(),
});
export type Company = z.infer<typeof companySchema>;

/* -------------------------------------------------------------------------- */
/* Jobs                                                                       */
/* -------------------------------------------------------------------------- */

export const salarySchema = z.object({
  /** The board's original text, preserved verbatim for display. */
  raw: z.string().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  currency: z.string().nullable(),
  period: z.enum(['year', 'month', 'week', 'day', 'hour']).nullable(),
  /** min/max normalised to an annual figure in `currency`. */
  annualMin: z.number().nullable(),
  annualMax: z.number().nullable(),
});
export type Salary = z.infer<typeof salarySchema>;

export const jobSchema = z.object({
  id: z.string(),
  /** Stable hash of normalised title+company+location — dedupes across sources. */
  fingerprint: z.string(),
  source: z.enum(ALL_SOURCES),
  sourceJobId: z.string(),
  title: z.string(),
  company: companySchema.pick({ id: true, name: true }).extend({
    website: z.string().nullable().default(null),
    careersUrl: z.string().nullable().default(null),
    atsPortalUrl: z.string().nullable().default(null),
    careersEmail: z.string().nullable().default(null),
    emailConfidence: confidenceSchema.default('unverified'),
  }),
  location: z.string(),
  isRemote: z.boolean().default(false),
  employmentType: z.enum(EMPLOYMENT_TYPES).nullable(),
  salary: salarySchema,
  postedAt: z.string().nullable(),
  /** Full job description in plain text. Empty when only a snippet was available. */
  descriptionText: z.string(),
  /**
   * False when the source only gave a teaser. The matching engine caps such
   * listings at LOW_CONFIDENCE_SCORE_CEILING, so crossing the user's threshold
   * always implies the description was genuinely read.
   */
  hasFullDescription: z.boolean().default(true),
  /** Technologies detected in the description. */
  techStack: z.array(z.string()),
  /** Years of experience the description asks for. */
  requiredYears: z.object({ min: z.number().nullable(), max: z.number().nullable() }),
  /** Where to apply — the direct posting or ATS form. */
  applyUrl: z.string(),
  /** The listing on the source board. */
  sourceUrl: z.string(),
  /**
   * The board the posting *originally* appeared on, when the source is an
   * aggregator that says so. JSearch reports "LinkedIn", "Indeed", "Glassdoor";
   * every other source leaves this null because it is itself the origin.
   *
   * It is shown next to the source badge, so a lead reads "JSearch · via
   * LinkedIn" rather than implying the app crawled LinkedIn directly.
   */
  sourcePublisher: z.string().nullable().default(null),
  firstSeenAt: z.string(),
  lastSeenAt: z.string(),
});
export type Job = z.infer<typeof jobSchema>;

/* -------------------------------------------------------------------------- */
/* Matching                                                                   */
/* -------------------------------------------------------------------------- */

export const matchDimensionScoreSchema = z.object({
  score: z.number().min(0).max(1),
  weight: z.number().min(0).max(1),
  /** One line explaining the score, shown on hover in the UI. */
  reason: z.string(),
});
export type MatchDimensionScore = z.infer<typeof matchDimensionScoreSchema>;

/**
 * Built from MATCH_WEIGHTS rather than hand-listed, so adding a dimension to the
 * engine is a one-line change that the schema and the UI both pick up.
 */
const dimensionShape = Object.fromEntries(
  (Object.keys(MATCH_WEIGHTS) as MatchDimension[]).map((d) => [d, matchDimensionScoreSchema]),
) as Record<MatchDimension, typeof matchDimensionScoreSchema>;

export const matchDimensionsSchema = z.object(dimensionShape);
export type MatchDimensions = z.infer<typeof matchDimensionsSchema>;

export const matchBreakdownSchema = z.object({
  /** Final 0..1 score after weighting, gates, clamps and any LLM blend. */
  score: z.number().min(0).max(1),
  /** Score from the deterministic engine alone, before any LLM blend. */
  heuristicScore: z.number().min(0).max(1),
  dimensions: matchDimensionsSchema,
  matchedSkills: z.array(z.string()),
  missingSkills: z.array(z.string()),
  /** 'low' when only a snippet was available — score is capped in that case. */
  confidence: z.enum(['high', 'low']),
  /** Populated when a hard gate rejected the listing. */
  excludedReason: z.string().nullable().default(null),
  /** True when the company is on the do-not-apply list. Shown, never auto-applied. */
  flaggedCompany: z.boolean().default(false),
  llmScore: z.number().min(0).max(1).nullable().default(null),
  llmRationale: z.string().nullable().default(null),
});
export type MatchBreakdown = z.infer<typeof matchBreakdownSchema>;

/* -------------------------------------------------------------------------- */
/* Leads                                                                      */
/* -------------------------------------------------------------------------- */

export const leadSchema = z.object({
  id: z.string(),
  runId: z.string().nullable(),
  job: jobSchema,
  match: matchBreakdownSchema,
  status: z.enum(LEAD_STATUSES),
  note: z.string().default(''),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Lead = z.infer<typeof leadSchema>;

export const leadUpdateSchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  note: z.string().max(4000).optional(),
});
export type LeadUpdate = z.infer<typeof leadUpdateSchema>;

export const leadBulkUpdateSchema = z.object({
  ids: z.array(z.string()).min(1).max(500),
  status: z.enum(LEAD_STATUSES),
});

/** Query string for GET /api/leads. */
export const leadQuerySchema = z.object({
  minScore: z.coerce.number().min(0).max(1).default(0),
  sources: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined)),
  statuses: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(',').filter(Boolean) : undefined)),
  location: z.string().optional(),
  company: z.string().optional(),
  search: z.string().optional(),
  remoteOnly: z.coerce.boolean().optional(),
  postedWithinDays: z.coerce.number().int().min(1).max(365).optional(),
  minSalary: z.coerce.number().int().nonnegative().optional(),
  runId: z.string().optional(),
  sort: z.enum(['score', 'postedAt', 'company', 'title', 'salary']).default('score'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type LeadQuery = z.infer<typeof leadQuerySchema>;

export const leadPageSchema = z.object({
  items: z.array(leadSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
  /** Counts across the whole filtered set, for the UI summary strip. */
  facets: z.object({
    bySource: z.record(z.string(), z.number()),
    byStatus: z.record(z.string(), z.number()),
    aboveThreshold: z.number(),
  }),
});
export type LeadPage = z.infer<typeof leadPageSchema>;

/* -------------------------------------------------------------------------- */
/* Skill gap                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * One skill, counted across the leads that asked for it.
 *
 * `nearMissCount` is the number that matters. A skill missing from a job you
 * scored 30% on says nothing — you were never close. The same skill missing
 * from the jobs you scored 78% on is the thing standing between you and the
 * threshold, and that is a different fact about your week.
 */
export const skillGapEntrySchema = z.object({
  skill: z.string(),
  /** Near-miss leads whose JD demanded this skill and did not find it on you. */
  nearMissCount: z.number().int().nonnegative(),
  /** The same, across every lead regardless of score. Context for the first. */
  totalCount: z.number().int().nonnegative(),
  /** Mean score of the near-miss leads that wanted it, 0..1. */
  averageScore: z.number().min(0).max(1),
});
export type SkillGapEntry = z.infer<typeof skillGapEntrySchema>;

/**
 * What the lead corpus says about a candidate, as opposed to about any one job.
 *
 * Deliberately descriptive, never predictive. It reports "Kafka was demanded by
 * 9 of your 14 near-misses"; it does not claim learning Kafka would convert
 * them. That claim needs the scorer re-run against a counterfactual resume, and
 * asserting it without doing so would be exactly the kind of confident guess
 * the rest of this app refuses to make.
 */
export const skillGapSchema = z.object({
  /** The threshold this was computed against, echoed so the UI can label it. */
  threshold: z.number().min(0).max(1),
  /** The score window treated as "near miss": `[threshold - band, threshold)`. */
  nearMissFloor: z.number().min(0).max(1),
  totalLeads: z.number().int().nonnegative(),
  nearMissLeads: z.number().int().nonnegative(),
  /** Skills the JDs wanted and the resume lacked, most-blocking first. */
  gaps: z.array(skillGapEntrySchema),
  /** Skills the resume has that the JDs keep asking for, most in demand first. */
  strengths: z.array(skillGapEntrySchema),
});
export type SkillGap = z.infer<typeof skillGapSchema>;

/** Query string for GET /api/leads/skill-gap. */
export const skillGapQuerySchema = z.object({
  threshold: z.coerce.number().min(0).max(1).default(DEFAULT_MATCH_THRESHOLD),
  /** How far below the threshold still counts as "nearly there". */
  band: z.coerce.number().min(0.01).max(0.5).default(0.15),
  limit: z.coerce.number().int().min(1).max(50).default(12),
});
export type SkillGapQuery = z.infer<typeof skillGapQuerySchema>;

/* -------------------------------------------------------------------------- */
/* Search runs                                                                */
/* -------------------------------------------------------------------------- */

export const searchRequestSchema = z.object({
  sources: z.array(z.enum(ALL_SOURCES)).min(1, 'Pick at least one source'),
  /** Leads below this are still stored but flagged; the UI filters on it. */
  minScore: z.number().min(0).max(1).default(DEFAULT_MATCH_THRESHOLD),
  maxResults: z.number().int().min(1).max(1000).default(DEFAULT_MAX_RESULTS),
  postedWithinDays: z.number().int().min(1).max(365).default(DEFAULT_SEARCH_DAYS),
  /** Override the profile's titles for this run only. */
  titles: z.array(z.string()).optional(),
  locations: z.array(z.string()).optional(),
  /** Run the Claude semantic pass on the top candidates. Requires an API key. */
  useLlmRerank: z.boolean().default(false),
});
export type SearchRequest = z.infer<typeof searchRequestSchema>;

export const sourceStatSchema = z.object({
  source: z.enum(ALL_SOURCES),
  fetched: z.number(),
  kept: z.number(),
  errors: z.number(),
  /** Null while the source is still running. */
  durationMs: z.number().nullable(),
  message: z.string().nullable(),
});
export type SourceStat = z.infer<typeof sourceStatSchema>;

export const searchRunSchema = z.object({
  id: z.string(),
  status: z.enum(RUN_STATUSES),
  request: searchRequestSchema,
  stage: z.string(),
  progress: z.number().min(0).max(1),
  stats: z.object({
    fetched: z.number(),
    deduped: z.number(),
    enriched: z.number(),
    scored: z.number(),
    /** Leads at or above the run's threshold. */
    matched: z.number(),
    bySource: z.array(sourceStatSchema),
  }),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type SearchRun = z.infer<typeof searchRunSchema>;

/** Events pushed over SSE while a run executes. */
export const runEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    stage: z.string(),
    progress: z.number(),
    stats: searchRunSchema.shape.stats,
  }),
  z.object({
    type: z.literal('log'),
    level: z.enum(['info', 'warn', 'error']),
    message: z.string(),
    source: z.string().nullable().default(null),
  }),
  z.object({ type: z.literal('lead'), lead: leadSchema }),
  z.object({ type: z.literal('done'), run: searchRunSchema }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type RunEvent = z.infer<typeof runEventSchema>;

/* -------------------------------------------------------------------------- */
/* Sources / capability discovery                                             */
/* -------------------------------------------------------------------------- */

export const sourceInfoSchema = z.object({
  id: z.enum(ALL_SOURCES),
  label: z.string(),
  kind: z.enum(['ats', 'api', 'remote', 'scrape', 'email']),
  /** False when a required API key is missing or the source is disabled. */
  enabled: z.boolean(),
  requiresKey: z.boolean(),
  /** Why it is unavailable, shown next to a disabled toggle. */
  disabledReason: z.string().nullable(),
  /** Whether this source supplies a full job description. */
  providesFullDescription: z.boolean(),
});
export type SourceInfo = z.infer<typeof sourceInfoSchema>;

/**
 * Server-side switches the UI has to know about before it offers a control.
 *
 * A checkbox for semantic rerank on an install without `ENABLE_LLM_RERANK` is a
 * trap: it looks available, and the refusal arrives as a 422 only after the user
 * has filled in the rest of the form. Better to disable it up front and say why.
 */
export const capabilitiesSchema = z.object({
  /** `ENABLE_LLM_RERANK` — Claude may adjust the heuristic score. */
  llmRerank: z.boolean(),
  /** `ENABLE_SCRAPERS` — the browser-driven sources are startable. */
  scrapers: z.boolean(),
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

export const sourceCatalogSchema = z.object({
  sources: z.array(sourceInfoSchema),
  capabilities: capabilitiesSchema,
});
export type SourceCatalog = z.infer<typeof sourceCatalogSchema>;

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
