/** Candidate-owned resume drafts. This module stores only explicitly entered resume content. */

import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Database } from './database.js';
import { rollback } from './rollback.js';
import { Conflict } from './errors.js';

const nullableText = (max: number) => z.string().trim().max(max).nullable();
const experienceSchema = z
  .object({
    id: z.string().min(1).max(80),
    role: z.string().trim().min(1).max(120),
    company: z.string().trim().min(1).max(120),
    location: nullableText(120),
    startDate: nullableText(32),
    endDate: nullableText(32),
    bullets: z.array(z.string().trim().min(1).max(600)).max(12),
  })
  .strict();
const educationSchema = z
  .object({
    id: z.string().min(1).max(80),
    institution: z.string().trim().min(1).max(160),
    qualification: z.string().trim().min(1).max(120),
    location: nullableText(120),
    endDate: nullableText(32),
  })
  .strict();

export const resumeTemplateSchema = z.enum(['classic', 'modern', 'compact']);
export type ResumeTemplate = z.infer<typeof resumeTemplateSchema>;

export const resumeDraftContentSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120),
    email: z.string().email().max(254).nullable(),
    phone: nullableText(40),
    location: nullableText(120),
    summary: z.string().trim().max(2400),
    experience: z.array(experienceSchema).max(20),
    education: z.array(educationSchema).max(12),
    skills: z.array(z.string().trim().min(1).max(80)).max(60),
  })
  .strict()
  .superRefine((content, context) => {
    for (const field of ['experience', 'education', 'skills'] as const) {
      const values =
        field === 'experience' || field === 'education'
          ? content[field].map((item) => item.id.toLowerCase())
          : content.skills.map((item) => item.toLowerCase());
      const seen = new Set<string>();
      values.forEach((value, index) => {
        if (seen.has(value))
          context.addIssue({
            code: 'custom',
            path: [field, index],
            message: 'Values must be unique',
          });
        seen.add(value);
      });
    }
  });
export type ResumeDraftContent = z.infer<typeof resumeDraftContentSchema>;

const resumeDraftFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    targetRole: z.string().trim().min(1).max(80).nullable(),
    template: resumeTemplateSchema,
    content: resumeDraftContentSchema,
  })
  .strict();

export const createResumeDraftSchema = resumeDraftFieldsSchema
  .extend({ variantOfId: z.string().uuid().nullable().default(null) })
  .superRefine((draft, context) => {
    if (draft.variantOfId && !draft.targetRole) {
      context.addIssue({
        code: 'custom',
        path: ['targetRole'],
        message: 'Role variants require a target role',
      });
    }
  });
export const updateResumeDraftSchema = resumeDraftFieldsSchema.extend({
  revision: z.number().int().min(1).max(2_147_483_646),
});

export type ResumeDraftRecord = z.infer<typeof createResumeDraftSchema> & {
  id: string;
  ownerId: string;
  revision: number;
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

const columns = `id, owner_id AS "ownerId", variant_of_id AS "variantOfId", title,
  target_role AS "targetRole", template, content, revision, approved_at AS "approvedAt",
  created_at AS "createdAt", updated_at AS "updatedAt"`;

function hydrate(row: ResumeDraftRecord): ResumeDraftRecord {
  return {
    ...row,
    template: resumeTemplateSchema.parse(row.template),
    content: resumeDraftContentSchema.parse(row.content),
  };
}

/** Optimistic-concurrency conflict for a stale draft edit. */
export class ResumeDraftRevisionConflict extends Conflict {
  constructor() {
    super('Resume draft changed', 'RESUME_DRAFT_REVISION_CONFLICT');
  }
}

/** PostgreSQL access for editable, owner-scoped resume drafts. */
export class ResumeDraftRepository {
  constructor(private readonly database: Database) {}

  async list(ownerId: string): Promise<ResumeDraftRecord[]> {
    const result = await this.database.pool.query<ResumeDraftRecord>(
      `SELECT ${columns} FROM resume_drafts WHERE owner_id = $1 ORDER BY updated_at DESC, id`,
      [ownerId],
    );
    return result.rows.map(hydrate);
  }

  async get(ownerId: string, id: string): Promise<ResumeDraftRecord | null> {
    const result = await this.database.pool.query<ResumeDraftRecord>(
      `SELECT ${columns} FROM resume_drafts WHERE owner_id = $1 AND id = $2`,
      [ownerId, id],
    );
    return result.rows[0] ? hydrate(result.rows[0]) : null;
  }

  async create(ownerId: string, input: unknown): Promise<ResumeDraftRecord | null> {
    const draft = createResumeDraftSchema.parse(input);
    const result = await this.database.pool.query<ResumeDraftRecord>(
      `INSERT INTO resume_drafts (id, owner_id, title, target_role, template, content, variant_of_id)
       SELECT $1, $2, $3, $4, $5, $6::jsonb, $7
       WHERE $7::uuid IS NULL OR EXISTS (
         SELECT 1 FROM resume_drafts parent WHERE parent.id = $7 AND parent.owner_id = $2
       )
       RETURNING ${columns}`,
      [
        randomUUID(),
        ownerId,
        draft.title,
        draft.targetRole,
        draft.template,
        JSON.stringify(draft.content),
        draft.variantOfId,
      ],
    );
    return result.rows[0] ? hydrate(result.rows[0]) : null;
  }

  async update(ownerId: string, id: string, input: unknown): Promise<ResumeDraftRecord | null> {
    const changes = updateResumeDraftSchema.parse(input);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const current = (
        await client.query<ResumeDraftRecord>(
          `SELECT ${columns} FROM resume_drafts WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
          [ownerId, id],
        )
      ).rows[0];
      if (!current) {
        await rollback(client);
        return null;
      }
      if (current.revision !== changes.revision) throw new ResumeDraftRevisionConflict();
      if (
        current.title === changes.title &&
        current.targetRole === changes.targetRole &&
        current.template === changes.template &&
        isDeepStrictEqual(current.content, changes.content)
      ) {
        await client.query('COMMIT');
        return hydrate(current);
      }
      const updated = await client.query<ResumeDraftRecord>(
        `UPDATE resume_drafts SET title = $3, target_role = $4, template = $5, content = $6::jsonb,
         revision = revision + 1, approved_at = NULL, updated_at = now()
         WHERE owner_id = $1 AND id = $2 RETURNING ${columns}`,
        [
          ownerId,
          id,
          changes.title,
          changes.targetRole,
          changes.template,
          JSON.stringify(changes.content),
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

  async approve(ownerId: string, id: string, revision: number): Promise<ResumeDraftRecord | null> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const current = (
        await client.query<ResumeDraftRecord>(
          `SELECT ${columns} FROM resume_drafts WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
          [ownerId, id],
        )
      ).rows[0];
      if (!current) {
        await rollback(client);
        return null;
      }
      if (current.revision !== revision) throw new ResumeDraftRevisionConflict();
      const approved = await client.query<ResumeDraftRecord>(
        `UPDATE resume_drafts SET approved_at = now(), updated_at = now()
         WHERE owner_id = $1 AND id = $2 RETURNING ${columns}`,
        [ownerId, id],
      );
      await client.query('COMMIT');
      return hydrate(approved.rows[0]!);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async delete(ownerId: string, id: string): Promise<boolean> {
    const result = await this.database.pool.query(
      'DELETE FROM resume_drafts WHERE owner_id = $1 AND id = $2',
      [ownerId, id],
    );
    return result.rowCount === 1;
  }
}
