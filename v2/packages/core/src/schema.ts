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
import type { CollectedJob } from './jobs.js';
import type { WritableProfile, MatchingProfile } from './profile.js';

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const sessions = pgTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.id),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

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
    requestHash: text('request_hash').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    status: text('status')
      .$type<'queued' | 'running' | 'completed' | 'failed' | 'cancelled'>()
      .notNull()
      .default('queued'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('search_owner_key').on(table.ownerId, table.idempotencyKey),
    index('search_owner_created').on(table.ownerId, table.createdAt),
    check(
      'search_status_valid',
      sql`${table.status} IN ('queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
  ],
);

export const outbox = pgTable('outbox_events', {
  id: uuid('id').primaryKey(),
  command: jsonb('command').$type<Command>().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
});

export const executions = pgTable('command_executions', {
  id: uuid('id')
    .primaryKey()
    .references(() => outbox.id),
  status: text('status').notNull(),
  fence: integer('fence').notNull(),
  leaseUntil: timestamp('lease_until', { withTimezone: true }).notNull(),
  attempts: integer('attempts').notNull(),
});

export const events = pgTable('run_events', {
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
});

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
