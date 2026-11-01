/**
 * Postgres access for search runs and the command pipeline: creating and cancelling searches, the
 * transactional outbox, fenced leases for workers, and atomic completion. Used by the API (create,
 * cancel, read) and the search worker (claim, renew, settle). Schema is in `schema.ts`.
 */

import { rollback } from './rollback.js';
import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, or, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { DerivedResume } from '@careerscope/shared';
import { createSearchSchema, type Command, type CreateSearchInput } from './commands.js';
import * as tables from './schema.js';
import {
  collectedJobsSchema,
  collectionStatus,
  sourceOutcomesSchema,
  type SourceOutcome,
  type CollectedJobInput,
} from './jobs.js';
import { matchingProfile } from './profile.js';
import { logger } from './runtime.js';

import { Conflict } from './errors.js';
export { Conflict } from './errors.js';

const defaultStatementTimeoutMs = 10_000;
const defaultConnectionTimeoutMs = 5000;
/** Idle-in-transaction timeout is fixed; the statement override never changes it. */
const idleInTransactionTimeoutMs = 10_000;

/**
 * Per-statement and idle-transaction timeout from DATABASE_STATEMENT_TIMEOUT_MS. The default is 10
 * seconds; the integration suite raises it because shared hosts can be slow. In production an
 * override above the default is not honoured: it is capped at 10 seconds with a logged warning.
 * Throws unless the value is an integer from 1000 to 600000.
 */
/**
 * Pool connect timeout. Production keeps 5 seconds; the integration run and CI raise it through
 * DATABASE_CONNECT_TIMEOUT_MS because a freshly created database on a loaded host can be slow.
 */
export function resolveConnectionTimeoutMs(
  raw: string | undefined,
  deploymentEnvironment = 'development',
): number {
  if (!raw) return defaultConnectionTimeoutMs;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error('DATABASE_CONNECT_TIMEOUT_MS must be an integer from 1000 to 120000');
  }
  const value = Number(raw);
  if (value < 1000 || value > 120_000) {
    throw new Error('DATABASE_CONNECT_TIMEOUT_MS must be an integer from 1000 to 120000');
  }
  if (deploymentEnvironment === 'production' && value > defaultConnectionTimeoutMs) {
    logger.warn(
      { requested: value, applied: defaultConnectionTimeoutMs },
      'DATABASE_CONNECT_TIMEOUT_MS above the default is ignored in production',
    );
    return defaultConnectionTimeoutMs;
  }
  return value;
}

export function resolveStatementTimeoutMs(
  raw: string | undefined,
  deploymentEnvironment: string,
): number {
  if (!raw) return defaultStatementTimeoutMs;
  const value = Number(raw);
  if (!/^\d+$/.test(raw.trim()) || !Number.isInteger(value) || value < 1000 || value > 600_000) {
    throw new Error('DATABASE_STATEMENT_TIMEOUT_MS must be an integer from 1000 to 600000');
  }
  if (deploymentEnvironment === 'production' && value > defaultStatementTimeoutMs) {
    logger.warn(
      { requested: value, applied: defaultStatementTimeoutMs },
      'DATABASE_STATEMENT_TIMEOUT_MS above the default is ignored in production',
    );
    return defaultStatementTimeoutMs;
  }
  return value;
}

/**
 * Owns the connection pool (8 connections, statement and idle-in-transaction timeouts) and exposes
 * Drizzle as `db`. Multi-step state changes use explicit transactions on a dedicated client.
 */
export class Database {
  readonly pool: pg.Pool;
  readonly db;

  constructor(url: string) {
    // `||` so an empty DEPLOYMENT_ENVIRONMENT cannot bypass the production caps.
    const deploymentEnvironment =
      process.env.DEPLOYMENT_ENVIRONMENT ||
      (process.env.NODE_ENV === 'production' ? 'production' : 'development');
    const timeoutMs = resolveStatementTimeoutMs(
      process.env.DATABASE_STATEMENT_TIMEOUT_MS,
      deploymentEnvironment,
    );
    this.pool = new pg.Pool({
      connectionString: url,
      max: 8,
      connectionTimeoutMillis: resolveConnectionTimeoutMs(
        process.env.DATABASE_CONNECT_TIMEOUT_MS,
        deploymentEnvironment,
      ),
      statement_timeout: timeoutMs,
      idle_in_transaction_session_timeout: idleInTransactionTimeoutMs,
    });
    this.db = drizzle({ client: this.pool, schema: tables });
  }

  /**
   * Creates a queued run and its outbox command in one transaction, or returns the existing run for a
   * repeated idempotency `key`. The matching profile and latest parsed resume are snapshotted so
   * scoring stays consistent for the whole run. Throws `Conflict` if the key was reused with different
   * input, or if profile discovery is requested without saved target roles.
   */
  async createSearch(ownerId: string, key: string, input: CreateSearchInput) {
    // Parsed here even though the route parses too. `input` is the schema's input
    // type, where `origin` is optional; the stored `request` and the hash must
    // use the output type, so the request is canonicalised here instead of
    // trusting the caller:
    //   - `request` is stored and must always carry `origin`.
    //   - `requestHash` drives idempotency. `sources` is sorted by the schema,
    //     so two spellings of the same request hash the same and do not raise a
    //     false IDEMPOTENCY_KEY_REUSED conflict.
    // Re-parsing an already-parsed request changes nothing, so the API path is
    // unaffected.
    const request = createSearchSchema.parse(input);
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return this.db.transaction(async (transaction) => {
      const id = randomUUID();
      const [profile] = await transaction
        .select()
        .from(tables.profiles)
        .where(eq(tables.profiles.ownerId, ownerId))
        .limit(1);
      // Snapshotted alongside the rest of the profile: the most recent
      // successfully-parsed resume's derived skills/titles/years, or null when
      // none exists. The SQL itself projects only the `derived` sub-key of the
      // parsed JSONB document - the raw resume text in `parsed.text` never
      // leaves Postgres for this query, let alone this process.
      const [latestResume] = await transaction
        .select({
          derived: sql<DerivedResume | null>`${tables.resumeResults.parsed}->'derived'`,
        })
        .from(tables.resumeResults)
        .where(
          and(eq(tables.resumeResults.ownerId, ownerId), eq(tables.resumeResults.status, 'parsed')),
        )
        .orderBy(desc(tables.resumeResults.createdAt))
        .limit(1);
      const derivedResume = latestResume?.derived ?? null;
      const inserted = await transaction
        .insert(tables.searches)
        .values({
          id,
          ownerId,
          request,
          matchingProfile: profile ? matchingProfile(profile.data, derivedResume) : null,
          profileRevision: profile?.revision ?? null,
          requestHash,
          idempotencyKey: key,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted[0]) {
        const [existing] = await transaction
          .select()
          .from(tables.searches)
          .where(
            and(eq(tables.searches.ownerId, ownerId), eq(tables.searches.idempotencyKey, key)),
          );
        if (!existing || existing.requestHash !== requestHash)
          throw new Conflict(
            'Idempotency key reused with different input',
            'IDEMPOTENCY_KEY_REUSED',
          );
        return existing;
      }
      if (
        request.useProfileTitles &&
        !inserted[0].matchingProfile?.preferences.titles.some(
          (title) => title.trim().length >= 2 && title.trim().length <= 160,
        )
      )
        throw new Conflict(
          'Save target roles before starting profile discovery',
          'MISSING_TARGET_ROLES',
        );
      const command: Command = {
        id: randomUUID(),
        type: 'search.collect',
        version: 1,
        aggregateId: id,
        ownerId,
        occurredAt: new Date().toISOString(),
        correlationId: id,
      };
      await transaction.insert(tables.outbox).values({ id: command.id, command });
      await transaction
        .insert(tables.events)
        .values({ id: randomUUID(), runId: id, ownerId, type: 'SearchQueued' });
      return inserted[0];
    });
  }

  /** The run if it belongs to `ownerId`, otherwise undefined; ownership is part of the query. */
  async getSearch(ownerId: string, id: string) {
    return this.db.query.searches.findFirst({
      where: and(eq(tables.searches.ownerId, ownerId), eq(tables.searches.id, id)),
    });
  }

  /**
   * Cancels a queued or running search owned by `ownerId`. In one transaction it marks the command
   * execution completed and bumps its fence, so a worker still holding the old fence cannot settle,
   * then sets the run to `cancelled`. Returns the current run, or undefined if not owned.
   */
  async cancelSearch(ownerId: string, id: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const owned = await client.query(
        'SELECT id FROM search_runs WHERE id = $1 AND owner_id = $2',
        [id, ownerId],
      );
      if (!owned.rowCount) {
        await rollback(client);
        return undefined;
      }
      const commands = await client.query<{ id: string }>(
        `SELECT id FROM outbox_events WHERE command->>'aggregateId' = $1
        AND command->>'ownerId' = $2 AND command->>'type' = 'search.collect'`,
        [id, ownerId],
      );
      if (commands.rows.length !== 1) throw new Conflict('Search command missing');
      await client.query(
        `INSERT INTO command_executions (id, status, fence, attempts, lease_until)
        VALUES ($1, 'completed', 1, 0, now())
        ON CONFLICT (id) DO UPDATE SET status = 'completed',
          fence = command_executions.fence + 1, lease_until = now()
        WHERE command_executions.status = 'running'`,
        [commands.rows[0]!.id],
      );
      const updated = await client.query(
        `UPDATE search_runs SET status = 'cancelled'
        WHERE id = $1 AND owner_id = $2 AND status IN ('queued', 'running') RETURNING id`,
        [id, ownerId],
      );
      if (!updated.rowCount) {
        await rollback(client);
        return this.getSearch(ownerId, id);
      }
      await client.query(
        `INSERT INTO run_events (id, run_id, owner_id, type) VALUES ($1, $2, $3, 'SearchCancelled')`,
        [randomUUID(), id, ownerId],
      );
      await client.query('COMMIT');
      return this.getSearch(ownerId, id);
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Outbox rows the publisher should send: never published, or published more than two minutes ago
   * with no execution that is finished or still leased (a lost or dropped message). Oldest first, 20 at a time.
   */
  async unpublished(types?: readonly Command['type'][]) {
    if (types?.length === 0) return [];
    return this.db
      .select()
      .from(tables.outbox)
      .where(
        and(
          types ? inArray(sql<string>`${tables.outbox.command}->>'type'`, [...types]) : undefined,
          or(
            isNull(tables.outbox.publishedAt),
            and(
              lt(tables.outbox.publishedAt, new Date(Date.now() - 120_000)),
              sql`NOT EXISTS (SELECT 1 FROM command_executions WHERE command_executions.id = ${tables.outbox.id}
        AND (status IN ('completed', 'failed') OR lease_until > now()))`,
            ),
          ),
        ),
      )
      .orderBy(tables.outbox.createdAt)
      .limit(20);
  }

  /**
   * Operational backlog signal: durable work waiting to be published, work
   * currently leased, and leases that expired without settling. Expired leases
   * are redelivered, but a persistent count means execution is not progressing.
   */
  async backlog() {
    const { rows } = await this.pool.query<{
      unpublished: string;
      running: string;
      expired: string;
      oldest_seconds: string | null;
      oldest_running_seconds: string | null;
    }>(
      `SELECT
         count(*) FILTER (WHERE o.published_at IS NULL) AS unpublished,
         count(*) FILTER (WHERE e.status = 'running') AS running,
         count(*) FILTER (WHERE e.status = 'running' AND e.lease_until < now()) AS expired,
         max(extract(epoch FROM now() - o.created_at)) FILTER (WHERE o.published_at IS NULL)
           AS oldest_seconds,
         max(extract(epoch FROM now() - o.created_at)) FILTER (WHERE e.status = 'running')
           AS oldest_running_seconds
       FROM outbox_events o
       LEFT JOIN command_executions e ON e.id = o.id`,
    );
    const row = rows[0];
    return {
      unpublished: Number(row?.unpublished ?? 0),
      running: Number(row?.running ?? 0),
      expiredLeases: Number(row?.expired ?? 0),
      oldestUnpublishedSeconds: row?.oldest_seconds === null ? null : Number(row?.oldest_seconds),
      oldestRunningSeconds:
        row?.oldest_running_seconds == null ? null : Number(row.oldest_running_seconds),
    };
  }

  /** Marks an outbox row as sent. Publishing is at-least-once; consumers de-duplicate through fences. */
  async published(id: string) {
    await this.db
      .update(tables.outbox)
      .set({ publishedAt: new Date() })
      .where(eq(tables.outbox.id, id));
  }

  /**
   * The last `limit` recorded outcomes for one source, most recent first,
   * across every user - a source silently returning nothing is a job-board
   * change, not a per-user fact, so this looks system-wide rather than
   * scoping to whoever happened to run the search that noticed it.
   */
  async recentSourceStatuses(source: string, limit = 5): Promise<string[]> {
    const { rows } = await this.pool.query<{ status: string }>(
      `SELECT elem->>'status' AS status
       FROM search_runs, jsonb_array_elements(source_outcomes) elem
       WHERE source_outcomes IS NOT NULL AND elem->>'source' = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [source, limit],
    );
    return rows.map((row) => row.status);
  }

  /** The durable command for an id, used by consumers to check a queue message against stored state. */
  async command(id: string) {
    const record = await this.db.query.outbox.findFirst({ where: eq(tables.outbox.id, id) });
    return record?.command;
  }

  /** `running`, `completed` or `failed` for a command, or undefined if it has never been claimed. */
  async executionStatus(id: string) {
    const record = await this.db.query.executions.findFirst({
      where: eq(tables.executions.id, id),
    });
    return record?.status;
  }

  /** Extends the lease for the holder of `fence`. False means the lease expired or was taken over, so the caller must stop. */
  async renew(id: string, fence: number, leaseSeconds = 60) {
    const result = await this.pool.query(
      `UPDATE command_executions
      SET lease_until = now() + $3 * interval '1 second'
      WHERE id = $1 AND fence = $2 AND status = 'running' AND lease_until > now()
      RETURNING id`,
      [id, fence, leaseSeconds],
    );
    return result.rowCount === 1;
  }

  /** Expires the lease immediately so another worker can claim the command. Only the current fence holder has effect. */
  async release(id: string, fence: number) {
    await this.pool.query(
      `UPDATE command_executions SET lease_until = now()
      WHERE id = $1 AND fence = $2 AND status = 'running'`,
      [id, fence],
    );
  }

  /**
   * Takes the lease on a command. Returns the new fence (attempt counter), or null when the command
   * is already finished or another worker holds an unexpired lease. A takeover increments the fence,
   * which invalidates the previous holder's `renew` and `settle`.
   */
  async claim(id: string, leaseSeconds = 60): Promise<number | null> {
    const result = await this.pool.query<{ fence: number }>(
      `
      INSERT INTO command_executions (id, status, fence, lease_until, attempts)
      SELECT id, 'running', 1, now() + $2 * interval '1 second', 1
      FROM outbox_events WHERE id = $1
      ON CONFLICT (id) DO UPDATE SET fence = command_executions.fence + 1,
        attempts = command_executions.attempts + 1, status = 'running',
        lease_until = now() + $2 * interval '1 second'
      WHERE command_executions.status = 'running' AND command_executions.lease_until < now()
      RETURNING fence`,
      [id, leaseSeconds],
    );
    return result.rows[0]?.fence ?? null;
  }

  /** Moves the run from queued to running if `fence` still owns a live lease on this exact command. False if ownership was lost. */
  async startSearch(command: Command, fence: number): Promise<boolean> {
    if (command.type !== 'search.collect') throw new Conflict('Unsupported start type');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const owned = await client.query(
        `SELECT id FROM command_executions WHERE id = $1 AND fence = $2 AND status = 'running'
         AND lease_until > now() AND EXISTS (SELECT 1 FROM outbox_events WHERE id = $1 AND command = $3::jsonb)
         FOR UPDATE`,
        [command.id, fence, JSON.stringify(command)],
      );
      if (!owned.rowCount) {
        await rollback(client);
        return false;
      }
      const updated = await client.query(
        `UPDATE search_runs SET status = 'running' WHERE id = $1 AND owner_id = $2 AND status = 'queued' RETURNING id`,
        [command.aggregateId, command.ownerId],
      );
      if (updated.rowCount) {
        await client.query(
          "INSERT INTO run_events (id, run_id, owner_id, type) VALUES ($1, $2, $3, 'SearchStarted')",
          [randomUUID(), command.aggregateId, command.ownerId],
        );
      } else {
        const active = await client.query(
          "SELECT id FROM search_runs WHERE id = $1 AND owner_id = $2 AND status = 'running'",
          [command.aggregateId, command.ownerId],
        );
        if (!active.rowCount) throw new Conflict('Search cannot start');
      }
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Settles the command and stores jobs as `completed`. */
  async complete(
    command: Command,
    fence: number,
    jobs: CollectedJobInput[] = [],
  ): Promise<boolean> {
    return this.settle(command, fence, jobs, 'completed');
  }

  /** Settles the command as `failed` with no jobs. Returns false if the lease or fence was lost. */
  async fail(command: Command, fence: number) {
    return this.settle(command, fence, [], 'failed');
  }

  /**
   * Settles a run with per-source outcomes. Throws `Conflict` unless every job matches an outcome
   * that accepted jobs for its source. The run status (`completed`, `partial`, `failed`) is derived
   * from the outcomes.
   */
  async completeCollection(
    command: Command,
    fence: number,
    jobs: CollectedJobInput[],
    sourceOutcomes: SourceOutcome[],
  ) {
    const validated = collectedJobsSchema.parse(jobs);
    const outcomes = sourceOutcomesSchema.parse(sourceOutcomes);
    if (
      outcomes.some(
        (outcome) =>
          validated.filter((job) => job.source === outcome.source).length > outcome.accepted,
      ) ||
      validated.some(
        (job) => !outcomes.some((outcome) => outcome.source === job.source && outcome.accepted > 0),
      ) ||
      validated.some((job) =>
        job.sourceLinks?.some(
          (link) =>
            !outcomes.some((outcome) => outcome.source === link.source && outcome.accepted > 0),
        ),
      )
    )
      throw new Conflict('Jobs do not match source outcomes');
    return this.settle(command, fence, validated, collectionStatus(validated, outcomes), outcomes);
  }

  /**
   * Single completion path. One transaction checks the fence and live lease and that the stored
   * command is identical, updates the run, inserts jobs (idempotent per run and fingerprint),
   * upserts sightings and writes the run event. Returns false, changing nothing, if ownership was lost.
   */
  private async settle(
    command: Command,
    fence: number,
    jobs: CollectedJobInput[],
    status: 'completed' | 'partial' | 'failed',
    outcomes: SourceOutcome[] | null = null,
  ): Promise<boolean> {
    const validated = collectedJobsSchema.parse(jobs);
    if (command.type !== 'search.collect') throw new Conflict('Unsupported completion type');
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const owned = await client.query(
        `UPDATE command_executions SET status = $4
        WHERE id = $1 AND fence = $2 AND status = 'running' AND lease_until > now()
        AND EXISTS (SELECT 1 FROM outbox_events WHERE id = $1 AND command = $3::jsonb)
        RETURNING id`,
        // With outcomes the execution is always `completed`: the work finished, and `status` (which may be
        // `partial` or `failed`) describes the result on the run, not the execution.
        [command.id, fence, JSON.stringify(command), outcomes ? 'completed' : status],
      );
      if (!owned.rowCount) {
        await rollback(client);
        return false;
      }
      // The run only changes from queued or running, so a cancelled run is never overwritten. When
      // outcomes are given, the run's requested sources must equal the outcome sources exactly (each
      // contains the other), so a result for a different source set is refused.
      const updated = await client.query(
        `UPDATE search_runs SET status = $3, source_outcomes = $4::jsonb
        WHERE id = $1 AND owner_id = $2 AND status IN ('queued', 'running')
        AND ($5::jsonb IS NULL OR (request->'sources' @> $5::jsonb AND request->'sources' <@ $5::jsonb))
        RETURNING id`,
        [
          command.aggregateId,
          command.ownerId,
          status,
          outcomes ? JSON.stringify(outcomes) : null,
          outcomes ? JSON.stringify(outcomes.map((outcome) => outcome.source)) : null,
        ],
      );
      if (!updated.rowCount) throw new Conflict('Search is not eligible for completion');
      for (const job of validated) {
        await client.query(
          `INSERT INTO search_jobs (id, run_id, owner_id, fingerprint, data)
          VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (run_id, fingerprint) DO NOTHING`,
          [
            randomUUID(),
            command.aggregateId,
            command.ownerId,
            job.fingerprint,
            JSON.stringify(job),
          ],
        );
        // In the same transaction as the job itself: a sighting that could be
        // committed without its posting would be evidence of something that
        // never happened.
        await client.query(
          `INSERT INTO job_sightings
             (owner_id, fingerprint, title, company, first_posted_at, last_posted_at, last_run_id)
           VALUES ($1, $2, $3, $4, $5, $5, $6)
           ON CONFLICT (owner_id, fingerprint) DO UPDATE SET
             last_seen_at = now(),
             sightings = job_sightings.sightings + 1,
             title = EXCLUDED.title,
             company = EXCLUDED.company,
             last_posted_at = COALESCE(EXCLUDED.last_posted_at, job_sightings.last_posted_at),
             -- A posting that comes back claiming a newer date is the same role
             -- refreshed, not a new one. That is the signal worth counting.
             repost_count = job_sightings.repost_count + CASE
               WHEN EXCLUDED.last_posted_at IS NOT NULL
                AND job_sightings.last_posted_at IS NOT NULL
                AND EXCLUDED.last_posted_at > job_sightings.last_posted_at
               THEN 1 ELSE 0 END,
             last_run_id = EXCLUDED.last_run_id`,
          [
            command.ownerId,
            job.fingerprint,
            job.title,
            job.company,
            job.postedAt,
            command.aggregateId,
          ],
        );
      }
      await client.query(
        `INSERT INTO run_events (id, run_id, owner_id, type) VALUES ($1, $2, $3, $4)`,
        [
          randomUUID(),
          command.aggregateId,
          command.ownerId,
          status === 'completed'
            ? 'SearchCompleted'
            : status === 'partial'
              ? 'SearchPartial'
              : 'SearchFailed',
        ],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /** Closes the connection pool. */
  async close() {
    await this.pool.end();
  }
}
