import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { errorCodes, isRetryable, type ErrorCode } from './errors.js';

export type AuditOutcome = 'allowed' | 'denied' | 'failed';

export interface AuditRecord {
  actorId: string;
  action: string;
  outcome: AuditOutcome;
  targetOwnerId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  requestId?: string | null;
  detail?: Record<string, string | number | boolean | null> | null;
}

export interface DiagnosticRecord {
  requestId?: string | null;
  ownerId?: string | null;
  runId?: string | null;
  executionId?: string | null;
  service: string;
  revision?: string | null;
  route?: string | null;
  method?: string | null;
  status: number;
  errorCode: ErrorCode;
  errorClass?: string | null;
  message: string;
  durationMs?: number | null;
}

// Results are always bounded. An admin surface that can be asked for
// "everything" is a denial-of-service endpoint and an exfiltration endpoint at
// the same time.
const maximumPageSize = 100;
const maximumRangeDays = 31;

export function boundedLimit(requested: unknown, fallback = 50) {
  const value = Number(requested);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), maximumPageSize);
}

export function boundedRange(from: unknown, to: unknown) {
  const end = to ? new Date(String(to)) : new Date();
  if (Number.isNaN(end.getTime())) throw new RangeError('Invalid range end');
  const earliest = new Date(end.getTime() - maximumRangeDays * 86_400_000);
  const start = from ? new Date(String(from)) : new Date(end.getTime() - 86_400_000);
  if (Number.isNaN(start.getTime())) throw new RangeError('Invalid range start');
  // Clamp rather than reject: an admin asking for too much gets the most they
  // are allowed, not an error they have to guess their way out of.
  return { start: start < earliest ? earliest : start, end };
}

export class AuditLog {
  constructor(private readonly pool: Pool) {}

  async record(entry: AuditRecord) {
    await this.pool.query(
      `INSERT INTO audit_events
       (id, actor_id, action, target_owner_id, target_type, target_id, request_id, outcome, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
      [
        randomUUID(),
        entry.actorId,
        entry.action,
        entry.targetOwnerId ?? null,
        entry.targetType ?? null,
        entry.targetId ?? null,
        entry.requestId ?? null,
        entry.outcome,
        entry.detail ? JSON.stringify(entry.detail) : null,
      ],
    );
  }

  async list(options: { limit?: unknown; from?: unknown; to?: unknown; actorId?: string }) {
    const { start, end } = boundedRange(options.from, options.to);
    const limit = boundedLimit(options.limit);
    const result = await this.pool.query(
      `SELECT id, sequence, actor_id AS "actorId", action, target_owner_id AS "targetOwnerId",
              target_type AS "targetType", target_id AS "targetId", request_id AS "requestId",
              outcome, detail, created_at AS "createdAt"
       FROM audit_events
       WHERE created_at BETWEEN $1 AND $2 AND ($3::uuid IS NULL OR actor_id = $3)
       ORDER BY sequence DESC LIMIT $4`,
      [start, end, options.actorId ?? null, limit],
    );
    return result.rows;
  }
}

export class Diagnostics {
  constructor(private readonly pool: Pool) {}

  // Never allowed to fail a request. A diagnostic that takes down the response
  // it was describing is worse than no diagnostic.
  async record(entry: DiagnosticRecord): Promise<string | null> {
    const id = randomUUID();
    try {
      await this.pool.query(
        `INSERT INTO error_diagnostics
         (id, request_id, owner_id, run_id, execution_id, service, revision, route, method,
          status, error_code, error_class, message, retryable, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          id,
          entry.requestId ?? null,
          entry.ownerId ?? null,
          entry.runId ?? null,
          entry.executionId ?? null,
          entry.service,
          entry.revision ?? null,
          entry.route ?? null,
          entry.method ?? null,
          entry.status,
          entry.errorCode,
          entry.errorClass ?? null,
          entry.message.slice(0, 1024),
          isRetryable(entry.errorCode),
          entry.durationMs ?? null,
        ],
      );
      return id;
    } catch {
      return null;
    }
  }

  async search(options: {
    ownerId?: string;
    requestId?: string;
    errorCode?: string;
    from?: unknown;
    to?: unknown;
    limit?: unknown;
  }) {
    const { start, end } = boundedRange(options.from, options.to);
    const code =
      options.errorCode && (errorCodes as readonly string[]).includes(options.errorCode)
        ? options.errorCode
        : null;
    const result = await this.pool.query(
      `SELECT id, request_id AS "requestId", owner_id AS "ownerId", run_id AS "runId",
              execution_id AS "executionId", service, revision, route, method, status,
              error_code AS "errorCode", error_class AS "errorClass", message, retryable,
              duration_ms AS "durationMs", created_at AS "createdAt"
       FROM error_diagnostics
       WHERE created_at BETWEEN $1 AND $2
         AND ($3::uuid IS NULL OR owner_id = $3)
         AND ($4::uuid IS NULL OR request_id = $4)
         AND ($5::text IS NULL OR error_code = $5)
       ORDER BY created_at DESC LIMIT $6`,
      [
        start,
        end,
        options.ownerId ?? null,
        options.requestId ?? null,
        code,
        boundedLimit(options.limit),
      ],
    );
    return result.rows;
  }
}

export interface TimelineEntry {
  at: string;
  operation: string;
  status: string | null;
  correlation: Record<string, string | null>;
  errorCode: string | null;
  durationMs: number | null;
}

export class AdminRepository {
  constructor(private readonly pool: Pool) {}

  // Identification only. The email is the minimum representation that lets an
  // admin confirm they are looking at the right account; nothing else about the
  // account is returned here.
  async findUser(term: string) {
    const result = await this.pool.query(
      `SELECT id, email, is_admin AS "isAdmin", created_at AS "createdAt"
       FROM users WHERE id::text = $1 OR lower(email) = lower($1) LIMIT 1`,
      [term],
    );
    return result.rows[0] ?? null;
  }

  // The timeline is composed from the domain tables that already record what
  // happened, rather than from a parallel event log that could disagree with
  // them. Every branch is filtered by owner_id in SQL, so a caller cannot widen
  // the scope by passing a different identifier.
  async timeline(ownerId: string, options: { from?: unknown; to?: unknown; limit?: unknown }) {
    const { start, end } = boundedRange(options.from, options.to);
    const limit = boundedLimit(options.limit);
    const result = await this.pool.query(
      `
      WITH entries AS (
        SELECT created_at AS at, 'search.created' AS operation, status,
               id::text AS run_id, NULL::text AS execution_id, NULL::text AS error_code
        FROM search_runs WHERE owner_id = $1
        UNION ALL
        SELECT created_at, 'run.' || type, NULL,
               run_id::text, NULL, NULL
        FROM run_events WHERE owner_id = $1
        UNION ALL
        SELECT created_at, 'resume.upload', status,
               NULL, command_id::text, NULL
        FROM resume_uploads WHERE owner_id = $1
        UNION ALL
        SELECT created_at, 'resume.result', status,
               NULL, command_id::text, error_code
        FROM resume_results WHERE owner_id = $1
        UNION ALL
        SELECT created_at, 'lead.revision.' || status, status,
               NULL, NULL, NULL
        FROM lead_history WHERE owner_id = $1
        UNION ALL
        SELECT created_at, 'error.' || error_code, status::text,
               run_id::text, execution_id::text, error_code
        FROM error_diagnostics WHERE owner_id = $1
      )
      SELECT at, operation, status, run_id AS "runId", execution_id AS "executionId",
             error_code AS "errorCode"
      FROM entries WHERE at BETWEEN $2 AND $3
      ORDER BY at DESC LIMIT $4`,
      [ownerId, start, end, limit],
    );
    return result.rows;
  }

  async run(ownerId: string, runId: string) {
    const result = await this.pool.query(
      `SELECT run.id, run.status, run.created_at AS "createdAt", run.profile_revision AS "profileRevision",
              run.source_outcomes AS "sourceOutcomes",
              execution.id AS "executionId", execution.status AS "executionStatus",
              execution.fence, execution.attempts, execution.lease_until AS "leaseUntil",
              outbox.created_at AS "commandCreatedAt", outbox.published_at AS "publishedAt",
              outbox.command ->> 'correlationId' AS "requestId",
              (SELECT count(*) FROM search_jobs job WHERE job.run_id = run.id AND job.owner_id = $1) AS "jobCount"
       FROM search_runs run
       LEFT JOIN outbox_events outbox ON outbox.command ->> 'aggregateId' = run.id::text
       LEFT JOIN command_executions execution ON execution.id = outbox.id
       WHERE run.owner_id = $1 AND run.id = $2`,
      [ownerId, runId],
    );
    return result.rows[0] ?? null;
  }

  // Resolves any correlation identifier back to the work it produced, which is
  // the lookup an admin actually starts from when a user quotes a reference.
  async byRequestId(ownerId: string, requestId: string) {
    const [runs, diagnostics] = await Promise.all([
      this.pool.query(
        `SELECT run.id AS "runId", run.status, run.created_at AS "createdAt"
         FROM search_runs run
         JOIN outbox_events outbox ON outbox.command ->> 'aggregateId' = run.id::text
         WHERE run.owner_id = $1 AND outbox.command ->> 'correlationId' = $2
         LIMIT 20`,
        [ownerId, requestId],
      ),
      this.pool.query(
        `SELECT id, status, error_code AS "errorCode", route, method, created_at AS "createdAt"
         FROM error_diagnostics WHERE owner_id = $1 AND request_id = $2 LIMIT 20`,
        [ownerId, requestId],
      ),
    ]);
    return { runs: runs.rows, diagnostics: diagnostics.rows };
  }

  // Counts and ages only. Nothing here reveals another owner's content.
  async overview() {
    const result = await this.pool.query(`
      SELECT
        (SELECT count(*) FROM outbox_events WHERE published_at IS NULL) AS "outboxUnpublished",
        (SELECT extract(epoch FROM now() - min(created_at))::int FROM outbox_events WHERE published_at IS NULL) AS "oldestUnpublishedSeconds",
        (SELECT count(*) FROM command_executions WHERE status = 'running') AS "executionsRunning",
        (SELECT extract(epoch FROM now() - min(lease_until))::int FROM command_executions WHERE status = 'running') AS "oldestRunningSeconds",
        (SELECT count(*) FROM command_executions WHERE status = 'dead-lettered') AS "deadLettered",
        (SELECT count(*) FROM search_runs WHERE status IN ('queued', 'running')) AS "activeSearches",
        (SELECT count(*) FROM resume_uploads WHERE status = 'uploading') AS "uploadsInFlight",
        (SELECT count(*) FROM error_diagnostics WHERE created_at > now() - interval '1 hour') AS "recentErrors",
        (SELECT count(*) FROM users) AS "users",
        (SELECT count(*) FROM sessions WHERE expires_at > now()) AS "activeSessions"
    `);
    return result.rows[0];
  }
}
