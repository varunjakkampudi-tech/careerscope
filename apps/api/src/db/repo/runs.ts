/**
 * Search runs and their event stream.
 *
 * A run takes minutes, so its state has to survive a page refresh, a lost
 * connection, and an API restart. Two things follow from that:
 *
 *  - **Progress is written to the database, not held in memory.** A client that
 *    reconnects reads the row and knows exactly where the run is.
 *  - **Every event is persisted with a monotonic `seq`.** SSE's `Last-Event-ID`
 *    header carries the last sequence a client saw; `eventsSince` replays from
 *    there, so a laptop that slept through the middle of a run catches up rather
 *    than showing a run that appears to have started at 60%.
 *
 * A run left `running` when the process died is not recoverable — the in-process
 * worker went with it — so `reapOrphans` marks those failed at boot rather than
 * leaving a spinner that never resolves.
 */

import {
  searchRunSchema,
  type RunEvent,
  type SearchRequest,
  type SearchRun,
  type RunStatus,
} from '@job-radar/shared';
import { fromJson, toNumberOrNull, toStringOrNull, toText, type Db, type Row } from '../index.js';
import { LOCAL_PROFILE_ID, LOCAL_USER_ID, prefixedId } from '../../util/ids.js';

type RunStats = SearchRun['stats'];

/** What a run starts with, before any source has reported. */
export function emptyStats(): RunStats {
  return { fetched: 0, deduped: 0, enriched: 0, scored: 0, matched: 0, bySource: [] };
}

function rowToRun(row: Row): SearchRun {
  return searchRunSchema.parse({
    id: toText(row['id']),
    status: toText(row['status']),
    request: fromJson<SearchRequest>(row['request'], 'search_runs.request'),
    stage: toText(row['stage']),
    progress: toNumberOrNull(row['progress']) ?? 0,
    stats: fromJson<RunStats>(row['stats'], 'search_runs.stats'),
    error: toStringOrNull(row['error']),
    startedAt: toStringOrNull(row['started_at']),
    finishedAt: toStringOrNull(row['finished_at']),
    createdAt: toText(row['created_at']),
  });
}

/** A stored event, with the sequence number SSE resume depends on. */
export interface StoredEvent {
  seq: number;
  event: RunEvent;
  createdAt: string;
}

export class RunRepo {
  constructor(private readonly db: Db) {}

  get(id: string): SearchRun | null {
    const row = this.db.get('SELECT * FROM search_runs WHERE id = :id', { id });
    return row ? rowToRun(row) : null;
  }

  list(limit = 20, profileId: string = LOCAL_PROFILE_ID): SearchRun[] {
    return this.db
      .all(
        'SELECT * FROM search_runs WHERE profile_id = :profileId ORDER BY created_at DESC LIMIT :limit',
        { profileId, limit },
      )
      .map(rowToRun);
  }

  /** The run the UI should show on load: the newest one still going, if any. */
  active(profileId: string = LOCAL_PROFILE_ID): SearchRun | null {
    const row = this.db.get(
      `SELECT * FROM search_runs
        WHERE profile_id = :profileId AND status IN ('queued', 'running')
        ORDER BY created_at DESC LIMIT 1`,
      { profileId },
    );
    return row ? rowToRun(row) : null;
  }

  create(request: SearchRequest, at: string, profileId: string = LOCAL_PROFILE_ID): SearchRun {
    const id = prefixedId('run');
    this.db.run(
      `INSERT INTO search_runs (id, user_id, profile_id, status, request, stage, progress,
                                stats, created_at)
       VALUES (:id, :userId, :profileId, 'queued', :request, 'queued', 0, :stats, :at)`,
      {
        id,
        userId: LOCAL_USER_ID,
        profileId,
        request,
        stats: emptyStats(),
        at,
      },
    );
    return this.get(id)!;
  }

  /** Marks the run started. Separate from `create` because a queued run may wait. */
  start(id: string, at: string): void {
    this.db.run(
      `UPDATE search_runs SET status = 'running', stage = 'starting', started_at = :at
        WHERE id = :id AND status = 'queued'`,
      { id, at },
    );
  }

  progress(id: string, stage: string, progress: number, stats: RunStats): void {
    this.db.run(
      'UPDATE search_runs SET stage = :stage, progress = :progress, stats = :stats WHERE id = :id',
      { id, stage, progress: Math.min(1, Math.max(0, progress)), stats },
    );
  }

  /**
   * Closes a run.
   *
   * `progress` is forced to 1 on any terminal status — including failure. A run
   * that died at 40% should not leave a bar frozen mid-way; the status is what
   * says whether it succeeded, and the bar just says it is over.
   */
  finish(
    id: string,
    status: Exclude<RunStatus, 'queued' | 'running'>,
    at: string,
    error?: string,
  ): void {
    this.db.run(
      `UPDATE search_runs SET status = :status, stage = :stage, progress = 1,
                              error = :error, finished_at = :at
        WHERE id = :id`,
      { id, status, stage: status, error: error ?? null, at },
    );
  }

  /**
   * Fails any run left mid-flight by a restart.
   *
   * The worker is in-process, so a `running` row at boot has no worker behind it
   * — it can only ever be a ghost. Called once from `index.ts` before the server
   * listens.
   */
  reapOrphans(at: string): number {
    const stale = this.db.all(`SELECT id FROM search_runs WHERE status IN ('queued', 'running')`);
    if (stale.length === 0) return 0;
    return this.db.tx(() => {
      for (const row of stale) {
        const id = toText(row['id']);
        this.finish(id, 'failed', at, 'Interrupted by a server restart');
        this.appendEvent(id, { type: 'error', message: 'Interrupted by a server restart' }, at);
      }
      return stale.length;
    });
  }

  cancel(id: string, at: string): boolean {
    // Only a live run can be cancelled — cancelling a completed run would
    // rewrite history and lose the result the user already has.
    const changed = this.db.run(
      `UPDATE search_runs SET status = 'cancelled', stage = 'cancelled', progress = 1,
                              finished_at = :at
        WHERE id = :id AND status IN ('queued', 'running')`,
      { id, at },
    ).changes;
    return changed > 0;
  }

  /* ------------------------------------------------------------------------ */
  /* Events                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Appends an event and returns its sequence number.
   *
   * The sequence is allocated inside a transaction with the insert, so two
   * concurrent appends cannot both read the same max and collide on the
   * `UNIQUE (run_id, seq)` constraint. In practice this process is
   * single-threaded and they cannot interleave — the transaction is here so that
   * stays true if a worker thread is ever added.
   */
  appendEvent(runId: string, event: RunEvent, at: string): number {
    return this.db.tx(() => {
      const row = this.db.get(
        'SELECT COALESCE(MAX(seq), 0) AS max_seq FROM run_events WHERE run_id = :runId',
        { runId },
      );
      const seq = (toNumberOrNull(row?.['max_seq'] ?? null) ?? 0) + 1;
      this.db.run(
        `INSERT INTO run_events (run_id, seq, type, payload, created_at)
         VALUES (:runId, :seq, :type, :payload, :at)`,
        { runId, seq, type: event.type, payload: event, at },
      );
      return seq;
    });
  }

  /**
   * Events after `seq`, for an SSE client resuming with `Last-Event-ID`.
   *
   * `lead` events are excluded from replay by default: a run can produce two
   * hundred of them and the client fetches `/api/leads` on reconnect anyway, so
   * replaying each one would push a megabyte down a stream that exists to show
   * progress.
   */
  eventsSince(runId: string, seq = 0, includeLeads = false): StoredEvent[] {
    const rows = this.db.all(
      `SELECT seq, payload, created_at FROM run_events
        WHERE run_id = :runId AND seq > :seq ${includeLeads ? '' : "AND type != 'lead'"}
        ORDER BY seq`,
      { runId, seq },
    );
    return rows.map((row) => ({
      seq: toNumberOrNull(row['seq']) ?? 0,
      event: fromJson<RunEvent>(row['payload'], 'run_events.payload'),
      createdAt: toText(row['created_at']),
    }));
  }

  /** The run's log, for the "what happened" panel and for a bug report. */
  logs(runId: string, limit = 500): StoredEvent[] {
    return this.db
      .all(
        `SELECT seq, payload, created_at FROM run_events
          WHERE run_id = :runId AND type = 'log' ORDER BY seq DESC LIMIT :limit`,
        { runId, limit },
      )
      .map((row) => ({
        seq: toNumberOrNull(row['seq']) ?? 0,
        event: fromJson<RunEvent>(row['payload'], 'run_events.payload'),
        createdAt: toText(row['created_at']),
      }))
      .reverse();
  }

  /**
   * Drops all but the newest `keep` runs.
   *
   * Events cascade with the run; leads do not — `leads.run_id` is
   * `ON DELETE SET NULL`, so a lead outlives the search that found it. Losing
   * the run is losing a progress log; losing the lead would be losing the job.
   */
  prune(keep = 50, profileId: string = LOCAL_PROFILE_ID): number {
    return this.db.run(
      `DELETE FROM search_runs
        WHERE profile_id = :profileId
          AND status NOT IN ('queued', 'running')
          AND id NOT IN (
            SELECT id FROM search_runs WHERE profile_id = :profileId
             ORDER BY created_at DESC LIMIT :keep
          )`,
      { profileId, keep },
    ).changes;
  }
}
