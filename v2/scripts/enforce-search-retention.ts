/**
 * CS-27 (part 2 of 2): "search results have no retention."
 *
 * search_jobs carries no timestamp of its own (a known, separately-recorded
 * limitation - see docs/KNOWN-LIMITATIONS.md), so retention is enforced via
 * the parent search_runs.created_at instead: a job row belonging to a run
 * older than the retention window is deleted. saved_leads is untouched by
 * design - a lead stores its own independent data snapshot (saved_leads.data
 * is not a foreign key to search_jobs), so this never removes anything the
 * owner explicitly kept.
 *
 * Invoked by careerscope-retention.timer (host-native systemd, matching
 * CS-24/25/26) via `docker exec` into the api container.
 */
import { Database, configuration, logger } from '@careerscope/core';

const RETENTION_DAYS = Number(process.env.SEARCH_RETENTION_DAYS ?? 30);

export async function enforceRetention(
  database: Database,
  retentionDays: number,
): Promise<{ deletedJobs: number; deletedRuns: number }> {
  if (!Number.isFinite(retentionDays) || retentionDays < 1) {
    throw new Error(`Invalid retention window: ${retentionDays}`);
  }
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    // The single eligibility rule, applied identically everywhere below:
    // old enough, settled (never a still-queued/running run), and not
    // referenced by any unpublished or still-running outbox command. Using
    // one CTE for every delete below is deliberate - defining "old enough to
    // remove" twice is exactly how the jobs delete below once ran on a
    // looser rule than the runs delete and removed a still-in-flight run's
    // jobs out from under it.
    const eligibleRunsCte = `
      eligible_runs AS (
        SELECT r.id FROM search_runs r
        WHERE r.created_at < now() - ($1 || ' days')::interval
        AND r.status IN ('completed', 'partial', 'failed', 'cancelled')
        AND NOT EXISTS (
          SELECT 1 FROM outbox_events o
          LEFT JOIN command_executions e ON e.id = o.id
          WHERE o.command->>'aggregateId' = r.id::text
          AND (o.published_at IS NULL OR e.status = 'running')
        )
      )`;
    // search_jobs and run_events first: both hold a hard foreign key to
    // search_runs, so the parent row can only be removed once its children
    // are gone.
    const jobs = await client.query(
      `WITH ${eligibleRunsCte}
       DELETE FROM search_jobs WHERE run_id IN (SELECT id FROM eligible_runs)`,
      [retentionDays],
    );
    await client.query(
      `WITH ${eligibleRunsCte}
       DELETE FROM run_events WHERE run_id IN (SELECT id FROM eligible_runs)`,
      [retentionDays],
    );
    const runs = await client.query(
      `WITH ${eligibleRunsCte}
       DELETE FROM search_runs WHERE id IN (SELECT id FROM eligible_runs)`,
      [retentionDays],
    );
    await client.query('COMMIT');
    return { deletedJobs: jobs.rowCount ?? 0, deletedRuns: runs.rowCount ?? 0 };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const env = configuration();
  const database = new Database(env.DATABASE_URL);
  try {
    const { deletedJobs, deletedRuns } = await enforceRetention(database, RETENTION_DAYS);
    logger.info(
      { deletedJobs, deletedRuns, retentionDays: RETENTION_DAYS },
      'Search retention enforced',
    );
  } finally {
    await database.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logger.error({ error: String(error) }, 'Search retention run crashed');
    process.exitCode = 1;
  });
}
