/**
 * Rebuilds `job_sightings` from `search_jobs`, the append-only ledger of every
 * job this app has ever actually stored.
 *
 * Why this exists (CS-28): before this fix, a fingerprint was title+company+
 * location alone, so a company running two genuinely different reqs with the
 * same title in the same city collapsed into one `search_jobs` row per run,
 * and `job_sightings` inherited that false merge as "one role, seen many
 * times" — inflating `sightings`/`repostCount` and the `persistent`/
 * `long_open` signals derived from them. Collection now keeps such reqs
 * apart (see `resolveFingerprintGroup` in `@job-radar/providers`), but the
 * `job_sightings` rows written under the old rule are stale: they were
 * accumulated incrementally, under a fingerprint definition that has since
 * changed, and nothing recomputes them on its own.
 *
 * This script discards that accumulated state and rebuilds it in one pass by
 * replaying `search_jobs` ordered by the parent search run's creation time,
 * reproducing `Database.settle()`'s same accumulation logic (see
 * `packages/core/src/database.ts`) over that ordering. `search_jobs` is the
 * source of truth being replayed here, not `job_sightings` itself.
 *
 * Ordering caveat (Independent Reviewer finding CS28-2): run creation time is
 * the best signal available without a dedicated per-job insert timestamp
 * (`search_jobs` has none), but it is not a guarantee of actual commit order.
 * Under redelivery/retry (`command_executions.attempts`), a run created
 * earlier can have its `settle()` commit later than a run created after it.
 * Since `sightings`/`repost_count`/`last_seen_at` accumulation is an
 * order-sensitive fold, not an associative reduction, a fingerprint touched
 * by such a reordering could replay to slightly different final counts than
 * the live incremental upsert actually produced - a precision gap in the
 * recompute, not a correctness break: the set of distinct postings recovered
 * (the actual point of CS-28) is unaffected, only the exact evidence numbers
 * for the rare fingerprint whose runs were reordered by a retry. Recorded in
 * docs/KNOWN-LIMITATIONS.md.
 *
 * Known, disclosed limitation: `search_jobs.data` never retained the board's
 * own per-posting id (`sourceJobId`) until this same change added it to the
 * schema. A req that was already merged away by the *old* fingerprint before
 * that field existed cannot be un-merged retroactively — the record of the
 * second, distinct posting was never written to `search_jobs` in the first
 * place (the in-memory dedup pass dropped it before storage). This script
 * therefore corrects drift and stops trusting stale incremental state; it
 * does not, and cannot, recover a historical false merge that predates
 * `sourceJobId` being stored. Every *future* split is captured going
 * forward because the disambiguated fingerprint is what collection now
 * writes to `search_jobs` in the first place.
 *
 * Should run with no concurrent search collection in flight (e.g. during a
 * deploy, as with `db:migrate`). Under REPEATABLE READ, a concurrent
 * `settle()` write to a row already in this transaction's snapshot causes
 * Postgres to abort this transaction with a serialization failure - a loud,
 * safe-to-retry failure, not silent data loss; a write to a fingerprint not
 * yet in the snapshot is simply left untouched. Still best run without
 * concurrent writers so a retry is never needed.
 *
 * Idempotent: re-running it is always safe and reproduces the same result
 * from whatever `search_jobs` currently contains.
 */

import { Database } from '../packages/core/src/database.js';

interface HistoryRow {
  ownerId: string;
  fingerprint: string;
  title: string;
  company: string;
  postedAt: string | null;
  runId: string;
  runCreatedAt: string;
}

interface Aggregate {
  ownerId: string;
  fingerprint: string;
  title: string;
  company: string;
  firstSeenAt: string;
  lastSeenAt: string;
  sightings: number;
  firstPostedAt: string | null;
  lastPostedAt: string | null;
  repostCount: number;
  lastRunId: string;
}

/** Faithfully replays the same accumulation `Database.settle()` performs on
 * every insert, in the order the runs actually happened. */
export function replay(rows: readonly HistoryRow[]): Map<string, Aggregate> {
  const rebuilt = new Map<string, Aggregate>();
  for (const row of rows) {
    const key = `${row.ownerId}:${row.fingerprint}`;
    const existing = rebuilt.get(key);
    if (!existing) {
      rebuilt.set(key, {
        ownerId: row.ownerId,
        fingerprint: row.fingerprint,
        title: row.title,
        company: row.company,
        firstSeenAt: row.runCreatedAt,
        lastSeenAt: row.runCreatedAt,
        sightings: 1,
        firstPostedAt: row.postedAt,
        lastPostedAt: row.postedAt,
        repostCount: 0,
        lastRunId: row.runId,
      });
      continue;
    }
    existing.lastSeenAt = row.runCreatedAt;
    existing.sightings += 1;
    existing.title = row.title;
    existing.company = row.company;
    existing.lastRunId = row.runId;
    // A posting that comes back claiming a newer date is the same role
    // refreshed, not a new one — mirrors the CASE in the live upsert.
    if (
      row.postedAt !== null &&
      existing.lastPostedAt !== null &&
      Date.parse(row.postedAt) > Date.parse(existing.lastPostedAt)
    ) {
      existing.repostCount += 1;
    }
    existing.lastPostedAt = row.postedAt ?? existing.lastPostedAt;
  }
  return rebuilt;
}

/** Result of one rebuild pass, for logging or test assertions. */
export interface RebuildSummary {
  before: number;
  historicalPostings: number;
  rebuiltRows: number;
}

/**
 * Replaces the entire contents of `job_sightings` with a fresh replay of
 * `search_jobs`, inside one transaction. Takes an already-connected
 * `Database` so it can be reused both by the CLI entry point below and by
 * integration tests against a throwaway database.
 */
export async function rebuildJobSightings(database: Database): Promise<RebuildSummary> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    // Repeatable read: the history this transaction replays and the table it
    // rebuilds must reflect one consistent snapshot, not one that a
    // concurrent write could half-update partway through.
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const { rows } = await client.query<HistoryRow>(
      `SELECT j.owner_id AS "ownerId", j.fingerprint,
              j.data->>'title' AS title, j.data->>'company' AS company,
              j.data->>'postedAt' AS "postedAt",
              j.run_id AS "runId", s.created_at AS "runCreatedAt"
       FROM search_jobs j
       JOIN search_runs s ON s.id = j.run_id
       ORDER BY j.owner_id, j.fingerprint, s.created_at ASC, j.id ASC`,
    );
    const rebuilt = replay(rows);
    const before = await client.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM job_sightings',
    );
    await client.query('DELETE FROM job_sightings');
    for (const agg of rebuilt.values()) {
      await client.query(
        `INSERT INTO job_sightings
           (owner_id, fingerprint, title, company, first_seen_at, last_seen_at,
            sightings, first_posted_at, last_posted_at, repost_count, last_run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          agg.ownerId,
          agg.fingerprint,
          agg.title,
          agg.company,
          agg.firstSeenAt,
          agg.lastSeenAt,
          agg.sightings,
          agg.firstPostedAt,
          agg.lastPostedAt,
          agg.repostCount,
          agg.lastRunId,
        ],
      );
    }
    await client.query('COMMIT');
    return {
      before: Number(before.rows[0]!.n),
      historicalPostings: rows.length,
      rebuiltRows: rebuilt.size,
    };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const database = new Database(process.env.DATABASE_URL!);
  try {
    const summary = await rebuildJobSightings(database);
    process.stdout.write(
      `job_sightings rebuilt from search_jobs: ${summary.before} row(s) replaced with ` +
        `${summary.rebuiltRows} row(s) derived from ${summary.historicalPostings} historical posting(s).\n`,
    );
  } finally {
    await database.close();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
