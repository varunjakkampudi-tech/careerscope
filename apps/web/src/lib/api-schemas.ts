/**
 * Runtime schemas for every JSON body the web app reads from the API. Each parser is passed to
 * apiParsed (see api.ts), so a response that does not match what a screen reads is rejected
 * at the boundary instead of failing later inside a component. Types are inferred from the
 * schemas, so the type a component sees is always the shape that was actually checked.
 *
 * Schemas list the fields the screens read, as the route handlers in apps/api/src/app.ts
 * return them (dates are ISO strings on the wire). Unknown keys are dropped. Validators are
 * shape-only: the server already applied its own limits, and the browser must not reject stored
 * data because a limit was tightened later.
 */

import { z } from 'zod';
import {
  EMPLOYMENT_TYPES,
  LAUNCH_JOB_SOURCE_CANDIDATES,
  derivedResumeSchema,
  jobFeedbackReasonSchema,
  matchBreakdownSchema,
} from '@careerscope/shared';

/** Message for a response that parsed as JSON but not as the expected shape. Fixed, so no server content reaches the screen. */
const UNEXPECTED_RESPONSE = 'The server sent an unexpected response. Please try again.';

/** Builds the parse function apiParsed expects: returns the typed body or throws a fixed-message Error. */
function parser<S extends z.ZodType>(schema: S): (body: unknown) => z.output<S> {
  return (body) => {
    const result = schema.safeParse(body);
    if (!result.success) throw new Error(UNEXPECTED_RESPONSE);
    return result.data;
  };
}

/* ---------------------------------- Session --------------------------------- */

const sessionSchema = z.object({
  authenticated: z.boolean(),
  csrf: z.string().optional(),
  sessionId: z.string().optional(),
  email: z.string().optional(),
  emailVerifiedAt: z.string().nullable().optional(),
  registrationEnabled: z.boolean().optional(),
  legalDocuments: z
    .object({
      termsVersion: z.string(),
      termsUrl: z.string(),
      privacyVersion: z.string(),
      privacyUrl: z.string(),
    })
    .optional(),
  emailOtpEnabled: z.boolean().optional(),
  testUsersEnabled: z.boolean().optional(),
  testAccounts: z
    .array(z.object({ email: z.string(), role: z.enum(['candidate', 'admin']) }))
    .optional(),
  testUser: z.enum(['candidate', 'admin']).optional(),
  /** Capability flag kept for the response shape; always false. */
  aiEnabled: z.boolean().optional(),
  /**
   * A stable, opaque per-user digest used in query-cache keys. Present **only**
   * when `authenticated` is true; the server's unauthenticated branch omits it.
   *
   * It is a SHA-256 digest of the user id, not the id itself, and not
   * anything derived from the session token. Deliberately:
   *
   * - **not the raw user id** — every API route derives it from the session
   *   and never from input, so publishing it would put the one value that must
   *   never be client-supplied into client hands;
   * - **not `email`** — that is optional and mutable, so it is an identity
   *   *proxy* rather than an identity, and an absent one silently produces a
   *   user-agnostic key;
   * - **not per-session** — a value that changed on each sign-in would churn
   *   the whole cache for no extra isolation.
   */
  owner: z.string().optional(),
});
/** Body of GET /api/session. Fields beyond authenticated are present only for the matching branch. */
export type Session = z.infer<typeof sessionSchema>;
export const parseSession = parser(sessionSchema);

/* --------------------------------- Account ---------------------------------- */

const accountSessionSchema = z.object({
  id: z.string(),
  createdAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
  deviceLabel: z.string(),
  current: z.boolean(),
});
export type AccountSession = z.infer<typeof accountSessionSchema>;
export const parseAccountSessions = parser(z.object({ sessions: z.array(accountSessionSchema) }));

const marketingConsentSchema = z.object({ optedIn: z.boolean(), version: z.string().nullable() });
export type MarketingConsent = z.infer<typeof marketingConsentSchema>;
export const parseMarketingConsent = parser(marketingConsentSchema);

export const parseEmailChangeVerification = parser(
  z.object({ verified: z.enum(['current', 'new']), emailChanged: z.boolean() }),
);
export const parseOtpRequest = parser(z.object({ resendAfterSeconds: z.number() }));

/* ------------------------------ Notifications ------------------------------- */

const notificationItemSchema = z.object({
  id: z.string(),
  leadId: z.string(),
  createdAt: z.string(),
  readAt: z.string().nullable(),
});
export type NotificationItem = z.infer<typeof notificationItemSchema>;
export const parseNotificationList = parser(
  z.object({ items: z.array(notificationItemSchema), unreadCount: z.number() }),
);

const notificationPreferencesSchema = z.object({ interviewRemindersInAppEnabled: z.boolean() });
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;
export const parseNotificationPreferences = parser(notificationPreferencesSchema);

/* ---------------------------------- Profile --------------------------------- */

const profileDataSchema = z.object({
  candidate: z.object({
    fullName: z.string(),
    email: z.string(),
    phone: z.string().default(''),
    location: z.string(),
    segment: z.enum(['student', 'fresher', 'experienced']).optional(),
    education: z.array(z.string()).default([]),
    graduationYear: z.number().optional(),
    projects: z.array(z.string()).default([]),
    linkedin: z.string().default(''),
    github: z.string().default(''),
    portfolio: z.string().default(''),
  }),
  preferences: z.object({
    titles: z.array(z.string()),
    techStack: z.array(z.string()),
    locations: z.array(z.string()).default([]),
    remoteOnly: z.boolean().default(false),
    minSalary: z.number().nullable().default(null),
    employmentTypes: z.array(z.enum(EMPLOYMENT_TYPES)).default(['fulltime']),
    excludeKeywords: z.array(z.string()).default([]),
    excludeCompanies: z.array(z.string()).default([]),
  }),
  application: z.object({
    currentCtc: z.string().default(''),
    expectedCtc: z.string().default(''),
    noticePeriodDays: z.number().default(0),
    willingToRelocate: z.boolean().default(true),
    yearsOfExperience: z.number().nullable().default(null),
  }),
  accessibility: z.object({ reducedMotion: z.boolean().default(false) }).optional(),
});

const profileResponseSchema = z.object({
  revision: z.number(),
  profile: profileDataSchema.nullable(),
  updatedAt: z.string().nullable(),
});
/** Body of GET and PUT /api/profile; profile is null before the first save. */
export type ProfileResponse = z.infer<typeof profileResponseSchema>;
export const parseProfileResponse = parser(profileResponseSchema);

export const parseAccessibilityPreference = parser(z.object({ reducedMotion: z.boolean() }));

/** The part of GET /api/profile the dashboard checklist and skills panel read. */
export const parseDashboardProfile = parser(
  z.object({
    revision: z.number(),
    profile: z
      .object({
        preferences: z.object({ techStack: z.array(z.string()), titles: z.array(z.string()) }),
      })
      .nullable(),
  }),
);

const evidenceSchema = z.object({ field: z.string(), value: z.string() });
const preparationReportSchema = z.object({
  profileRevision: z.number(),
  status: z.enum(['profile-required', 'review-required']),
  limitations: z.array(z.string()),
  checks: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      state: z.enum(['review', 'not-assessed']),
      detail: z.string(),
      evidence: z.array(evidenceSchema),
    }),
  ),
  questions: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(['clarification', 'practice']),
      question: z.string(),
      evidence: z.array(evidenceSchema),
    }),
  ),
});
/** Body of GET /api/preparation. */
export type PreparationReport = z.infer<typeof preparationReportSchema>;
export const parsePreparationReport = parser(preparationReportSchema);

/* ---------------------------------- Resumes --------------------------------- */

const resumeListSchema = z.object({
  enabled: z.boolean(),
  cancellationEnabled: z.boolean().optional(),
  items: z.array(
    z.object({
      id: z.string(),
      bytes: z.number(),
      contentType: z.string(),
      createdAt: z.string(),
      status: z.string(),
    }),
  ),
});
/** Body of GET /api/resumes. */
export type ResumeList = z.infer<typeof resumeListSchema>;
export const parseResumeList = parser(resumeListSchema);

const resumeParseOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('parsed'),
    parsed: z.object({ text: z.string(), derived: derivedResumeSchema }),
  }),
  z.object({
    status: z.literal('rejected'),
    errorCode: z.enum(['invalid_document', 'processing_failed']),
  }),
]);
const resumeDetailSchema = z.object({
  id: z.string(),
  status: z.string(),
  result: resumeParseOutcomeSchema.nullable(),
});
/** Facts a parsed resume proposes for the profile form. */
export type ResumeProposal = Extract<
  z.infer<typeof resumeParseOutcomeSchema>,
  { status: 'parsed' }
>['parsed']['derived'];
export const parseResumeDetail = parser(resumeDetailSchema);
export const parseResumeStatus = parser(z.object({ id: z.string(), status: z.string() }));
export const parseResumeUpload = parser(z.object({ id: z.string() }));

/* ------------------------------ Searches and jobs --------------------------- */

const searchSourceSchema = z.enum([
  'remoteok',
  'himalayas',
  'greenhouse',
  'lever',
  'ashby',
  'workable',
]);

const collectedJobSchema = z.object({
  fingerprint: z.string(),
  sourceJobId: z.string().optional(),
  title: z.string(),
  company: z.string(),
  location: z.string(),
  description: z.string(),
  source: searchSourceSchema,
  sourceUrl: z.string(),
  sourceLinks: z.array(z.object({ source: searchSourceSchema, url: z.string() })).optional(),
  applyUrl: z.string(),
  postedAt: z.string().nullable(),
  match: matchBreakdownSchema.nullable(),
});
/** One job as stored for a run or lead. */
export type CollectedJob = z.infer<typeof collectedJobSchema>;

const searchRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  createdAt: z.string(),
  request: z.object({ query: z.string() }),
});
export type SearchRun = z.infer<typeof searchRunSchema>;
export const parseSearchRuns = parser(z.object({ items: z.array(searchRunSchema) }));

const jobSourceCatalogSchema = z.object({
  items: z.array(
    z.object({
      id: z.enum(LAUNCH_JOB_SOURCE_CANDIDATES),
      label: z.string(),
      available: z.boolean(),
      unavailableReason: z.string().nullable(),
    }),
  ),
});
export const parseJobSourceCatalog = parser(jobSourceCatalogSchema);

const searchDetailSchema = z.object({
  runId: z.string(),
  status: z.string(),
  request: z.object({
    query: z.string(),
    sources: z.array(searchSourceSchema),
    useProfileTitles: z.boolean().optional(),
  }),
  sourceOutcomes: z
    .array(
      z.object({
        source: searchSourceSchema,
        status: z.enum(['completed', 'empty', 'failed']),
        accepted: z.number(),
        limited: z.boolean(),
        errorCode: z
          .enum([
            'source_failed',
            'source_timeout',
            'invalid_response',
            'source_permission_pending',
          ])
          .nullable(),
      }),
    )
    .nullable(),
  jobs: z.array(
    z.object({
      id: z.string(),
      data: collectedJobSchema,
      feedbackReason: jobFeedbackReasonSchema.nullable(),
    }),
  ),
  events: z.array(z.object({ cursor: z.string(), type: z.string(), createdAt: z.string() })),
});
/** Body of GET /api/searches/:id. */
export type SearchDetail = z.infer<typeof searchDetailSchema>;
export const parseSearchDetail = parser(searchDetailSchema);

/** The part of a search detail the dashboard recommended-jobs and top-skills panels read. */
const dashboardSearchDetailSchema = z.object({
  status: z.string(),
  jobs: z.array(
    z.object({
      id: z.string(),
      data: z.object({
        title: z.string(),
        company: z.string(),
        location: z.string(),
        sourceUrl: z.string(),
        match: z.object({ score: z.number(), matchedSkills: z.array(z.string()) }).nullable(),
      }),
    }),
  ),
});
export type DashboardSearchDetail = z.infer<typeof dashboardSearchDetailSchema>;
export const parseDashboardSearchDetail = parser(dashboardSearchDetailSchema);

export const parseSearchCreated = parser(z.object({ runId: z.string() }));
export const parseJobFeedback = parser(z.object({ reason: jobFeedbackReasonSchema }));

/* ----------------------------------- Leads ---------------------------------- */

const leadStatusSchema = z.enum([
  'saved',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
  'archived',
]);
const applicationEvidenceSchema = z.object({
  method: z.string(),
  appliedAt: z.string(),
  confirmation: z.enum(['unknown', 'received', 'not_received']),
  source: z.string(),
  confidence: z.enum(['unknown', 'low', 'medium', 'high']),
});
const leadSchema = z.object({
  id: z.string(),
  data: collectedJobSchema,
  notes: z.string(),
  status: leadStatusSchema,
  applicationEvidence: applicationEvidenceSchema.nullable(),
  employerAcknowledgement: z
    .object({ receivedAt: z.string(), source: z.string(), reference: z.string().nullable() })
    .nullable(),
  tags: z.array(z.string()),
  livenessStatus: z.enum(['unknown', 'live', 'stale']),
  livenessCheckedAt: z.string().nullable(),
  revision: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** A saved lead as the API returns it (dates as ISO strings). */
export type Lead = z.infer<typeof leadSchema>;
export const parseLead = parser(leadSchema);
export const parseLeadByJob = parser(z.object({ lead: leadSchema.nullable() }));
export const parseLeadPage = parser(
  z.object({ items: z.array(leadSchema), nextCursor: z.string().nullable() }),
);

const leadHistorySchema = z.object({
  revision: z.number(),
  previousStatus: leadStatusSchema.nullable(),
  status: leadStatusSchema,
  notesChanged: z.boolean(),
  applicationEvidenceChanged: z.boolean(),
  applicationEvidence: applicationEvidenceSchema.nullable(),
  tagsChanged: z.boolean(),
  tags: z.array(z.string()),
  createdAt: z.string(),
});
/** One revision of a lead. */
export type LeadHistory = z.infer<typeof leadHistorySchema>;
export const parseLeadHistoryPage = parser(
  z.object({ items: z.array(leadHistorySchema), nextCursor: z.number().nullable() }),
);

/** The part of a lead page the dashboard counts and activity feed read. */
const dashboardLeadPageSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      data: z.object({ title: z.string(), company: z.string() }),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});
export type DashboardLeadPage = z.infer<typeof dashboardLeadPageSchema>;
export const parseDashboardLeadPage = parser(dashboardLeadPageSchema);

/* -------------------------------- Interviews -------------------------------- */

const interviewRoundSchema = z.object({
  id: z.string(),
  leadId: z.string(),
  title: z.string(),
  startsAt: z.string(),
  timeZone: z.string(),
  format: z.enum(['video', 'phone', 'onsite', 'other']),
  status: z.enum(['scheduled', 'completed', 'cancelled']),
  contacts: z.array(
    z.object({ name: z.string(), role: z.string().nullable(), email: z.string().nullable() }),
  ),
  checklist: z.array(z.object({ id: z.string(), label: z.string(), completed: z.boolean() })),
  notes: z.string(),
  reminderAt: z.string().nullable(),
  resumeUploadIds: z.array(z.string()),
  revision: z.number(),
});
/** An interview round as the API returns it. */
export type InterviewRound = z.infer<typeof interviewRoundSchema>;
export const parseInterviewRound = parser(interviewRoundSchema);
export const parseInterviewRounds = parser(z.object({ items: z.array(interviewRoundSchema) }));
