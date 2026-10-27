/**
 * Interview rounds attached to a saved lead: validation and persistence with revision guarding.
 * Linked documents are parsed resumes from `resumes.ts`; reminders are published by `notifications.ts`.
 */

import { rollback } from './rollback.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './database.js';
import { Conflict } from './errors.js';

/** A contact at the employer. Free text, stored as JSON with the round and never used for outbound mail. */
const contactSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    role: z.string().trim().max(120).nullable(),
    email: z.string().trim().email().max(254).nullable(),
  })
  .strict();

const checklistItemSchema = z
  .object({
    id: z.string().uuid(),
    label: z.string().trim().min(1).max(200),
    completed: z.boolean(),
  })
  .strict();

/** Fields shared by create and update. `reminderAt` is checked against `startsAt` in `validateCommonInput`. */
const commonInput = z
  .object({
    title: z.string().trim().min(1).max(120),
    startsAt: z.string().datetime({ offset: true }),
    timeZone: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .refine((value) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: value });
          return true;
        } catch {
          return false;
        }
      }, 'Unknown IANA timezone'),
    format: z.enum(['video', 'phone', 'onsite', 'other']),
    status: z.enum(['scheduled', 'completed', 'cancelled']),
    contacts: z.array(contactSchema).max(10),
    checklist: z.array(checklistItemSchema).max(30),
    notes: z.string().max(10000),
    reminderAt: z.string().datetime({ offset: true }).nullable(),
    resumeUploadIds: z.array(z.string().uuid()).max(10),
  })
  .strict();

/** Cross-field checks: unique checklist ids and documents, and a reminder strictly before the interview. */
function validateCommonInput(input: z.infer<typeof commonInput>, context: z.RefinementCtx): void {
  if (new Set(input.checklist.map((item) => item.id)).size !== input.checklist.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['checklist'],
      message: 'Duplicate item',
    });
  }
  if (new Set(input.resumeUploadIds).size !== input.resumeUploadIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['resumeUploadIds'],
      message: 'Duplicate document',
    });
  }
  if (input.reminderAt && Date.parse(input.reminderAt) >= Date.parse(input.startsAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['reminderAt'],
      message: 'Reminder must be before the interview',
    });
  }
}

/** Body for creating a round. */
export const createInterviewRoundSchema = commonInput.superRefine(validateCommonInput);
/** Body for updating a round; carries the `revision` the client last saw. */
export const updateInterviewRoundSchema = commonInput
  .extend({ revision: z.number().int().min(1).max(2_147_483_646) })
  .superRefine(validateCommonInput);

export type InterviewRoundInput = z.infer<typeof createInterviewRoundSchema>;
export type InterviewRound = Omit<InterviewRoundInput, 'startsAt' | 'reminderAt'> & {
  id: string;
  leadId: string;
  startsAt: Date;
  reminderAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};

/** The round changed since the client read it; the API maps it to a 409. */
export class InterviewRevisionConflict extends Conflict {
  constructor() {
    super('Interview round changed; reload before saving', 'INTERVIEW_REVISION_CONFLICT');
  }
}

/** Postgres access for `interview_rounds`. Every query is scoped by `owner_id`, and rounds hang off the user's own saved leads. */
export class InterviewRepository {
  constructor(private readonly database: Database) {}

  /** Rounds for a lead ordered by start time, or null if the lead is not the user's. */
  async listForLead(ownerId: string, leadId: string): Promise<InterviewRound[] | null> {
    const lead = await this.database.pool.query(
      'SELECT id FROM saved_leads WHERE owner_id = $1 AND id = $2',
      [ownerId, leadId],
    );
    if (!lead.rowCount) return null;
    const result = await this.database.pool.query<InterviewRound>(
      `SELECT ${columns},
         ARRAY(SELECT document.upload_id::text FROM interview_round_documents document
               WHERE document.owner_id = round.owner_id AND document.round_id = round.id
               ORDER BY document.upload_id) AS "resumeUploadIds"
       FROM interview_rounds round
       WHERE round.owner_id = $1 AND round.lead_id = $2
       ORDER BY round.starts_at, round.id`,
      [ownerId, leadId],
    );
    return result.rows.map(hydrate);
  }

  /** Creates a round on one of the user's leads, or returns null if the lead is not theirs. Linked documents must be the user's parsed resumes. */
  async create(ownerId: string, leadId: string, value: unknown): Promise<InterviewRound | null> {
    const input = createInterviewRoundSchema.parse(value);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      // FOR SHARE keeps the lead from being deleted while the round is inserted.
      const lead = await client.query(
        'SELECT id FROM saved_leads WHERE owner_id = $1 AND id = $2 FOR SHARE',
        [ownerId, leadId],
      );
      if (!lead.rowCount) {
        await rollback(client);
        return null;
      }
      await assertOwnedDocuments(client, ownerId, input.resumeUploadIds);
      const id = randomUUID();
      await client.query(
        `INSERT INTO interview_rounds
          (id, owner_id, lead_id, title, starts_at, time_zone, format, status,
           contacts, checklist, notes, reminder_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12)`,
        [
          id,
          ownerId,
          leadId,
          input.title,
          input.startsAt,
          input.timeZone,
          input.format,
          input.status,
          JSON.stringify(input.contacts),
          JSON.stringify(input.checklist),
          input.notes,
          input.reminderAt,
        ],
      );
      await insertDocuments(client, ownerId, id, input.resumeUploadIds);
      const result = await client.query<InterviewRound>(
        `SELECT ${columns}, $3::uuid[]::text[] AS "resumeUploadIds"
         FROM interview_rounds round WHERE round.owner_id = $1 AND round.id = $2`,
        [ownerId, id, input.resumeUploadIds],
      );
      await client.query('COMMIT');
      const created = result.rows[0];
      return created ? hydrate(created) : null;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Replaces a round under a row lock. A stale `revision` throws `InterviewRevisionConflict`. Any
   * notification whose reminder no longer matches the round (rescheduled, cancelled or completed) is retired.
   */
  async update(ownerId: string, id: string, value: unknown): Promise<InterviewRound | null> {
    const input = updateInterviewRoundSchema.parse(value);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{ revision: number }>(
        'SELECT revision FROM interview_rounds WHERE owner_id = $1 AND id = $2 FOR UPDATE',
        [ownerId, id],
      );
      if (!current.rowCount) {
        await rollback(client);
        return null;
      }
      if (current.rows[0]!.revision !== input.revision) throw new InterviewRevisionConflict();
      await assertOwnedDocuments(client, ownerId, input.resumeUploadIds);
      await client.query(
        `UPDATE interview_rounds SET title = $3, starts_at = $4, time_zone = $5,
           format = $6, status = $7, contacts = $8::jsonb, checklist = $9::jsonb,
           notes = $10, reminder_at = $11, revision = revision + 1, updated_at = now()
         WHERE owner_id = $1 AND id = $2 AND revision = $12`,
        [
          ownerId,
          id,
          input.title,
          input.startsAt,
          input.timeZone,
          input.format,
          input.status,
          JSON.stringify(input.contacts),
          JSON.stringify(input.checklist),
          input.notes,
          input.reminderAt,
          input.revision,
        ],
      );
      await client.query(
        'DELETE FROM interview_round_documents WHERE owner_id = $1 AND round_id = $2',
        [ownerId, id],
      );
      await client.query(
        `UPDATE in_app_notifications notification SET retired_at = now()
         WHERE notification.owner_id = $1 AND notification.round_id = $2
           AND notification.retired_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM interview_rounds round
             WHERE round.owner_id = notification.owner_id
               AND round.id = notification.round_id
               AND round.status = 'scheduled'
               AND round.starts_at > now()
               AND round.reminder_at = notification.reminder_at
           )`,
        [ownerId, id],
      );
      await insertDocuments(client, ownerId, id, input.resumeUploadIds);
      const result = await client.query<InterviewRound>(
        `SELECT ${columns}, $3::uuid[]::text[] AS "resumeUploadIds"
         FROM interview_rounds round WHERE round.owner_id = $1 AND round.id = $2`,
        [ownerId, id, input.resumeUploadIds],
      );
      await client.query('COMMIT');
      const updated = result.rows[0];
      return updated ? hydrate(updated) : null;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Column list mapping `interview_rounds` (aliased `round`) onto `InterviewRound`. */
const columns = `round.id, round.lead_id AS "leadId", round.title,
   round.starts_at AS "startsAt", round.time_zone AS "timeZone", round.format, round.status,
   round.contacts, round.checklist, round.notes, round.reminder_at AS "reminderAt",
   round.revision, round.created_at AS "createdAt", round.updated_at AS "updatedAt"`;

/** Re-validates JSON columns and ids read from the database before returning them. */
function hydrate(row: InterviewRound): InterviewRound {
  const safeContacts = z.array(contactSchema).parse(row.contacts);
  const safeChecklist = z.array(checklistItemSchema).parse(row.checklist);
  const resumeUploadIds = z.array(z.string().uuid()).parse(row.resumeUploadIds);
  return { ...row, contacts: safeContacts, checklist: safeChecklist, resumeUploadIds };
}

/** Throws a validation error unless every id is one of the user's queued uploads with a parsed result. The key-share lock stops a concurrent delete before the link is inserted. */
async function assertOwnedDocuments(
  client: import('pg').PoolClient,
  ownerId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const result = await client.query(
    `SELECT upload.id FROM resume_uploads upload
     JOIN resume_results result ON result.owner_id = upload.owner_id AND result.upload_id = upload.id
     WHERE upload.owner_id = $1 AND upload.id = ANY($2::uuid[])
       AND upload.status = 'queued' AND result.status = 'parsed'
     FOR KEY SHARE OF upload`,
    [ownerId, ids],
  );
  if (result.rowCount !== ids.length) {
    throw new z.ZodError([
      {
        code: z.ZodIssueCode.custom,
        path: ['resumeUploadIds'],
        message: 'One or more documents are unavailable',
      },
    ]);
  }
}

/** Links each upload to the round. Callers run it in the same transaction as the round write. */
async function insertDocuments(
  client: import('pg').PoolClient,
  ownerId: string,
  roundId: string,
  ids: string[],
): Promise<void> {
  for (const uploadId of ids) {
    await client.query(
      `INSERT INTO interview_round_documents (owner_id, round_id, upload_id)
       VALUES ($1, $2, $3)`,
      [ownerId, roundId, uploadId],
    );
  }
}
