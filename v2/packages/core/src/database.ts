import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, or, lt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Command, CreateSearch } from './commands.js';
import * as tables from './schema.js';
import { collectedJobsSchema, type CollectedJobInput } from './jobs.js';
import { matchingProfile } from './profile.js';

import { Conflict } from './errors.js';
export { Conflict } from './errors.js';

export class Database {
  readonly pool: pg.Pool;
  readonly db;

  constructor(url: string) {
    this.pool = new pg.Pool({
      connectionString: url,
      max: 8,
      connectionTimeoutMillis: 5000,
      statement_timeout: 10_000,
      idle_in_transaction_session_timeout: 10_000,
    });
    this.db = drizzle({ client: this.pool, schema: tables });
  }

  async createSearch(ownerId: string, key: string, request: CreateSearch) {
    const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return this.db.transaction(async (transaction) => {
      const id = randomUUID();
      const [profile] = await transaction
        .select()
        .from(tables.profiles)
        .where(eq(tables.profiles.ownerId, ownerId))
        .limit(1);
      const inserted = await transaction
        .insert(tables.searches)
        .values({
          id,
          ownerId,
          request,
          matchingProfile: profile ? matchingProfile(profile.data) : null,
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
          throw new Conflict('Idempotency key reused with different input');
        return existing;
      }
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

  async getSearch(ownerId: string, id: string) {
    return this.db.query.searches.findFirst({
      where: and(eq(tables.searches.ownerId, ownerId), eq(tables.searches.id, id)),
    });
  }

  async cancelSearch(ownerId: string, id: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const owned = await client.query(
        'SELECT id FROM search_runs WHERE id = $1 AND owner_id = $2',
        [id, ownerId],
      );
      if (!owned.rowCount) {
        await client.query('ROLLBACK');
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
        await client.query('ROLLBACK');
        return this.getSearch(ownerId, id);
      }
      await client.query(
        `INSERT INTO run_events (id, run_id, owner_id, type) VALUES ($1, $2, $3, 'SearchCancelled')`,
        [randomUUID(), id, ownerId],
      );
      await client.query('COMMIT');
      return this.getSearch(ownerId, id);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async unpublished() {
    return this.db
      .select()
      .from(tables.outbox)
      .where(
        or(
          isNull(tables.outbox.publishedAt),
          and(
            lt(tables.outbox.publishedAt, new Date(Date.now() - 120_000)),
            sql`NOT EXISTS (SELECT 1 FROM command_executions WHERE command_executions.id = ${tables.outbox.id}
        AND (status IN ('completed', 'failed') OR lease_until > now()))`,
          ),
        ),
      )
      .orderBy(tables.outbox.createdAt)
      .limit(20);
  }

  async published(id: string) {
    await this.db
      .update(tables.outbox)
      .set({ publishedAt: new Date() })
      .where(eq(tables.outbox.id, id));
  }

  async command(id: string) {
    const record = await this.db.query.outbox.findFirst({ where: eq(tables.outbox.id, id) });
    return record?.command;
  }

  async executionStatus(id: string) {
    const record = await this.db.query.executions.findFirst({
      where: eq(tables.executions.id, id),
    });
    return record?.status;
  }

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

  async release(id: string, fence: number) {
    await this.pool.query(
      `UPDATE command_executions SET lease_until = now()
      WHERE id = $1 AND fence = $2 AND status = 'running'`,
      [id, fence],
    );
  }

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

  async complete(
    command: Command,
    fence: number,
    jobs: CollectedJobInput[] = [],
  ): Promise<boolean> {
    return this.settle(command, fence, jobs, 'completed');
  }

  async fail(command: Command, fence: number) {
    return this.settle(command, fence, [], 'failed');
  }

  private async settle(
    command: Command,
    fence: number,
    jobs: CollectedJobInput[],
    status: 'completed' | 'failed',
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
        [command.id, fence, JSON.stringify(command), status],
      );
      if (!owned.rowCount) {
        await client.query('ROLLBACK');
        return false;
      }
      const updated = await client.query(
        `UPDATE search_runs SET status = $3
        WHERE id = $1 AND owner_id = $2 AND status IN ('queued', 'running') RETURNING id`,
        [command.aggregateId, command.ownerId, status],
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
      }
      await client.query(
        `INSERT INTO run_events (id, run_id, owner_id, type) VALUES ($1, $2, $3, $4)`,
        [
          randomUUID(),
          command.aggregateId,
          command.ownerId,
          status === 'completed' ? 'SearchCompleted' : 'SearchFailed',
        ],
      );
      await client.query('COMMIT');
      return true;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}
