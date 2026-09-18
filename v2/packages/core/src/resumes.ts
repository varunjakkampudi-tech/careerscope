import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Database } from './database.js';
import type { Command } from './commands.js';
import { Conflict } from './errors.js';
import {
  maximumResumeBytes,
  resumeUploadMetadataSchema,
  type ResumeObject,
  type ResumeObjectStore,
} from './storage.js';
import { detectFormat } from '../../../../packages/resume/dist/extract.js';
import { commandSchema } from './commands.js';
import { parsedResumeSchema, parseResumeIsolated, ResumeDocumentError } from './resume-parser.js';
import type { Handler } from './dispatch.js';

const parseOutcomeSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('parsed'), parsed: parsedResumeSchema }).strict(),
  z
    .object({
      status: z.literal('rejected'),
      errorCode: z.enum(['invalid_document', 'processing_failed']),
    })
    .strict(),
]);
export type ResumeParseOutcome = z.infer<typeof parseOutcomeSchema>;

const identifier = z.string().uuid();
const keySchema = z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/);
const bucketSchema = z.string().regex(/^[a-z][a-z0-9-]{1,61}[a-z0-9]$/);
const versionSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => value !== 'null');

export type ResumeUploadRecord = z.infer<typeof resumeUploadMetadataSchema> & {
  id: string;
  ownerId: string;
  bucket: string;
  objectVersion: string | null;
  commandId: string | null;
  status: 'uploading' | 'queued' | 'cancelling' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
};

const columns = `id, owner_id AS "ownerId", bucket, sha256, bytes,
  content_type AS "contentType", object_version AS "objectVersion", command_id AS "commandId",
  status, created_at AS "createdAt", updated_at AS "updatedAt"`;

export class ResumeStorageLimit extends Conflict {}

export class ResumeUploadRepository {
  constructor(private readonly database: Database) {}

  async result(ownerId: string, uploadId: string): Promise<ResumeParseOutcome | null> {
    const result = await this.database.pool.query<{
      status: string;
      parsed: unknown;
      errorCode: string | null;
    }>(
      'SELECT status, parsed, error_code AS "errorCode" FROM resume_results WHERE owner_id = $1 AND upload_id = $2',
      [identifier.parse(ownerId), identifier.parse(uploadId)],
    );
    const record = result.rows[0];
    if (!record) return null;
    return parseOutcomeSchema.parse(
      record.status === 'parsed'
        ? { status: record.status, parsed: record.parsed }
        : { status: record.status, errorCode: record.errorCode },
    );
  }

  async settleParse(input: Command, fence: number, outcome: ResumeParseOutcome): Promise<boolean> {
    const command = commandSchema.parse(input);
    if (command.type !== 'resume.parse') throw new Conflict('Unsupported resume completion type');
    z.number().int().positive().parse(fence);
    const parsed = parseOutcomeSchema.parse(outcome);
    const execution =
      parsed.status === 'rejected' && parsed.errorCode === 'processing_failed'
        ? 'failed'
        : 'completed';
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const owned = await client.query(
        `UPDATE command_executions SET status = $4
        WHERE id = $1 AND fence = $2 AND status = 'running' AND lease_until > now()
        AND EXISTS (SELECT 1 FROM outbox_events WHERE id = $1 AND command = $3::jsonb) RETURNING id`,
        [command.id, fence, JSON.stringify(command), execution],
      );
      if (!owned.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      const inserted = await client.query(
        `INSERT INTO resume_results (upload_id, owner_id, command_id, status, parsed, error_code)
        SELECT id, owner_id, command_id, $4, $5::jsonb, $6 FROM resume_uploads
        WHERE id = $1 AND owner_id = $2 AND command_id = $3 AND status = 'queued' RETURNING upload_id`,
        [
          command.aggregateId,
          command.ownerId,
          command.id,
          parsed.status,
          parsed.status === 'parsed' ? JSON.stringify(parsed.parsed) : null,
          parsed.status === 'rejected' ? parsed.errorCode : null,
        ],
      );
      if (!inserted.rowCount) throw new Conflict('Upload is not eligible for parse completion');
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async get(ownerId: string, id: string): Promise<ResumeUploadRecord | null> {
    const result = await this.database.pool.query<ResumeUploadRecord>(
      `SELECT ${columns} FROM resume_uploads WHERE owner_id = $1 AND id = $2`,
      [identifier.parse(ownerId), identifier.parse(id)],
    );
    return result.rows[0] ?? null;
  }

  async reserve(
    ownerId: string,
    key: string,
    bucket: string,
    input: unknown,
  ): Promise<ResumeUploadRecord> {
    identifier.parse(ownerId);
    keySchema.parse(key);
    bucketSchema.parse(bucket);
    const metadata = resumeUploadMetadataSchema.parse(input);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [ownerId]);
      await client.query('SELECT pg_advisory_xact_lock(734205, 1)');
      const existingKey = await client.query(
        'SELECT id FROM resume_uploads WHERE owner_id = $1 AND idempotency_key = $2',
        [ownerId, key],
      );
      if (!existingKey.rowCount) {
        const globalUsage = await client.query<{ count: string; bytes: string }>(
          'SELECT count(*) AS count, COALESCE(sum(bytes), 0) AS bytes FROM resume_uploads',
        );
        if (
          Number(globalUsage.rows[0]!.count) >= 1000 ||
          Number(globalUsage.rows[0]!.bytes) + metadata.bytes > 1024 * 1024 * 1024
        ) {
          throw new ResumeStorageLimit('Resume storage limit reached');
        }
        const usage = await client.query<{ count: string; bytes: string }>(
          'SELECT count(*) AS count, COALESCE(sum(bytes), 0) AS bytes FROM resume_uploads WHERE owner_id = $1',
          [ownerId],
        );
        if (
          Number(usage.rows[0]!.count) >= 50 ||
          Number(usage.rows[0]!.bytes) + metadata.bytes > 100 * 1024 * 1024
        ) {
          throw new ResumeStorageLimit('Resume storage limit reached');
        }
      }
      const inserted = await client.query<ResumeUploadRecord>(
        `INSERT INTO resume_uploads (id, owner_id, idempotency_key, bucket, sha256, bytes, content_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (owner_id, idempotency_key) DO NOTHING RETURNING ${columns}`,
        [randomUUID(), ownerId, key, bucket, metadata.sha256, metadata.bytes, metadata.contentType],
      );
      let record = inserted.rows[0];
      if (!record) {
        const existing = await client.query<ResumeUploadRecord>(
          `SELECT ${columns} FROM resume_uploads WHERE owner_id = $1 AND idempotency_key = $2`,
          [ownerId, key],
        );
        record = existing.rows[0];
        if (
          !record ||
          record.bucket !== bucket ||
          record.sha256 !== metadata.sha256 ||
          record.bytes !== metadata.bytes ||
          record.contentType !== metadata.contentType
        ) {
          throw new Conflict('Upload idempotency key reused with different metadata');
        }
      }
      await client.query('COMMIT');
      return record;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteSettled(
    ownerId: string,
    id: string,
    removeObject: (record: ResumeUploadRecord) => Promise<void>,
  ): Promise<boolean> {
    identifier.parse(ownerId);
    identifier.parse(id);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<ResumeUploadRecord>(
        `SELECT ${columns} FROM resume_uploads WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
        [ownerId, id],
      );
      const record = locked.rows[0];
      if (!record) {
        await client.query('ROLLBACK');
        return false;
      }
      const result = await client.query(
        'SELECT upload_id FROM resume_results WHERE owner_id = $1 AND upload_id = $2',
        [ownerId, id],
      );
      if (!result.rowCount) throw new Conflict('Resume processing has not settled');
      await removeObject(record);
      await client.query('DELETE FROM resume_results WHERE owner_id = $1 AND upload_id = $2', [
        ownerId,
        id,
      ]);
      await client.query('DELETE FROM resume_uploads WHERE owner_id = $1 AND id = $2', [
        ownerId,
        id,
      ]);
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async cancelUpload(
    ownerId: string,
    id: string,
    bucket: string,
    cancelObject: (record: ResumeUploadRecord) => Promise<void>,
  ): Promise<ResumeUploadRecord | null> {
    identifier.parse(ownerId);
    identifier.parse(id);
    bucketSchema.parse(bucket);
    const claimed = await this.database.pool.query<ResumeUploadRecord>(
      `UPDATE resume_uploads SET status = 'cancelling', updated_at = now()
       WHERE owner_id = $1 AND id = $2 AND bucket = $3 AND status IN ('uploading', 'cancelling')
       RETURNING ${columns}`,
      [ownerId, id, bucket],
    );
    const record = claimed.rows[0];
    if (!record) {
      const existing = await this.get(ownerId, id);
      if (!existing || (existing.status === 'cancelled' && existing.bucket === bucket))
        return existing;
      throw new Conflict('Upload cannot be cancelled');
    }
    await cancelObject(record);
    await this.database.pool.query(
      "UPDATE resume_uploads SET status = 'cancelled', updated_at = now() WHERE owner_id = $1 AND id = $2 AND status = 'cancelling'",
      [ownerId, id],
    );
    return this.get(ownerId, id);
  }

  async queueStoredUpload(
    ownerId: string,
    id: string,
    objectVersion: string,
    requestId?: string,
  ): Promise<ResumeUploadRecord | null> {
    identifier.parse(ownerId);
    identifier.parse(id);
    versionSchema.parse(objectVersion);
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query<ResumeUploadRecord>(
        `SELECT ${columns} FROM resume_uploads WHERE owner_id = $1 AND id = $2 FOR UPDATE`,
        [ownerId, id],
      );
      const record = locked.rows[0];
      if (!record) {
        await client.query('ROLLBACK');
        return null;
      }
      if (record.status === 'queued') {
        if (record.objectVersion !== objectVersion)
          throw new Conflict('Upload object version changed');
        await client.query('COMMIT');
        return record;
      }
      if (record.status !== 'uploading') throw new Conflict('Upload cancelled');
      const command: Command = {
        id: randomUUID(),
        type: 'resume.parse',
        version: 1,
        aggregateId: id,
        ownerId,
        occurredAt: new Date().toISOString(),
        // The HTTP request that caused this work, so an admin can reach the
        // parse execution from the upload request and back again.
        correlationId: requestId ?? id,
        causationId: id,
      };
      await client.query('INSERT INTO outbox_events (id, command) VALUES ($1, $2::jsonb)', [
        command.id,
        JSON.stringify(command),
      ]);
      const updated = await client.query<ResumeUploadRecord>(
        `UPDATE resume_uploads SET status = 'queued', object_version = $3, command_id = $4, updated_at = now()
         WHERE owner_id = $1 AND id = $2 RETURNING ${columns}`,
        [ownerId, id, objectVersion, command.id],
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

export type UploadStorage = Pick<
  ResumeObjectStore,
  'bucket' | 'initialize' | 'put' | 'get' | 'recoverVersion'
>;

export class InvalidResumeUpload extends Error {}

export class ResumeUploadCoordinator {
  private initialization: Promise<void> | undefined;

  constructor(
    private readonly uploads: ResumeUploadRepository,
    private readonly storage: UploadStorage,
  ) {}

  private async initialize(signal: AbortSignal) {
    this.initialization ??= this.storage.initialize(AbortSignal.timeout(15000)).catch((error) => {
      this.initialization = undefined;
      throw error;
    });
    await this.initialization;
    signal.throwIfAborted();
  }

  private object(record: ResumeUploadRecord): ResumeObject {
    if (record.bucket !== this.storage.bucket)
      throw new Conflict('Upload storage configuration changed');
    return {
      ownerId: record.ownerId,
      resumeId: record.id,
      sha256: record.sha256,
      bytes: record.bytes,
      contentType: record.contentType,
    };
  }

  async upload(
    ownerId: string,
    key: string,
    body: Uint8Array,
    signal?: AbortSignal,
    requestId?: string,
  ) {
    const deadline = AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]);
    deadline.throwIfAborted();
    identifier.parse(ownerId);
    keySchema.parse(key);
    if (body.byteLength === 0 || body.byteLength > maximumResumeBytes) {
      throw new InvalidResumeUpload('Resume must contain between 1 byte and 5 MiB');
    }
    const data = Buffer.from(body);
    const format = detectFormat(data);
    if (!format)
      throw new InvalidResumeUpload('Resume must have a PDF or DOCX container signature');
    const metadata = resumeUploadMetadataSchema.parse({
      sha256: createHash('sha256').update(data).digest('hex'),
      bytes: data.length,
      contentType:
        format === 'pdf'
          ? 'application/pdf'
          : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    const record = await this.uploads.reserve(ownerId, key, this.storage.bucket, metadata);
    if (record.status === 'queued') return record;
    if (record.status !== 'uploading') throw new Conflict('Upload cancelled');
    const object = this.object(record);
    await this.initialize(deadline);
    let version = await this.storage.recoverVersion(object, deadline);
    if (!version) {
      try {
        version = await this.storage.put(object, data, deadline);
      } catch (error) {
        deadline.throwIfAborted();
        version = await this.storage.recoverVersion(object, deadline);
        if (!version) throw error;
      }
    }
    await this.storage.get(object, version, deadline);
    deadline.throwIfAborted();
    return this.uploads.queueStoredUpload(ownerId, record.id, version, requestId);
  }

  async reconcile(ownerId: string, id: string, signal?: AbortSignal, requestId?: string) {
    const deadline = AbortSignal.any([AbortSignal.timeout(45_000), ...(signal ? [signal] : [])]);
    deadline.throwIfAborted();
    const record = await this.uploads.get(ownerId, id);
    if (!record || record.status !== 'uploading') return record;
    const object = this.object(record);
    await this.initialize(deadline);
    const version = await this.storage.recoverVersion(object, deadline);
    deadline.throwIfAborted();
    return version ? this.uploads.queueStoredUpload(ownerId, id, version, requestId) : record;
  }
}

export function resumeParseHandler(
  database: Database,
  storage: Pick<ResumeObjectStore, 'bucket' | 'get'>,
  parse: typeof parseResumeIsolated = parseResumeIsolated,
): Handler {
  const uploads = new ResumeUploadRepository(database);
  return async (command, fence, signal) => {
    signal.throwIfAborted();
    if (command.type !== 'resume.parse') throw new Conflict('Unsupported resume command');
    if (!isDeepStrictEqual(command, await database.command(command.id))) {
      throw new Conflict('Resume command does not match durable command');
    }
    const record = await uploads.get(command.ownerId, command.aggregateId);
    if (
      !record ||
      record.commandId !== command.id ||
      !record.objectVersion ||
      record.bucket !== storage.bucket
    ) {
      throw new Conflict('Resume command does not match stored upload');
    }
    const data = await storage.get(
      {
        ownerId: record.ownerId,
        resumeId: record.id,
        sha256: record.sha256,
        bytes: record.bytes,
        contentType: record.contentType,
      },
      record.objectVersion,
      signal,
    );
    let outcome: ResumeParseOutcome;
    try {
      const parsed = await parse(data, record.createdAt.getTime(), signal);
      if ((parsed.format === 'pdf') !== (record.contentType === 'application/pdf'))
        throw new ResumeDocumentError();
      outcome = { status: 'parsed', parsed };
    } catch (error) {
      if (!(error instanceof ResumeDocumentError)) throw error;
      outcome = { status: 'rejected', errorCode: 'invalid_document' };
    }
    signal.throwIfAborted();
    return uploads.settleParse(command, fence, outcome);
  };
}
