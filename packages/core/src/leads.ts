/**
 * Saved leads: the user's pipeline over jobs found by searches. Handles save, revision-guarded
 * updates with history, application evidence, tags and liveness checks. Jobs come from `jobs.ts`
 * data in `search_jobs`; every query is scoped by `owner_id`.
 */

import { rollback } from './rollback.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './database.js';
import { collectedJobSchema, type CollectedJob } from './jobs.js';
import { Conflict } from './errors.js';

/** Pipeline statuses a user can set; `applied` and later statuses require candidate-reported application evidence. */
export const leadStatusSchema = z.enum([
  'saved',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
  'archived',
]);
// This is a candidate-reported claim, not an employer/ATS acknowledgement.
// Free-text method/source labels preserve what the candidate actually enters
// without asserting a provider capability or a verified submission event.
export const applicationEvidenceSchema = z
  .object({
    method: z.string().trim().min(1).max(120),
    appliedAt: z.string().datetime({ offset: true }),
    confirmation: z.enum(['unknown', 'received', 'not_received']),
    source: z.string().trim().max(160),
    confidence: z.enum(['unknown', 'low', 'medium', 'high']),
  })
  .strict()
  .refine((value) => new Date(value.appliedAt).getTime() <= Date.now(), {
    path: ['appliedAt'],
    message: 'Application time cannot be in the future',
  });
export type ApplicationEvidence = z.infer<typeof applicationEvidenceSchema>;
/** Record that an employer acknowledged an application; stored separately from the candidate's own claim. */
export const employerApplicationAcknowledgementSchema = z
  .object({
    receivedAt: z.string().datetime({ offset: true }),
    source: z.string().trim().min(1).max(160),
    reference: z.string().max(240).nullable(),
  })
  .strict();
export type EmployerApplicationAcknowledgement = z.infer<
  typeof employerApplicationAcknowledgementSchema
>;
/** Body for saving a lead: the id of a job from a completed or partial run. */
export const saveLeadSchema = z.object({ jobId: z.string().uuid() }).strict();
/** Up to 12 unique (case-insensitive) tags of at most 32 characters, with no commas or control characters. */
export const leadTagsSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .refine((tag) => Array.from(tag).length <= 32, 'Tags must contain at most 32 characters')
      .refine((tag) => !tag.includes(','), 'Tags cannot contain commas')
      .refine((tag) => !/\p{Cc}/u.test(tag), 'Tags cannot contain control characters'),
  )
  .max(12)
  .superRefine((tags, context) => {
    const seen = new Set<string>();
    tags.forEach((tag, index) => {
      const key = tag.toLowerCase();
      if (seen.has(key))
        context.addIssue({ code: 'custom', path: [index], message: 'Tags must be unique' });
      seen.add(key);
    });
  });
/** Full replacement of a lead's editable fields, guarded by the `revision` the client last saw. */
export const updateLeadSchema = z
  .object({
    revision: z.number().int().min(1).max(2_147_483_646),
    notes: z.string().max(10000),
    status: leadStatusSchema,
    applicationEvidence: applicationEvidenceSchema.nullable().optional(),
    tags: leadTagsSchema.optional(),
  })
  .strict();
const listSchema = z
  .object({
    status: leadStatusSchema.default('saved'),
    before: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();
/** Statuses that count as applications for the export. */
const applicationExportStatuses: readonly LeadRecord['status'][] = [
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'withdrawn',
];
const historySchema = z
  .object({
    before: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict();

/** Result of checking whether a job's apply link still responds. */
export const livenessStatusSchema = z.enum(['unknown', 'live', 'stale']);

/** A saved lead as returned to callers, after `hydrate` has re-validated it. */
export type LeadRecord = {
  id: string;
  data: CollectedJob;
  notes: string;
  status: z.infer<typeof leadStatusSchema>;
  applicationEvidence: ApplicationEvidence | null;
  employerAcknowledgement: EmployerApplicationAcknowledgement | null;
  tags: string[];
  // A checked fact, distinct from `status` (the user's own pipeline stage) and
  // from createdAt/updatedAt (age). 'unknown' until an HTTP check has run; only
  // 'live' or 'stale' after an unambiguous result.
  livenessStatus: z.infer<typeof livenessStatusSchema>;
  livenessCheckedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};
/** One revision of a lead: what changed and the status before and after. Notes content is not copied into history. */
export type LeadHistoryRecord = {
  revision: number;
  previousStatus: LeadRecord['status'] | null;
  status: LeadRecord['status'];
  notesChanged: boolean;
  applicationEvidenceChanged: boolean;
  applicationEvidence: LeadRecord['applicationEvidence'];
  tagsChanged: boolean;
  tags: string[];
  createdAt: Date;
};
/** The lead was changed by someone else since the caller read it; the API maps it to a 409 so the client can reload. */
export class LeadRevisionConflict extends Conflict {
  constructor(message: string) {
    super(message, 'LEAD_REVISION_CONFLICT');
  }
}
/** Column list that maps `saved_leads` to `LeadRecord`, including the latest employer acknowledgement as a subselect. */
const columns =
  'id, data, notes, tags, status, application_evidence AS "applicationEvidence", revision, created_at AS "createdAt", updated_at AS "updatedAt",' +
  ' liveness_status AS "livenessStatus", liveness_checked_at AS "livenessCheckedAt",' +
  ` (SELECT jsonb_build_object('receivedAt', ack.received_at, 'source', ack.source, 'reference', ack.reference)
     FROM employer_application_acknowledgements ack
     WHERE ack.owner_id = saved_leads.owner_id AND ack.lead_id = saved_leads.id
     ORDER BY ack.received_at DESC, ack.id DESC LIMIT 1) AS "employerAcknowledgement"`;
/** Same as `columns`, with a table alias for queries that join other tables. */
const qualifiedColumns = (alias: string) =>
  `${alias}.id, ${alias}.data, ${alias}.notes, ${alias}.tags, ${alias}.status, ${alias}.application_evidence AS "applicationEvidence", ${alias}.revision,` +
  ` ${alias}.created_at AS "createdAt", ${alias}.updated_at AS "updatedAt",` +
  ` ${alias}.liveness_status AS "livenessStatus", ${alias}.liveness_checked_at AS "livenessCheckedAt",` +
  ` (SELECT jsonb_build_object('receivedAt', ack.received_at, 'source', ack.source, 'reference', ack.reference)
     FROM employer_application_acknowledgements ack
     WHERE ack.owner_id = ${alias}.owner_id AND ack.lead_id = ${alias}.id
     ORDER BY ack.received_at DESC, ack.id DESC LIMIT 1) AS "employerAcknowledgement"`;

/**
 * Re-validates a row on every read instead of trusting the stored JSON. `save()` validates on
 * write, but that is a write-path invariant: a direct write, migration or backfill touching
 * `saved_leads.data` would otherwise reach every caller of get, list, save and update unfiltered.
 * `strip()` drops unknown keys, so only the current schema's fields leave this module.
 */
function hydrate(row: LeadRecord): LeadRecord {
  return {
    ...row,
    data: collectedJobSchema.strip().parse(row.data),
    tags: leadTagsSchema.parse(row.tags),
    applicationEvidence:
      row.applicationEvidence === null
        ? null
        : applicationEvidenceSchema.parse(row.applicationEvidence),
    employerAcknowledgement:
      row.employerAcknowledgement === null
        ? null
        : employerApplicationAcknowledgementSchema.parse(row.employerAcknowledgement),
  };
}

/** Field-by-field equality, so an unchanged resubmission is detected and creates no new revision. */
function sameApplicationEvidence(
  left: ApplicationEvidence | null,
  right: ApplicationEvidence | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.method === right.method &&
    left.appliedAt === right.appliedAt &&
    left.confirmation === right.confirmation &&
    left.source === right.source &&
    left.confidence === right.confidence
  );
}

/** Postgres access for saved leads. All methods take `ownerId` and never return another user's rows. */
export class LeadRepository {
  constructor(private readonly database: Database) {}

  /** Resolves the user's saved lead (matched by fingerprint) for a job from a search run, newest run first. */
  async getByJob(ownerId: string, jobId: string): Promise<LeadRecord | null> {
    const result = await this.database.pool.query<LeadRecord>(
      `SELECT ${qualifiedColumns('lead')}
       FROM saved_leads lead
       JOIN search_jobs job ON job.owner_id = lead.owner_id
         AND job.data->>'fingerprint' = lead.fingerprint
       JOIN search_runs run ON run.id = job.run_id AND run.owner_id = job.owner_id
       WHERE lead.owner_id = $1 AND job.id = $2
       ORDER BY run.created_at DESC, lead.created_at DESC
       LIMIT 1`,
      [ownerId, jobId],
    );
    return result.rows[0] ? hydrate(result.rows[0]) : null;
  }

  /** One lead by id, or null. */
  async get(ownerId: string, id: string): Promise<LeadRecord | null> {
    const result = await this.database.pool.query<LeadRecord>(
      `SELECT ${columns} FROM saved_leads WHERE owner_id = $1 AND id = $2`,
      [ownerId, id],
    );
    return result.rows[0] ? hydrate(result.rows[0]) : null;
  }

  /** One page of leads in a status, newest first, with a keyset cursor (`before`) rather than an offset. */
  async list(ownerId: string, input: unknown) {
    const { status, before, limit } = listSchema.parse(input);
    const result = await this.database.pool.query<LeadRecord>(
      `SELECT ${columns} FROM saved_leads WHERE owner_id = $1 AND status = $2
       AND ($3::uuid IS NULL OR (created_at, id) <
         (SELECT created_at, id FROM saved_leads WHERE owner_id = $1 AND id = $3))
       ORDER BY created_at DESC, id DESC LIMIT $4`,
      [ownerId, status, before ?? null, limit + 1],
    );
    const items = result.rows.slice(0, limit).map(hydrate);
    return { items, nextCursor: result.rows.length > limit ? items.at(-1)!.id : null };
  }

  /** Every lead whose status is an application status, most recently updated first. */
  async listApplicationsForExport(ownerId: string): Promise<LeadRecord[]> {
    const result = await this.database.pool.query<LeadRecord>(
      `SELECT ${columns} FROM saved_leads
       WHERE owner_id = $1 AND status = ANY($2::text[])
       ORDER BY updated_at DESC, id DESC`,
      [ownerId, applicationExportStatuses],
    );
    return result.rows.map(hydrate);
  }

  /** Page of a lead's history (25 per page, newest first), or null if the lead is not the user's. */
  async history(ownerId: string, id: string, input: unknown) {
    const { before } = historySchema.parse(input);
    if (!(await this.get(ownerId, id))) return null;
    const result = await this.database.pool.query<LeadHistoryRecord>(
      `SELECT revision, previous_status AS "previousStatus", status,
       notes_changed = 1 AS "notesChanged", application_evidence_changed AS "applicationEvidenceChanged",
       application_evidence AS "applicationEvidence", tags_changed AS "tagsChanged", tags,
       created_at AS "createdAt"
       FROM lead_history WHERE owner_id = $1 AND lead_id = $2
       AND ($3::integer IS NULL OR revision < $3) ORDER BY revision DESC LIMIT 26`,
      [ownerId, id, before ?? null],
    );
    const items = result.rows.slice(0, 25).map((item) => ({
      ...item,
      tags: leadTagsSchema.parse(item.tags),
      applicationEvidence:
        item.applicationEvidence === null
          ? null
          : applicationEvidenceSchema.parse(item.applicationEvidence),
    }));
    return { items, nextCursor: result.rows.length > 25 ? items.at(-1)!.revision : null };
  }

  /** Saves a job from a completed or partial run as a lead. Idempotent per fingerprint: saving the same job again returns the existing lead. */
  async save(ownerId: string, input: unknown): Promise<LeadRecord | null> {
    const { jobId } = saveLeadSchema.parse(input);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const source = await client.query<{ data: unknown }>(
        `SELECT job.data FROM search_jobs job JOIN search_runs run ON run.id = job.run_id
         AND run.owner_id = job.owner_id WHERE job.owner_id = $1 AND job.id = $2 AND run.status IN ('completed', 'partial')`,
        [ownerId, jobId],
      );
      if (!source.rows[0]) {
        await rollback(client);
        return null;
      }
      const data = collectedJobSchema.strip().parse(source.rows[0].data);
      const inserted = await client.query<LeadRecord>(
        `INSERT INTO saved_leads (id, owner_id, fingerprint, data) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (owner_id, fingerprint) DO NOTHING RETURNING ${columns}`,
        [randomUUID(), ownerId, data.fingerprint, JSON.stringify(data)],
      );
      let lead = inserted.rows[0];
      if (lead) {
        await client.query(
          `INSERT INTO lead_history (id, owner_id, lead_id, revision, status, notes_changed,
           previous_status, application_evidence_changed, application_evidence, tags_changed, tags)
           VALUES ($1, $2, $3, 1, 'saved', 0, NULL, false, NULL, false, ARRAY[]::text[])`,
          [randomUUID(), ownerId, lead.id],
        );
      } else {
        lead = (
          await client.query<LeadRecord>(
            `SELECT ${columns} FROM saved_leads WHERE owner_id = $1 AND fingerprint = $2`,
            [ownerId, data.fingerprint],
          )
        ).rows[0];
      }
      await client.query('COMMIT');
      return lead ? hydrate(lead) : null;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Applies a revision-guarded edit under a row lock and appends a history row. Throws
   * `LeadRevisionConflict` if the revision is stale. An unchanged submission returns the current lead
   * without a new revision. Application evidence cannot be removed once recorded.
   */
  async update(ownerId: string, id: string, input: unknown): Promise<LeadRecord | null> {
    const changes = updateLeadSchema.parse(input);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const current = (
        await client.query<LeadRecord>(
          `SELECT ${columns} FROM saved_leads WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
          [ownerId, id],
        )
      ).rows[0];
      if (!current) {
        await rollback(client);
        return null;
      }
      if (current.revision !== changes.revision)
        throw new LeadRevisionConflict('Lead revision changed');
      if (
        changes.tags !== undefined &&
        (!['saved', 'archived'].includes(current.status) ||
          !['saved', 'archived'].includes(changes.status))
      ) {
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['tags'],
            message: 'Tags can only be edited while a lead is saved or archived',
          },
        ]);
      }
      const applicationEvidence =
        changes.applicationEvidence === undefined
          ? current.applicationEvidence
          : changes.applicationEvidence;
      const tags = changes.tags ?? current.tags;
      if (current.applicationEvidence && changes.applicationEvidence === null) {
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['applicationEvidence'],
            message: 'Candidate-reported application evidence cannot be removed from history',
          },
        ]);
      }
      // Statuses that represent an application lifecycle step and therefore need candidate-reported evidence.
      const progressedStatuses: LeadRecord['status'][] = [
        'applied',
        'interviewing',
        'offer',
        'rejected',
        'withdrawn',
      ];
      // Archiving or restoring a lead is an organizational action, not a claim
      // that the candidate never applied. Preserve an existing application
      // report across those status changes; only a newly supplied claim must
      // accompany an application lifecycle status.
      if (
        !current.applicationEvidence &&
        applicationEvidence &&
        !progressedStatuses.includes(changes.status)
      ) {
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['status'],
            message: 'Candidate-reported application evidence requires an application status',
          },
        ]);
      }
      if (
        progressedStatuses.includes(changes.status) &&
        !current.applicationEvidence &&
        !applicationEvidence &&
        current.status !== changes.status
      ) {
        throw new z.ZodError([
          {
            code: 'custom',
            path: ['applicationEvidence'],
            message: 'Candidate-reported application evidence is required for this status',
          },
        ]);
      }
      if (
        current.notes === changes.notes &&
        current.status === changes.status &&
        sameApplicationEvidence(current.applicationEvidence, applicationEvidence) &&
        current.tags.length === tags.length &&
        current.tags.every((tag, index) => tag === tags[index])
      ) {
        await client.query('COMMIT');
        return hydrate(current);
      }
      const updated = await client.query<LeadRecord>(
        `UPDATE saved_leads SET notes = $3, status = $4, application_evidence = $5::jsonb, tags = $6::text[],
         revision = revision + 1, updated_at = now(),
         -- Only moved when the stage actually changes, so editing a note does
         -- not make a cold application look freshly worked.
         status_changed_at = CASE WHEN status <> $4 THEN now() ELSE status_changed_at END
         WHERE owner_id = $1 AND id = $2 RETURNING ${columns}`,
        [
          ownerId,
          id,
          changes.notes,
          changes.status,
          applicationEvidence === null ? null : JSON.stringify(applicationEvidence),
          tags,
        ],
      );
      await client.query(
        `INSERT INTO lead_history (id, owner_id, lead_id, revision, status, notes_changed,
         previous_status, application_evidence_changed, application_evidence, tags_changed, tags)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::text[])`,
        [
          randomUUID(),
          ownerId,
          id,
          updated.rows[0]!.revision,
          changes.status,
          Number(current.notes !== changes.notes),
          current.status,
          Number(!sameApplicationEvidence(current.applicationEvidence, applicationEvidence)),
          applicationEvidence === null ? null : JSON.stringify(applicationEvidence),
          Number(
            current.tags.length !== tags.length ||
              current.tags.some((tag, index) => tag !== tags[index]),
          ),
          tags,
        ],
      );
      await client.query('COMMIT');
      return hydrate(updated.rows[0]!);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Work queue for the liveness checker: leads across all users, never-checked first and then
   * oldest-checked, bounded by `limit` so a run cannot become an unbounded scan. Archived and
   * rejected leads are excluded because the user has moved past them and re-checking wastes outbound
   * requests. A lead checked within `staleAfterHours` is not due, so a confirmed-live lead is not
   * re-fetched on every run for no new information.
   */
  async dueForLivenessCheck(
    limit: number,
    staleAfterHours = 24,
  ): Promise<Array<{ ownerId: string; id: string; applyUrl: string }>> {
    const result = await this.database.pool.query<{
      ownerId: string;
      id: string;
      applyUrl: string;
    }>(
      `SELECT owner_id AS "ownerId", id, data->>'applyUrl' AS "applyUrl"
       FROM saved_leads
       WHERE status NOT IN ('archived', 'rejected')
       AND (liveness_checked_at IS NULL
         OR liveness_checked_at < now() - ($2 || ' hours')::interval)
       ORDER BY liveness_checked_at ASC NULLS FIRST
       LIMIT $1`,
      [limit, staleAfterHours],
    );
    return result.rows;
  }

  /**
   * Always stamps liveness_checked_at, even for an 'unknown' (ambiguous)
   * result - otherwise a URL that errors consistently would sort first in
   * dueForLivenessCheck() forever and starve every other lead's turn.
   */
  async recordLivenessCheck(
    ownerId: string,
    id: string,
    livenessStatus: z.infer<typeof livenessStatusSchema>,
  ): Promise<void> {
    await this.database.pool.query(
      `UPDATE saved_leads SET liveness_status = $3, liveness_checked_at = now()
       WHERE owner_id = $1 AND id = $2`,
      [ownerId, id, livenessStatus],
    );
  }
}
