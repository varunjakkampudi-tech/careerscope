import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { errorCodes, errorFingerprint, isRetryable, type ErrorCode } from './errors.js';

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

  async list(options: {
    limit?: unknown;
    from?: unknown;
    to?: unknown;
    actorId?: string;
    prefix?: string;
  }) {
    const { start, end } = boundedRange(options.from, options.to);
    const limit = boundedLimit(options.limit);
    const result = await this.pool.query(
      `SELECT id, sequence, actor_id AS "actorId", action, target_owner_id AS "targetOwnerId",
              target_type AS "targetType", target_id AS "targetId", request_id AS "requestId",
              outcome, detail, created_at AS "createdAt"
       FROM audit_events
       WHERE created_at BETWEEN $1 AND $2
         AND ($3::uuid IS NULL OR actor_id = $3)
         AND ($4::text IS NULL OR action LIKE $4 || '%')
       ORDER BY sequence DESC LIMIT $5`,
      [start, end, options.actorId ?? null, options.prefix ?? null, limit],
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
    const fingerprint = errorFingerprint(entry);
    try {
      await this.pool.query(
        `INSERT INTO error_diagnostics
         (id, request_id, owner_id, run_id, execution_id, service, revision, route, method,
          status, error_code, fingerprint, error_class, message, retryable, duration_ms)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
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
          fingerprint,
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
    fingerprint?: string;
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
              error_code AS "errorCode", fingerprint, error_class AS "errorClass", message,
              retryable, duration_ms AS "durationMs", created_at AS "createdAt"
       FROM error_diagnostics
       WHERE created_at BETWEEN $1 AND $2
         AND ($3::uuid IS NULL OR owner_id = $3)
         AND ($4::uuid IS NULL OR request_id = $4)
         AND ($5::text IS NULL OR error_code = $5)
         AND ($6::text IS NULL OR fingerprint = $6)
       ORDER BY created_at DESC LIMIT $7`,
      [
        start,
        end,
        options.ownerId ?? null,
        options.requestId ?? null,
        code,
        options.fingerprint ?? null,
        boundedLimit(options.limit),
      ],
    );
    return result.rows;
  }

  // The "is this new, and who else is hitting it" question. Counts and distinct
  // owner counts only -- never the owners themselves, so reading the summary
  // does not amount to reading a list of affected accounts.
  async fingerprints(options: { from?: unknown; to?: unknown; limit?: unknown }) {
    const { start, end } = boundedRange(options.from, options.to);
    const result = await this.pool.query(
      `SELECT fingerprint, error_code AS "errorCode", service, route, method,
              count(*)::int AS occurrences,
              count(DISTINCT owner_id)::int AS "affectedOwners",
              count(DISTINCT run_id)::int AS "affectedRuns",
              count(DISTINCT revision)::int AS "affectedRevisions",
              min(created_at) AS "firstSeen",
              max(created_at) AS "lastSeen",
              (array_agg(id ORDER BY created_at DESC))[1] AS "latestId"
       FROM error_diagnostics
       WHERE created_at BETWEEN $1 AND $2
       GROUP BY fingerprint, error_code, service, route, method
       ORDER BY max(created_at) DESC LIMIT $3`,
      [start, end, boundedLimit(options.limit)],
    );
    return result.rows;
  }

  // Diagnostic evidence, not proof. Two revisions differing in error count can
  // have any number of causes; the caller is told what was observed.
  async byRevision(options: { from?: unknown; to?: unknown }) {
    const { start, end } = boundedRange(options.from, options.to);
    const result = await this.pool.query(
      `SELECT coalesce(revision, 'unknown') AS revision, error_code AS "errorCode",
              count(*)::int AS occurrences, min(created_at) AS "firstSeen", max(created_at) AS "lastSeen"
       FROM error_diagnostics
       WHERE created_at BETWEEN $1 AND $2
       GROUP BY coalesce(revision, 'unknown'), error_code
       ORDER BY occurrences DESC LIMIT 100`,
      [start, end],
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

// Splits the wall-clock time of one run into the phases that can each be slow
// for different reasons. A search that took 40 seconds because the publisher
// was backed up is a different problem from one that took 40 seconds inside a
// provider, and the two are indistinguishable without this.
export interface TraceSpan {
  operation: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  status: string | null;
  detail: Record<string, unknown> | null;
}

export class TraceRepository {
  constructor(private readonly pool: Pool) {}

  async trace(ownerId: string, runId: string) {
    const { rows } = await this.pool.query(
      `SELECT run.id, run.status, run.created_at AS "runCreatedAt", run.source_outcomes AS "sourceOutcomes",
              outbox.id AS "commandId", outbox.created_at AS "outboxCreatedAt",
              outbox.published_at AS "publishedAt",
              outbox.command ->> 'correlationId' AS "requestId",
              execution.status AS "executionStatus", execution.fence, execution.attempts,
              execution.started_at AS "executionStartedAt", execution.finished_at AS "executionFinishedAt",
              execution.lease_until AS "leaseUntil", execution.worker
       FROM search_runs run
       LEFT JOIN outbox_events outbox ON outbox.command ->> 'aggregateId' = run.id::text
       LEFT JOIN command_executions execution ON execution.id = outbox.id
       WHERE run.owner_id = $1 AND run.id = $2`,
      [ownerId, runId],
    );
    const row = rows[0];
    if (!row) return null;

    const at = (value: unknown) => (value ? new Date(value as string) : null);
    const gap = (from: Date | null, to: Date | null) =>
      from && to ? Math.max(0, to.getTime() - from.getTime()) : null;

    const created = at(row.runCreatedAt);
    const published = at(row.publishedAt);
    const started = at(row.executionStartedAt);
    const finished = at(row.executionFinishedAt);

    const spans: TraceSpan[] = [
      {
        operation: 'outbox.pending',
        startedAt: created?.toISOString() ?? null,
        endedAt: published?.toISOString() ?? null,
        durationMs: gap(created, published),
        status: published ? 'published' : 'pending',
        detail: { commandId: row.commandId },
      },
      {
        operation: 'queue.delivery',
        startedAt: published?.toISOString() ?? null,
        endedAt: started?.toISOString() ?? null,
        durationMs: gap(published, started),
        status: started ? 'delivered' : 'waiting',
        detail: { attempts: row.attempts },
      },
      {
        operation: 'worker.execution',
        startedAt: started?.toISOString() ?? null,
        endedAt: finished?.toISOString() ?? null,
        durationMs: gap(started, finished),
        status: row.executionStatus,
        detail: { worker: row.worker, fence: row.fence },
      },
    ];

    // Provider spans have no independent timestamps; their outcomes are recorded
    // as part of the run. They are reported as outcomes rather than dressed up
    // with invented start and end times.
    for (const outcome of (row.sourceOutcomes as Array<Record<string, unknown>> | null) ?? []) {
      spans.push({
        operation: `provider.${String(outcome.source)}`,
        startedAt: null,
        endedAt: null,
        durationMs: null,
        status: String(outcome.status ?? 'unknown'),
        detail: {
          accepted: outcome.accepted ?? null,
          limited: outcome.limited ?? null,
          errorCode: outcome.errorCode ?? null,
        },
      });
    }

    return {
      runId: row.id,
      requestId: row.requestId,
      status: row.status,
      worker: row.worker,
      spans,
      observations: observe(spans, row.executionStatus, at(row.leaseUntil), finished),
    };
  }
}

// Deterministic statements about what the timings show. Each is labelled
// OBSERVED because a measurement is evidence, not a diagnosis; anything that
// would require inference is phrased as a possibility and nothing is asserted
// as the root cause.
function observe(
  spans: TraceSpan[],
  executionStatus: string | null,
  leaseUntil: Date | null,
  finished: Date | null,
): Array<{ kind: 'OBSERVED' | 'POSSIBLE CAUSE'; message: string }> {
  const notes: Array<{ kind: 'OBSERVED' | 'POSSIBLE CAUSE'; message: string }> = [];
  const find = (operation: string) => spans.find((span) => span.operation === operation);

  const pending = find('outbox.pending')?.durationMs;
  if (pending !== null && pending !== undefined && pending > 5000) {
    notes.push({
      kind: 'OBSERVED',
      message: `Publication lagged the business transaction by ${(pending / 1000).toFixed(1)}s.`,
    });
  }
  const delivery = find('queue.delivery')?.durationMs;
  if (delivery !== null && delivery !== undefined && delivery > 5000) {
    notes.push({
      kind: 'OBSERVED',
      message: `Queue delivery to worker pickup took ${(delivery / 1000).toFixed(1)}s.`,
    });
  }
  if (executionStatus === 'running' && leaseUntil && leaseUntil < new Date() && !finished) {
    notes.push({
      kind: 'POSSIBLE CAUSE',
      message: 'The execution lease expired while still marked running; a worker may have died.',
    });
  }
  for (const span of spans) {
    if (span.operation.startsWith('provider.') && span.status === 'failed') {
      notes.push({
        kind: 'OBSERVED',
        message: `${span.operation} reported ${String(span.detail?.errorCode ?? 'failure')}.`,
      });
    }
  }
  return notes;
}

export class DebugSessions {
  constructor(private readonly pool: Pool) {}

  async start(input: {
    actorId: string;
    targetOwnerId?: string | null;
    reason: string;
    minutes: number;
  }) {
    // Capped so an investigation window cannot quietly become permanent.
    const minutes = Math.min(Math.max(Math.floor(input.minutes) || 15, 1), 120);
    const { rows } = await this.pool.query(
      `INSERT INTO debug_sessions (id, actor_id, target_owner_id, reason, expires_at)
       VALUES ($1, $2, $3, $4, now() + $5 * interval '1 minute')
       RETURNING id, started_at AS "startedAt", expires_at AS "expiresAt"`,
      [
        randomUUID(),
        input.actorId,
        input.targetOwnerId ?? null,
        input.reason.slice(0, 500),
        minutes,
      ],
    );
    return rows[0];
  }

  async end(actorId: string, id: string) {
    const { rows } = await this.pool.query(
      `UPDATE debug_sessions SET ended_at = now()
       WHERE id = $1 AND actor_id = $2 AND ended_at IS NULL
       RETURNING id, ended_at AS "endedAt"`,
      [id, actorId],
    );
    return rows[0] ?? null;
  }

  // Expiry is evaluated on read rather than by a sweeper, so a session cannot
  // outlive its window just because a cleanup job did not run.
  async active() {
    const { rows } = await this.pool.query(
      `SELECT id, actor_id AS "actorId", target_owner_id AS "targetOwnerId", reason,
              started_at AS "startedAt", expires_at AS "expiresAt"
       FROM debug_sessions
       WHERE ended_at IS NULL AND expires_at > now()
       ORDER BY started_at DESC LIMIT 50`,
    );
    return rows;
  }
}
