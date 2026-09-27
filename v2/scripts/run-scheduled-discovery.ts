/**
 * CS-26: "nothing runs discovery on a schedule."
 *
 * Invoked by careerscope-discovery.timer (host-native systemd, same pattern
 * as CS-24/CS-25) via `docker exec`, on a schedule. For every owner who has
 * explicitly enabled scheduledDiscoveryEnabled (default false - see
 * schema.ts's `profiles` table and docs/OPERATIONS/DISCOVERY-SCHEDULE.md for
 * why this defaults off), enqueues one profile-driven search per calendar
 * day and waits for it to reach a terminal status.
 *
 * Deliberately reuses Database.createSearch()/the existing search.collect
 * pipeline unchanged: every per-source budget, retry policy, dedup rule and
 * legitimate-access constraint documented in
 * .github/skills/careerscope-job-discovery/SKILL.md already applies to every
 * search_run regardless of who or what created it. This script adds no new
 * source, no new command type and no new queue - only a new *trigger*.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { Conflict, Database, ProfileRepository, configuration, logger } from '@careerscope/core';
import type { CreateSearch } from '@careerscope/core';

const ALL_SOURCES: CreateSearch['sources'] = [
  'greenhouse',
  'himalayas',
  'lever',
  'remoteok',
  'workable',
];

/** Deterministic per calendar day (UTC), so a restart or an accidental
 * second invocation on the same day cannot double-enqueue - relies on
 * createSearch's own idempotency-key handling, not new logic here. */
export function dayKey(now: Date): string {
  return `scheduled-${now.toISOString().slice(0, 10)}`;
}

/**
 * The one expected, non-alertable outcome: this owner has not saved a usable
 * target-role title yet, so there is deliberately nothing to search.
 * Anything else - including an idempotency-key reused with a *different*
 * computed request, which real createSearch behavior can throw as its own
 * Conflict - is a genuine anomaly and must alert, not be swallowed alongside
 * the expected case.
 */
export function isMissingTitlesConflict(error: unknown): boolean {
  // CS-35: matches the stable Conflict.code rather than the human-readable
  // message string this used to compare against - a message wording change
  // no longer silently breaks this worker's own retry/alerting logic.
  return error instanceof Conflict && error.code === 'MISSING_TARGET_ROLES';
}

export type PollResult = { status: string; timedOut: boolean };

/**
 * Bounded poll to a terminal status. Injected `fetchStatus` rather than a
 * Database instance so this is unit-testable without Postgres.
 */
export async function pollUntilTerminal(
  fetchStatus: () => Promise<string>,
  options: { deadlineMs: number; intervalMs: number; wait?: (ms: number) => Promise<void> },
): Promise<PollResult> {
  const wait = options.wait ?? ((ms: number) => delay(ms));
  const terminal = new Set(['completed', 'partial', 'failed']);
  const start = Date.now();
  for (;;) {
    const status = await fetchStatus();
    if (terminal.has(status)) return { status, timedOut: false };
    if (Date.now() - start >= options.deadlineMs) return { status, timedOut: true };
    await wait(options.intervalMs);
  }
}

export type Alerter = (message: string) => Promise<void>;

/** One owner's scheduled run: enabled check, enqueue, poll, classify. Pure
 * of I/O beyond the injected `database`/`alert`, so the decision logic
 * (skip vs enqueue vs alert) is exercised the same way in tests as in
 * production. */
export async function runForOwner(
  database: Database,
  ownerId: string,
  now: Date,
  alert: Alerter,
  pollOptions: { deadlineMs: number; intervalMs: number },
): Promise<'disabled' | 'skipped-no-titles' | 'completed' | 'partial' | 'failed' | 'alerted'> {
  const profile = await new ProfileRepository(database).get(ownerId);
  if (!profile?.scheduledDiscoveryEnabled) {
    logger.info({ ownerId }, 'Scheduled discovery disabled for this owner; not running');
    return 'disabled';
  }

  const firstTitle = profile.profile.preferences.titles[0]?.trim();
  let searchId: string;
  try {
    const search = await database.createSearch(ownerId, dayKey(now), {
      // useProfileTitles drives the actual search; this query text is only
      // the schema-required fallback label, kept human-readable in case it
      // is ever surfaced (e.g. in a future "search history" view).
      query:
        firstTitle && firstTitle.length >= 2 ? firstTitle.slice(0, 160) : 'Scheduled discovery',
      useProfileTitles: true,
      origin: 'scheduled',
      sources: ALL_SOURCES,
    });
    searchId = search.id;
  } catch (error) {
    if (isMissingTitlesConflict(error)) {
      logger.info({ ownerId }, 'Scheduled discovery skipped: no saved target roles yet');
      return 'skipped-no-titles';
    }
    logger.error({ ownerId, error: String(error) }, 'Scheduled discovery failed to enqueue');
    // Only the classification crosses the trust boundary to an external
    // webhook, capped and stripped of control characters - matching
    // monitor.sh/backup.sh's own discipline about what a network response
    // (here, an error's own message) is allowed to carry externally. The
    // full, unbounded error stays in the structured log only (Security
    // review, P2: the previous version forwarded the full String(error)
    // with no cap or filter).
    const safeReason = (error instanceof Error ? error.constructor.name : 'error')
      .replace(/[^\w.-]/g, '')
      .slice(0, 60);
    await alert(`CareerScope scheduled discovery FAILED to enqueue for an owner (${safeReason})`);
    return 'alerted';
  }

  const result = await pollUntilTerminal(async () => {
    const { rows } = await database.pool.query<{ status: string }>(
      'SELECT status FROM search_runs WHERE id = $1',
      [searchId],
    );
    return rows[0]?.status ?? 'unknown';
  }, pollOptions);

  if (result.timedOut) {
    logger.warn(
      { ownerId, searchId, status: result.status },
      'Scheduled discovery did not settle in time',
    );
    await alert(
      `CareerScope scheduled discovery did not settle in time (last status: ${result.status})`,
    );
    return 'alerted';
  }
  if (result.status === 'failed') {
    logger.error({ ownerId, searchId }, 'Scheduled discovery run failed');
    await alert('CareerScope scheduled discovery run failed');
    return 'alerted';
  }
  logger.info({ ownerId, searchId, status: result.status }, 'Scheduled discovery run settled');
  return result.status as 'completed' | 'partial';
}

async function main() {
  const env = configuration();
  const database = new Database(env.DATABASE_URL);
  const webhookUrl = process.env.MONITOR_WEBHOOK_URL ?? '';
  const alert: Alerter = async (message) => {
    logger.warn({ message }, 'Scheduled discovery alert');
    if (!webhookUrl) return;
    if (!webhookUrl.startsWith('https://')) {
      logger.warn('MONITOR_WEBHOOK_URL is not https; refusing to send an alert in cleartext');
      return;
    }
    try {
      await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message, content: message }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      logger.error('Scheduled discovery alert webhook POST failed');
    }
  };
  try {
    const { rows: owners } = await database.pool.query<{ id: string }>(
      `SELECT u.id FROM users u
       JOIN candidate_profiles p ON p.owner_id = u.id
       WHERE p.scheduled_discovery_enabled = true`,
    );
    if (owners.length === 0) {
      logger.info('No owner has scheduled discovery enabled; nothing to do');
      return;
    }
    for (const { id: ownerId } of owners) {
      await runForOwner(database, ownerId, new Date(), alert, {
        deadlineMs: 65_000,
        intervalMs: 2_000,
      });
    }
  } finally {
    await database.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logger.error({ error: String(error) }, 'Scheduled discovery run crashed');
    process.exitCode = 1;
  });
}
