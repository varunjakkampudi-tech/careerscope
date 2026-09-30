import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './database.js';
import { collectedJobSchema, type CollectedJob } from './jobs.js';
import { Conflict } from './errors.js';

export const leadStatusSchema = z.enum([
  'saved',
  'applied',
  'interviewing',
  'offer',
  'rejected',
  'archived',
]);
export const saveLeadSchema = z.object({ jobId: z.string().uuid() }).strict();
export const updateLeadSchema = z
  .object({
    revision: z.number().int().min(1).max(2_147_483_646),
    notes: z.string().max(10000),
    status: leadStatusSchema,
  })
  .strict();
const listSchema = z
  .object({
    status: leadStatusSchema.default('saved'),
    before: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  })
  .strict();
const historySchema = z
  .object({
    before: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  })
  .strict();

export const livenessStatusSchema = z.enum(['unknown', 'live', 'stale']);

export type LeadRecord = {
  id: string;
  data: CollectedJob;
  notes: string;
  status: z.infer<typeof leadStatusSchema>;
  // CS-27: a real, checked fact - distinct from status (the owner's own
  // pipeline stage) and from createdAt/updatedAt (age). 'unknown' until an
  // actual HTTP check has run; only ever 'live'/'stale' after a genuinely
  // unambiguous result.
  livenessStatus: z.infer<typeof livenessStatusSchema>;
  livenessCheckedAt: Date | null;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
};
export type LeadHistoryRecord = {
  revision: number;
  status: LeadRecord['status'];
  notesChanged: boolean;
  createdAt: Date;
};
export class LeadRevisionConflict extends Conflict {
  constructor(message: string) {
    super(message, 'LEAD_REVISION_CONFLICT');
  }
}
const columns =
  'id, data, notes, status, revision, created_at AS "createdAt", updated_at AS "updatedAt",' +
  ' liveness_status AS "livenessStatus", liveness_checked_at AS "livenessCheckedAt"';

// CS-33 (Security review, 2026-09-24): every read below previously returned
// `data` straight from Postgres, trusting that LeadRepository.save()'s own
// write-time collectedJobSchema.strip().parse() call was the only writer
// this table would ever have. That is true today, but it is a write-path
// invariant, not something the read path enforced or could prove - a future
// direct write, migration or backfill touching saved_leads.data would
// silently reach every caller of get/list/save/update unfiltered. Re-
// validating on every read closes that gap the same way GET .../export
// already did, rather than leaving detail/list/save/update as the two
// (now: none) read surfaces relying on trust alone.
function hydrate(row: LeadRecord): LeadRecord {
  return { ...row, data: collectedJobSchema.strip().parse(row.data) };
}

export class LeadRepository {
  constructor(private readonly database: Database) {}

  /** Resolve an owner's saved lead for a run-local search job. */
  async getByJob(ownerId: string, jobId: string): Promise<LeadRecord | null> {
    const result = await this.database.pool.query<LeadRecord>(
      `SELECT ${columns}
       FROM saved_leads lead
       JOIN search_jobs job ON job.owner_id = lead.owner_id
         AND job.data->>'fingerprint' = lead.fingerprint
       JOIN search_runs run ON run.id = job.run_id AND run.owner_id = job.owner_id
       WHERE lead.owner_id = $1 AND job.id = $2
       ORDER BY job.created_at DESC, lead.created_at DESC
       LIMIT 1`,
      [ownerId, jobId],
    );
    return result.rows[0] ? hydrate(result.rows[0]) : null;
  }

  async get(ownerId: string, id: string): Promise<LeadRecord | null> {
    const result = await this.database.pool.query<LeadRecord>(
      `SELECT ${columns} FROM saved_leads WHERE owner_id = $1 AND id = $2`,
      [ownerId, id],
    );
    return result.rows[0] ? hydrate(result.rows[0]) : null;
  }

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

  async history(ownerId: string, id: string, input: unknown) {
    const { before } = historySchema.parse(input);
    if (!(await this.get(ownerId, id))) return null;
    const result = await this.database.pool.query<LeadHistoryRecord>(
      `SELECT revision, status, notes_changed = 1 AS "notesChanged", created_at AS "createdAt"
       FROM lead_history WHERE owner_id = $1 AND lead_id = $2
       AND ($3::integer IS NULL OR revision < $3) ORDER BY revision DESC LIMIT 26`,
      [ownerId, id, before ?? null],
    );
    const items = result.rows.slice(0, 25);
    return { items, nextCursor: result.rows.length > 25 ? items.at(-1)!.revision : null };
  }

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
        await client.query('ROLLBACK');
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
          `INSERT INTO lead_history (id, owner_id, lead_id, revision, status, notes_changed)
           VALUES ($1, $2, $3, 1, 'saved', 0)`,
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
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

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
        await client.query('ROLLBACK');
        return null;
      }
      if (current.revision !== changes.revision)
        throw new LeadRevisionConflict('Lead revision changed');
      if (current.notes === changes.notes && current.status === changes.status) {
        await client.query('COMMIT');
        return hydrate(current);
      }
      const updated = await client.query<LeadRecord>(
        `UPDATE saved_leads SET notes = $3, status = $4, revision = revision + 1, updated_at = now(),
         -- Only moved when the stage actually changes, so editing a note does
         -- not make a cold application look freshly worked.
         status_changed_at = CASE WHEN status <> $4 THEN now() ELSE status_changed_at END
         WHERE owner_id = $1 AND id = $2 RETURNING ${columns}`,
        [ownerId, id, changes.notes, changes.status],
      );
      await client.query(
        `INSERT INTO lead_history (id, owner_id, lead_id, revision, status, notes_changed)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          randomUUID(),
          ownerId,
          id,
          updated.rows[0]!.revision,
          changes.status,
          Number(current.notes !== changes.notes),
        ],
      );
      await client.query('COMMIT');
      return hydrate(updated.rows[0]!);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * CS-27: the liveness checker's own work queue - every owner, oldest
   * (or never-)checked first, bounded so one run cannot become an unbounded
   * scan. Archived/rejected leads are excluded on purpose: re-verifying a
   * listing the owner has already moved past wastes the same outbound
   * requests this ticket exists to make useful. A lead checked more
   * recently than `staleAfterHours` is not due yet either - otherwise a
   * confirmed-live lead would be re-fetched on every single run forever,
   * for no new information.
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
