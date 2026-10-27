/**
 * Drizzle table definitions for the application database. `owner_id` columns reference `users`,
 * often through composite foreign keys, so rows cannot cross users. Check constraints repeat the
 * validation in `leads.ts`, `profile.ts` and the other repositories; SQL migrations live in `migrations/`.
 */

import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  boolean,
  uniqueIndex,
  index,
  check,
  bigserial,
  foreignKey,
  primaryKey,
} from 'drizzle-orm/pg-core';
import type { Command, CreateSearch } from './commands.js';
import type { CollectedJob, SourceOutcome } from './jobs.js';
import type { WritableProfile, MatchingProfile } from './profile.js';
import type { z } from 'zod';
import type { parsedResumeSchema } from './resume-parser.js';
import type { ApplicationEvidence } from './leads.js';

/** Accounts. `passwordHash` is null for accounts created through email one-time codes. */
export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').unique(),
  passwordHash: text('password_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  ageScreenPassed: boolean('age_screen_passed'),
});

/** Append-only record of accepted terms, privacy notice and marketing consent, ordered by `sequence`. */
export const accountAcceptances = pgTable(
  'account_acceptances',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    document: text('document').notNull(),
    version: text('version').notNull(),
    accepted: boolean('accepted').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).defaultNow().notNull(),
    sequence: bigserial('sequence', { mode: 'bigint' }).notNull().unique(),
  },
  (table) => [
    check(
      'account_acceptance_document_valid',
      sql`${table.document} IN ('terms', 'privacy_notice', 'marketing')`,
    ),
    check(
      'account_acceptance_version_nonempty',
      sql`length(btrim(${table.version})) BETWEEN 1 AND 128`,
    ),
    check(
      'account_acceptance_required_grant',
      sql`${table.document} = 'marketing' OR ${table.accepted}`,
    ),
    index('account_acceptance_owner_document_sequence').on(
      table.ownerId,
      table.document,
      table.sequence,
    ),
  ],
);

/** Login sessions. `tokenHash` is the digest of the current access token; the raw token is never stored. */
export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    id: uuid('id').notNull().unique(),
    accessExpiresAt: timestamp('access_expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    deviceLabel: text('device_label'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    // User and expiry filters drive the account-session list and bounded
    // cleanup; token_hash is the current access-token digest.
    index('session_owner').on(table.ownerId),
    index('session_family_expiry').on(table.expiresAt),
  ],
);

/** Refresh-token digests per session. A consumed row is kept so replaying it can be detected. */
export const sessionRefreshTokens = pgTable(
  'session_refresh_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check('session_refresh_hash_hex', sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`),
    index('session_refresh_family').on(table.sessionId),
    index('session_refresh_expiry').on(table.expiresAt),
  ],
);

/** One active one-time-code challenge per email hash (unique index); attempts are capped at five by a check constraint. */
export const emailOtpChallenges = pgTable(
  'email_otp_challenges',
  {
    id: uuid('id').primaryKey(),
    emailHash: text('email_hash').notNull(),
    digest: text('digest').notNull(),
    attempts: integer('attempts').notNull().default(0),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    intent: text('intent').notNull().default('sign-in'),
    termsVersion: text('terms_version'),
    privacyVersion: text('privacy_version'),
    marketingOptIn: boolean('marketing_opt_in').notNull().default(false),
    marketingVersion: text('marketing_version'),
    ageScreenPassed: boolean('age_screen_passed'),
  },
  (table) => [
    uniqueIndex('email_otp_email_hash').on(table.emailHash),
    check('email_otp_email_hash_hex', sql`${table.emailHash} ~ '^[a-f0-9]{64}$'`),
    check('email_otp_digest_hex', sql`${table.digest} ~ '^[a-f0-9]{64}$'`),
    check('email_otp_attempts_bounded', sql`${table.attempts} BETWEEN 0 AND 5`),
    check('email_otp_intent_valid', sql`${table.intent} IN ('sign-in', 'sign-up')`),
    check(
      'email_otp_signup_acceptance_complete',
      sql`(${table.intent} = 'sign-in' AND ${table.termsVersion} IS NULL AND ${table.privacyVersion} IS NULL AND NOT ${table.marketingOptIn}) OR (${table.intent} = 'sign-up' AND ${table.termsVersion} IS NOT NULL AND ${table.privacyVersion} IS NOT NULL)`,
    ),
    check(
      'email_otp_marketing_version_required',
      sql`NOT ${table.marketingOptIn} OR ${table.marketingVersion} IS NOT NULL`,
    ),
    check('email_otp_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    index('email_otp_expiration').on(table.expiresAt),
  ],
);

/** At most one pending email change per user, with a digest and attempt count for each of the two addresses. */
export const emailChangeRequests = pgTable(
  'email_change_requests',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    currentEmailHash: text('current_email_hash').notNull(),
    newEmail: text('new_email').notNull(),
    currentChallengeId: uuid('current_challenge_id').notNull().unique(),
    currentDigest: text('current_digest').notNull(),
    currentAttempts: integer('current_attempts').notNull().default(0),
    currentVerifiedAt: timestamp('current_verified_at', { withTimezone: true }),
    newChallengeId: uuid('new_challenge_id').notNull().unique(),
    newDigest: text('new_digest').notNull(),
    newAttempts: integer('new_attempts').notNull().default(0),
    newVerifiedAt: timestamp('new_verified_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('email_change_owner').on(table.ownerId),
    check('email_change_current_hash_hex', sql`${table.currentEmailHash} ~ '^[a-f0-9]{64}$'`),
    check('email_change_current_digest_hex', sql`${table.currentDigest} ~ '^[a-f0-9]{64}$'`),
    check('email_change_new_digest_hex', sql`${table.newDigest} ~ '^[a-f0-9]{64}$'`),
    check('email_change_current_attempts_bounded', sql`${table.currentAttempts} BETWEEN 0 AND 5`),
    check('email_change_new_attempts_bounded', sql`${table.newAttempts} BETWEEN 0 AND 5`),
    check('email_change_address_present', sql`length(btrim(${table.newEmail})) BETWEEN 3 AND 254`),
    check('email_change_expiry_after_creation', sql`${table.expiresAt} > ${table.createdAt}`),
    index('email_change_expiration').on(table.expiresAt),
  ],
);

/** Candidate profile per user. `data` is revision-guarded; `scheduledDiscoveryEnabled` is deliberately outside that revision. */
export const profiles = pgTable(
  'candidate_profiles',
  {
    ownerId: uuid('owner_id')
      .primaryKey()
      .references(() => users.id),
    data: jsonb('data').$type<WritableProfile>().notNull(),
    revision: integer('revision').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    // Unattended discovery is a separate trust decision from the user's
    // candidate and preference data, so it is its own column rather than part of
    // the revision-guarded `data` blob. Toggling it is not editing the profile
    // and must not collide with a profile save's optimistic-concurrency check.
    // Defaults to false, like every other setting that acts on the user's behalf
    // while they are not present.
    scheduledDiscoveryEnabled: boolean('scheduled_discovery_enabled').notNull().default(false),
  },
  (table) => [check('profile_revision_positive', sql`${table.revision} > 0`)],
);

/** Search runs. `request` and `matchingProfile` are snapshots taken at creation; (owner, idempotency key) is unique. */
export const searches = pgTable(
  'search_runs',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    request: jsonb('request').$type<CreateSearch>().notNull(),
    requestHash: text('request_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status')
      .$type<'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'>()
      .notNull()
      .default('queued'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    matchingProfile: jsonb('matching_profile').$type<MatchingProfile>(),
    profileRevision: integer('profile_revision'),
    sourceOutcomes: jsonb('source_outcomes').$type<SourceOutcome[]>(),
  },
  (table) => [
    uniqueIndex('search_owner_key').on(table.ownerId, table.idempotencyKey),
    // Required, not an optimisation: a composite foreign key can only reference a
    // unique set of columns, so without this Postgres rejects the
    // (owner_id, run_id) references on run_events and search_jobs (error 42830).
    // `saved_leads` and `resume_uploads` carry the same index for the same reason.
    uniqueIndex('search_owner_id').on(table.ownerId, table.id),
    index('search_owner_created').on(table.ownerId, table.createdAt),
    check(
      'search_status_valid',
      sql`${table.status} IN ('queued', 'running', 'completed', 'partial', 'failed', 'cancelled')`,
    ),
    check(
      'search_outcomes_bounded',
      sql`${table.sourceOutcomes} IS NULL OR (jsonb_typeof(${table.sourceOutcomes}) = 'array'
        AND jsonb_array_length(${table.sourceOutcomes}) BETWEEN 1 AND 5
        AND octet_length(${table.sourceOutcomes}::text) <= 2048)`,
    ),
    check(
      'search_partial_has_outcomes',
      sql`${table.status} <> 'partial' OR ${table.sourceOutcomes} IS NOT NULL`,
    ),
  ],
);

/** Transactional outbox: commands written in the same transaction as the state change, then published to the queue. */
export const outbox = pgTable(
  'outbox_events',
  {
    id: uuid('id').primaryKey(),
    command: jsonb('command').$type<Command>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  // The publisher polls continuously against a table that only grows, matching
  // unpublished rows and then stale published ones, ordered by created_at.
  (table) => [index('outbox_published_created').on(table.publishedAt, table.createdAt)],
);

/** Lease and fence state per command. The fence increases on each takeover and guards every settle. */
export const executions = pgTable(
  'command_executions',
  {
    id: uuid('id')
      .primaryKey()
      .references(() => outbox.id),
    status: text('status').notNull(),
    fence: integer('fence').notNull(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull(),
  },
  // Reclaiming expired leases and reporting backlog both scan status/lease_until.
  (table) => [index('execution_status_lease').on(table.status, table.leaseUntil)],
);

/** Per-run progress events, ordered by `sequence`. */
export const events = pgTable(
  'run_events',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    type: text('type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    sequence: bigserial('sequence', { mode: 'bigint' }).notNull(),
  },
  (table) => [
    // One composite reference rather than two separate ones. Separate references
    // to search_runs.id and users.id would let the database hold an event whose
    // owner_id is not the owner of its run, with only the application preventing
    // it. As a composite key such a row cannot exist, as with lead_history and
    // resume_results. The users reference still holds transitively through
    // search_runs.owner_id.
    foreignKey({
      columns: [table.ownerId, table.runId],
      foreignColumns: [searches.ownerId, searches.id],
    }),
    index('event_owner_run_sequence').on(table.ownerId, table.runId, table.sequence),
  ],
);

/** Jobs found by a run, unique per run and fingerprint. */
export const jobs = pgTable(
  'search_jobs',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id').notNull(),
    ownerId: uuid('owner_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    data: jsonb('data').$type<CollectedJob>().notNull(),
  },
  (table) => [
    // Same reasoning as run_events above: a job whose owner_id differs from its
    // run's owner_id is a foreign-key violation rather than a row the application
    // is trusted never to write.
    foreignKey({
      columns: [table.ownerId, table.runId],
      foreignColumns: [searches.ownerId, searches.id],
    }),
    uniqueIndex('run_job_fingerprint').on(table.runId, table.fingerprint),
    uniqueIndex('job_owner_id').on(table.ownerId, table.id),
    index('job_owner_run').on(table.ownerId, table.runId),
  ],
);

/** One feedback reason per user and job; deleted with the job. */
export const jobFeedback = pgTable(
  'job_feedback',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    jobId: uuid('job_id').notNull(),
    reason: text('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.jobId],
      foreignColumns: [jobs.ownerId, jobs.id],
    }).onDelete('cascade'),
    uniqueIndex('job_feedback_owner_job').on(table.ownerId, table.jobId),
    index('job_feedback_created').on(table.createdAt),
    check(
      'job_feedback_reason_valid',
      sql`${table.reason} IN ('irrelevant', 'duplicate', 'incorrect', 'unavailable', 'suspicious')`,
    ),
  ],
);

/** Saved leads: a user's pipeline entries, unique per fingerprint, with revision, tags and application evidence. */
export const leads = pgTable(
  'saved_leads',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    fingerprint: text('fingerprint').notNull(),
    data: jsonb('data').$type<CollectedJob>().notNull(),
    notes: text('notes').notNull().default(''),
    // A job search is a pipeline, not a bookmark list.
    status: text('status')
      .$type<
        'saved' | 'applied' | 'interviewing' | 'offer' | 'rejected' | 'withdrawn' | 'archived'
      >()
      .notNull()
      .default('saved'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    // Stamped on every status change so "nothing has moved in three weeks" is a
    // question the data can answer.
    statusChangedAt: timestamp('status_changed_at', { withTimezone: true }).defaultNow().notNull(),
    // A fact the system checked (did applyUrl respond last time?), never inferred
    // from age. 'unknown' until a real HTTP check has run, and again after an
    // ambiguous check (timeout, 5xx, anything other than a clear 200 or a clear
    // 404/410) rather than asserting either way.
    livenessStatus: text('liveness_status')
      .$type<'unknown' | 'live' | 'stale'>()
      .notNull()
      .default('unknown'),
    livenessCheckedAt: timestamp('liveness_checked_at', { withTimezone: true }),
    applicationEvidence: jsonb('application_evidence').$type<ApplicationEvidence | null>(),
    // Candidate-owned organization metadata, separate from the source posting.
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
  },
  (table) => [
    uniqueIndex('lead_owner_fingerprint').on(table.ownerId, table.fingerprint),
    uniqueIndex('lead_owner_id').on(table.ownerId, table.id),
    index('lead_owner_status_created').on(table.ownerId, table.status, table.createdAt, table.id),
    // The liveness checker's own work queue: leads never checked, or checked
    // longest ago, first - independent of status/created ordering.
    index('lead_liveness_checked').on(table.livenessCheckedAt),
    check('lead_revision_positive', sql`${table.revision} > 0`),
    check(
      'lead_status_valid',
      sql`${table.status} IN ('saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn', 'archived')`,
    ),
    check(
      'lead_application_evidence_valid',
      sql`${table.applicationEvidence} IS NULL OR (
        jsonb_typeof(${table.applicationEvidence}) = 'object'
        AND ${table.applicationEvidence} ?& ARRAY['method', 'appliedAt', 'confirmation', 'source', 'confidence']
        AND (${table.applicationEvidence} - ARRAY['method', 'appliedAt', 'confirmation', 'source', 'confidence']::text[]) = '{}'::jsonb
        AND jsonb_typeof(${table.applicationEvidence}->'method') = 'string'
        AND length(btrim(${table.applicationEvidence}->>'method')) BETWEEN 1 AND 120
        AND jsonb_typeof(${table.applicationEvidence}->'appliedAt') = 'string'
        AND jsonb_typeof(${table.applicationEvidence}->'confirmation') = 'string'
        AND ${table.applicationEvidence}->>'confirmation' IN ('unknown', 'received', 'not_received')
        AND jsonb_typeof(${table.applicationEvidence}->'source') = 'string'
        AND length(btrim(${table.applicationEvidence}->>'source')) <= 160
        AND jsonb_typeof(${table.applicationEvidence}->'confidence') = 'string'
        AND ${table.applicationEvidence}->>'confidence' IN ('unknown', 'low', 'medium', 'high')
      )`,
    ),
    check(
      'lead_liveness_status_valid',
      sql`${table.livenessStatus} IN ('unknown', 'live', 'stale')`,
    ),
    check('lead_notes_bounded', sql`length(${table.notes}) <= 10000`),
    check('lead_tags_valid', sql`public.careerscope_valid_lead_tags(${table.tags})`),
  ],
);

// Employer/ATS acknowledgements are authoritative external evidence and must
// never be folded into the candidate-entered applicationEvidence claim.
export const employerApplicationAcknowledgements = pgTable(
  'employer_application_acknowledgements',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    leadId: uuid('lead_id').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    source: text('source').notNull(),
    reference: text('reference'),
  },
  (table) => [
    foreignKey({
      name: 'employer_ack_owner_lead_fk',
      columns: [table.ownerId, table.leadId],
      foreignColumns: [leads.ownerId, leads.id],
    }).onDelete('cascade'),
    index('employer_ack_owner_lead_received').on(table.ownerId, table.leadId, table.receivedAt),
    check('employer_ack_source_bounded', sql`length(btrim(${table.source})) BETWEEN 1 AND 160`),
    check(
      'employer_ack_reference_bounded',
      sql`${table.reference} IS NULL OR length(${table.reference}) <= 240`,
    ),
  ],
);

/** One row per lead revision, so status, notes, evidence and tag changes can be listed. */
export const leadHistory = pgTable(
  'lead_history',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    leadId: uuid('lead_id').notNull(),
    revision: integer('revision').notNull(),
    status: text('status')
      .$type<
        'saved' | 'applied' | 'interviewing' | 'offer' | 'rejected' | 'withdrawn' | 'archived'
      >()
      .notNull(),
    notesChanged: integer('notes_changed').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    previousStatus: text('previous_status').$type<
      'saved' | 'applied' | 'interviewing' | 'offer' | 'rejected' | 'withdrawn' | 'archived' | null
    >(),
    applicationEvidenceChanged: boolean('application_evidence_changed').notNull().default(false),
    applicationEvidence: jsonb('application_evidence').$type<ApplicationEvidence | null>(),
    tagsChanged: boolean('tags_changed').notNull().default(false),
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.leadId],
      foreignColumns: [leads.ownerId, leads.id],
    }),
    uniqueIndex('lead_history_revision').on(table.ownerId, table.leadId, table.revision),
    check(
      'lead_history_status_valid',
      sql`${table.status} IN ('saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn', 'archived')`,
    ),
    check(
      'lead_history_previous_status_valid',
      sql`${table.previousStatus} IS NULL OR ${table.previousStatus} IN ('saved', 'applied', 'interviewing', 'offer', 'rejected', 'withdrawn', 'archived')`,
    ),
    check('lead_history_notes_changed_valid', sql`${table.notesChanged} IN (0, 1)`),
    check('lead_history_tags_valid', sql`public.careerscope_valid_lead_tags(${table.tags})`),
    check(
      'lead_history_application_evidence_valid',
      sql`${table.applicationEvidence} IS NULL OR (
        jsonb_typeof(${table.applicationEvidence}) = 'object'
        AND ${table.applicationEvidence} ?& ARRAY['method', 'appliedAt', 'confirmation', 'source', 'confidence']
        AND (${table.applicationEvidence} - ARRAY['method', 'appliedAt', 'confirmation', 'source', 'confidence']::text[]) = '{}'::jsonb
        AND jsonb_typeof(${table.applicationEvidence}->'method') = 'string'
        AND length(btrim(${table.applicationEvidence}->>'method')) BETWEEN 1 AND 120
        AND jsonb_typeof(${table.applicationEvidence}->'appliedAt') = 'string'
        AND jsonb_typeof(${table.applicationEvidence}->'confirmation') = 'string'
        AND ${table.applicationEvidence}->>'confirmation' IN ('unknown', 'received', 'not_received')
        AND jsonb_typeof(${table.applicationEvidence}->'source') = 'string'
        AND length(btrim(${table.applicationEvidence}->>'source')) <= 160
        AND jsonb_typeof(${table.applicationEvidence}->'confidence') = 'string'
        AND ${table.applicationEvidence}->>'confidence' IN ('unknown', 'low', 'medium', 'high')
      )`,
    ),
  ],
);

/** Shape of an entry in `interview_rounds.contacts`. */
export type InterviewContact = {
  name: string;
  role: string | null;
  email: string | null;
};

/** Shape of an entry in `interview_rounds.checklist`. */
export type InterviewChecklistItem = {
  id: string;
  label: string;
  completed: boolean;
};

/** Interview rounds on a lead. A check constraint requires any reminder to be before the start time. */
export const interviewRounds = pgTable(
  'interview_rounds',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    leadId: uuid('lead_id').notNull(),
    title: text('title').notNull(),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    timeZone: text('time_zone').notNull(),
    format: text('format').$type<'video' | 'phone' | 'onsite' | 'other'>().notNull(),
    status: text('status').$type<'scheduled' | 'completed' | 'cancelled'>().notNull(),
    contacts: jsonb('contacts').$type<InterviewContact[]>().notNull().default([]),
    checklist: jsonb('checklist').$type<InterviewChecklistItem[]>().notNull().default([]),
    notes: text('notes').notNull().default(''),
    reminderAt: timestamp('reminder_at', { withTimezone: true }),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.leadId],
      foreignColumns: [leads.ownerId, leads.id],
    }),
    uniqueIndex('interview_round_owner_id').on(table.ownerId, table.id),
    index('interview_round_owner_lead_start').on(table.ownerId, table.leadId, table.startsAt),
    index('interview_round_due_reminder')
      .on(table.reminderAt, table.id)
      .where(sql`${table.status} = 'scheduled' AND ${table.reminderAt} IS NOT NULL`),
    check('interview_round_title_bounded', sql`length(btrim(${table.title})) BETWEEN 1 AND 120`),
    check('interview_round_timezone_bounded', sql`length(${table.timeZone}) BETWEEN 1 AND 128`),
    check(
      'interview_round_format_valid',
      sql`${table.format} IN ('video', 'phone', 'onsite', 'other')`,
    ),
    check(
      'interview_round_status_valid',
      sql`${table.status} IN ('scheduled', 'completed', 'cancelled')`,
    ),
    check('interview_round_contacts_array', sql`jsonb_typeof(${table.contacts}) = 'array'`),
    check('interview_round_checklist_array', sql`jsonb_typeof(${table.checklist}) = 'array'`),
    check('interview_round_notes_bounded', sql`length(${table.notes}) <= 10000`),
    check('interview_round_revision_positive', sql`${table.revision} > 0`),
    check(
      'interview_round_reminder_before_start',
      sql`${table.reminderAt} IS NULL OR ${table.reminderAt} < ${table.startsAt}`,
    ),
  ],
);

/** Resume uploads. The state check ties `queued` to an object version and command, and earlier states to neither. */
export const resumeUploads = pgTable(
  'resume_uploads',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    idempotencyKey: text('idempotency_key').notNull(),
    bucket: text('bucket').notNull(),
    sha256: text('sha256').notNull(),
    bytes: integer('bytes').notNull(),
    contentType: text('content_type').notNull(),
    objectVersion: text('object_version'),
    commandId: uuid('command_id').references(() => outbox.id),
    status: text('status')
      .$type<'uploading' | 'queued' | 'cancelling' | 'cancelled'>()
      .notNull()
      .default('uploading'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('resume_upload_owner_key').on(table.ownerId, table.idempotencyKey),
    uniqueIndex('resume_upload_command').on(table.commandId),
    uniqueIndex('resume_upload_owner_id').on(table.ownerId, table.id),
    index('resume_upload_owner_created').on(table.ownerId, table.createdAt, table.id),
    check('resume_upload_key_valid', sql`${table.idempotencyKey} ~ '^[a-zA-Z0-9_-]{8,128}$'`),
    check('resume_upload_bucket_valid', sql`${table.bucket} ~ '^[a-z][a-z0-9-]{1,61}[a-z0-9]$'`),
    check('resume_upload_sha_valid', sql`${table.sha256} ~ '^[a-f0-9]{64}$'`),
    check('resume_upload_bytes_valid', sql`${table.bytes} BETWEEN 1 AND 5242880`),
    check(
      'resume_upload_type_valid',
      sql`${table.contentType} IN ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')`,
    ),
    check(
      'resume_upload_state_valid',
      sql`
      (${table.status} IN ('uploading', 'cancelling', 'cancelled') AND ${table.objectVersion} IS NULL AND ${table.commandId} IS NULL)
      OR (${table.status} = 'queued' AND ${table.objectVersion} IS NOT NULL
        AND length(${table.objectVersion}) BETWEEN 1 AND 1024 AND ${table.objectVersion} <> 'null'
        AND ${table.commandId} IS NOT NULL)`,
    ),
  ],
);

export const interviewRoundDocuments = pgTable(
  'interview_round_documents',
  {
    ownerId: uuid('owner_id').notNull(),
    roundId: uuid('round_id').notNull(),
    uploadId: uuid('upload_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.roundId],
      foreignColumns: [interviewRounds.ownerId, interviewRounds.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.ownerId, table.uploadId],
      foreignColumns: [resumeUploads.ownerId, resumeUploads.id],
    }).onDelete('cascade'),
    uniqueIndex('interview_round_document_unique').on(table.ownerId, table.roundId, table.uploadId),
    index('interview_document_owner_upload').on(table.ownerId, table.uploadId),
  ],
);

// In-app interview reminders contain no copied interview title, contact, or
// note. The owning round remains the source of truth; this row is only the
// durable, idempotent notification event and its read state.
export const inAppNotifications = pgTable(
  'in_app_notifications',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    roundId: uuid('round_id').notNull(),
    reminderAt: timestamp('reminder_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    readAt: timestamp('read_at', { withTimezone: true }),
    retiredAt: timestamp('retired_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.roundId],
      foreignColumns: [interviewRounds.ownerId, interviewRounds.id],
    }).onDelete('cascade'),
    uniqueIndex('in_app_notification_reminder_unique').on(
      table.ownerId,
      table.roundId,
      table.reminderAt,
    ),
    index('in_app_notification_owner_created').on(table.ownerId, table.createdAt, table.id),
  ],
);

// Notification channel/type preferences are separate from the candidate
// profile so they can evolve without changing matching inputs or profile
// revision semantics. A missing row means the launch default: enabled.
export const notificationPreferences = pgTable('notification_preferences', {
  ownerId: uuid('owner_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  interviewRemindersInAppEnabled: boolean('interview_reminders_in_app_enabled')
    .notNull()
    .default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Parse outcome per upload: either parsed content or a rejection code, enforced by a check constraint. */
export const resumeResults = pgTable(
  'resume_results',
  {
    uploadId: uuid('upload_id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    commandId: uuid('command_id')
      .notNull()
      .references(() => outbox.id),
    status: text('status').$type<'parsed' | 'rejected'>().notNull(),
    parsed: jsonb('parsed').$type<z.infer<typeof parsedResumeSchema>>(),
    errorCode: text('error_code').$type<'invalid_document' | 'processing_failed'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.uploadId],
      foreignColumns: [resumeUploads.ownerId, resumeUploads.id],
    }),
    uniqueIndex('resume_result_command').on(table.commandId),
    check(
      'resume_result_state_valid',
      sql`
      (${table.status} = 'parsed' AND ${table.parsed} IS NOT NULL AND ${table.errorCode} IS NULL
        AND jsonb_typeof(${table.parsed}) = 'object' AND octet_length(${table.parsed}::text) <= 1048576)
      OR (${table.status} = 'rejected' AND ${table.parsed} IS NULL
        AND ${table.errorCode} IS NOT NULL AND ${table.errorCode} IN ('invalid_document', 'processing_failed'))`,
    ),
  ],
);

// What a job board will not tell you, because it is paid by the employer.
//
// Every run records that it saw a posting. Over time that turns into evidence:
// how long a role has actually been open, how many times you have seen it, and
// whether the company quietly re-posted it to look fresh.
//
// Only facts are stored. "Ghost job" is an interpretation and is never written
// here -- the API reports what was observed and lets the reader conclude.
export const jobSightings = pgTable(
  'job_sightings',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    fingerprint: text('fingerprint').notNull(),
    // Denormalised so the listing does not have to open every jsonb document.
    title: text('title').notNull(),
    company: text('company').notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
    // Distinct searches this posting has turned up in.
    sightings: integer('sightings').notNull().default(1),
    // The date the posting itself claims. Nullable: not every source gives one.
    firstPostedAt: timestamp('first_posted_at', { withTimezone: true }),
    lastPostedAt: timestamp('last_posted_at', { withTimezone: true }),
    // Incremented when the same posting comes back with a newer claimed date,
    // which is a company refreshing a stale listing rather than a new role.
    repostCount: integer('repost_count').notNull().default(0),
    lastRunId: uuid('last_run_id'),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.fingerprint] }),
    index('sighting_owner_last_seen').on(table.ownerId, table.lastSeenAt),
    index('sighting_owner_company').on(table.ownerId, table.company),
    check('sighting_count_positive', sql`${table.sightings} > 0`),
    check('sighting_reposts_valid', sql`${table.repostCount} >= 0`),
  ],
);

// Transactional notification outbox. Rows are written and drained with raw SQL
// in notification-delivery.ts; the definitions here keep the Drizzle snapshot
// identical to the database.
export const notificationEvents = pgTable(
  'notification_events',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    kind: text('kind').notNull(),
    template: text('template').notNull(),
    locale: text('locale').notNull(),
    payload: jsonb('payload')
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      name: 'notification_events_owner_id_fkey',
      columns: [table.ownerId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    check(
      'notification_events_kind_check',
      sql`${table.kind} IN ('security', 'application', 'interview', 'marketing')`,
    ),
    check('notification_events_locale_check', sql`${table.locale} IN ('en', 'te', 'hi')`),
    check(
      'notification_events_payload_check',
      sql`jsonb_typeof(${table.payload}) = 'object' AND octet_length(${table.payload}::text) <= 4096`,
    ),
  ],
);

/** One row per event and channel, claimed and retried by `NotificationOutbox`. Attempts are capped at five. */
export const notificationDeliveries = pgTable(
  'notification_deliveries',
  {
    eventId: uuid('event_id').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    availableAt: timestamp('available_at', { withTimezone: true }).defaultNow().notNull(),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    lastError: text('last_error'),
  },
  (table) => [
    primaryKey({ name: 'notification_deliveries_pkey', columns: [table.eventId, table.channel] }),
    foreignKey({
      name: 'notification_deliveries_event_id_fkey',
      columns: [table.eventId],
      foreignColumns: [notificationEvents.id],
    }).onDelete('cascade'),
    index('notification_delivery_pending')
      .on(table.availableAt, table.eventId)
      .where(sql`${table.status} = 'pending'`),
    check(
      'notification_deliveries_channel_check',
      sql`${table.channel} IN ('in_app', 'email', 'web_push')`,
    ),
    check(
      'notification_deliveries_status_check',
      sql`${table.status} IN ('pending', 'sending', 'delivered', 'dead_letter')`,
    ),
    check('notification_deliveries_attempts_check', sql`${table.attempts} BETWEEN 0 AND 5`),
  ],
);

/** Deliveries that exhausted their attempts, kept for inspection. */
export const notificationDeadLetters = pgTable(
  'notification_dead_letters',
  {
    eventId: uuid('event_id').notNull(),
    channel: text('channel').notNull(),
    attempts: integer('attempts').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    primaryKey({ name: 'notification_dead_letters_pkey', columns: [table.eventId, table.channel] }),
    foreignKey({
      name: 'notification_dead_letters_event_id_channel_fkey',
      columns: [table.eventId, table.channel],
      foreignColumns: [notificationDeliveries.eventId, notificationDeliveries.channel],
    }).onDelete('cascade'),
    check('notification_dead_letters_attempts_check', sql`${table.attempts} BETWEEN 1 AND 5`),
  ],
);
