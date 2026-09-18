import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  uniqueIndex,
  index,
  check,
  bigserial,
  foreignKey,
} from 'drizzle-orm/pg-core';
import type { Command, CreateSearch } from './commands.js';
import type { CollectedJob, SourceOutcome } from './jobs.js';
import type { WritableProfile, MatchingProfile } from './profile.js';
import type { z } from 'zod';
import type { parsedResumeSchema } from './resume-parser.js';

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable(
  'sessions',
  {
    tokenHash: text('token_hash').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  // Revoking every other session and removing an owner both filter on owner_id.
  (table) => [index('session_owner').on(table.ownerId)],
);

export const profiles = pgTable(
  'candidate_profiles',
  {
    ownerId: uuid('owner_id')
      .primaryKey()
      .references(() => users.id),
    data: jsonb('data').$type<WritableProfile>().notNull(),
    revision: integer('revision').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [check('profile_revision_positive', sql`${table.revision} > 0`)],
);

export const searches = pgTable(
  'search_runs',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    request: jsonb('request').$type<CreateSearch>().notNull(),
    matchingProfile: jsonb('matching_profile').$type<MatchingProfile>(),
    profileRevision: integer('profile_revision'),
    sourceOutcomes: jsonb('source_outcomes').$type<SourceOutcome[]>(),
    requestHash: text('request_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status')
      .$type<'queued' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled'>()
      .notNull()
      .default('queued'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('search_owner_key').on(table.ownerId, table.idempotencyKey),
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

export const events = pgTable(
  'run_events',
  {
    id: uuid('id').primaryKey(),
    sequence: bigserial('sequence', { mode: 'bigint' }).notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => searches.id),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    type: text('type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('event_owner_run_sequence').on(table.ownerId, table.runId, table.sequence)],
);

export const jobs = pgTable(
  'search_jobs',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => searches.id),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    fingerprint: text('fingerprint').notNull(),
    data: jsonb('data').$type<CollectedJob>().notNull(),
  },
  (table) => [
    uniqueIndex('run_job_fingerprint').on(table.runId, table.fingerprint),
    index('job_owner_run').on(table.ownerId, table.runId),
  ],
);

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
    status: text('status').$type<'saved' | 'archived'>().notNull().default('saved'),
    revision: integer('revision').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('lead_owner_fingerprint').on(table.ownerId, table.fingerprint),
    uniqueIndex('lead_owner_id').on(table.ownerId, table.id),
    index('lead_owner_status_created').on(table.ownerId, table.status, table.createdAt, table.id),
    check('lead_revision_positive', sql`${table.revision} > 0`),
    check('lead_status_valid', sql`${table.status} IN ('saved', 'archived')`),
    check('lead_notes_bounded', sql`length(${table.notes}) <= 10000`),
  ],
);

export const leadHistory = pgTable(
  'lead_history',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id').notNull(),
    leadId: uuid('lead_id').notNull(),
    revision: integer('revision').notNull(),
    status: text('status').$type<'saved' | 'archived'>().notNull(),
    notesChanged: integer('notes_changed').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId, table.leadId],
      foreignColumns: [leads.ownerId, leads.id],
    }),
    uniqueIndex('lead_history_revision').on(table.ownerId, table.leadId, table.revision),
    check('lead_history_status_valid', sql`${table.status} IN ('saved', 'archived')`),
    check('lead_history_notes_changed_valid', sql`${table.notesChanged} IN (0, 1)`),
  ],
);

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
