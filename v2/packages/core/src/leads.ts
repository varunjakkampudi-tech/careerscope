import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Database } from './database.js';
import { collectedJobSchema, type CollectedJob } from './jobs.js';
import { Conflict } from './errors.js';

export const leadStatusSchema = z.enum(['saved', 'archived']);
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

export type LeadRecord = {
  id: string;
  data: CollectedJob;
  notes: string;
  status: z.infer<typeof leadStatusSchema>;
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
export class LeadRevisionConflict extends Conflict {}
const columns =
  'id, data, notes, status, revision, created_at AS "createdAt", updated_at AS "updatedAt"';

export class LeadRepository {
  constructor(private readonly database: Database) {}

  async get(ownerId: string, id: string): Promise<LeadRecord | null> {
    const result = await this.database.pool.query<LeadRecord>(
      `SELECT ${columns} FROM saved_leads WHERE owner_id = $1 AND id = $2`,
      [ownerId, id],
    );
    return result.rows[0] ?? null;
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
    const items = result.rows.slice(0, limit);
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
         AND run.owner_id = job.owner_id WHERE job.owner_id = $1 AND job.id = $2 AND run.status = 'completed'`,
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
      return lead ?? null;
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
        return current;
      }
      const updated = await client.query<LeadRecord>(
        `UPDATE saved_leads SET notes = $3, status = $4, revision = revision + 1, updated_at = now()
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
      return updated.rows[0]!;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
