/**
 * The run queue — one worker, in this process, no broker.
 *
 * A search run is minutes of network I/O against a dozen third-party hosts. Two
 * running at once would double the request rate every one of those hosts sees
 * from this IP, which is how a free API key gets suspended. Serialising them
 * costs the user nothing real — this is a single-user app, and a second search
 * started while the first is running is almost always a correction to the first.
 *
 * Redis and a job broker would buy horizontal workers this app has no use for,
 * in exchange for a service to run, monitor and back up. The durable half of a
 * queue is already in SQLite: `search_runs` rows carry the status, so a restart
 * loses in-flight work but nothing silently disappears — `reapOrphans` closes
 * ghosts at boot with an honest message.
 *
 * **Who owns a terminal row.** The runner writes the row for a run that finished
 * or failed on its own. For a run that was stopped from outside, the stopper
 * owns it: a cancel writes `cancelled` *before* aborting, a timeout writes
 * `failed` *after* the runner unwinds. That rule is what keeps "cancelled" and
 * "timed out" from collapsing into the same indistinguishable abort.
 */

import type { SearchRun } from '@job-radar/shared';
import type { Repos } from '../db/repo/index.js';
import type { Logger } from '../logger.js';
import { now } from '../util/time.js';
import type { RunEventBus } from './events.js';
import type { SearchRunner } from './searchRunner.js';

/** Long enough for a twelve-source run with enrichment; short enough to notice. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

const TIMEOUT_MESSAGE = 'Run exceeded the time limit and was stopped';

export interface RunQueueDeps {
  repos: Repos;
  events: RunEventBus;
  logger: Logger;
  runner: Pick<SearchRunner, 'execute'>;
  timeoutMs?: number | undefined;
  clock?: (() => string) | undefined;
}

export interface QueueStatus {
  /** The run being executed right now, if any. */
  running: string | null;
  /** Run ids waiting, in the order they will be picked up. */
  queued: string[];
  accepting: boolean;
}

export class RunQueue {
  private readonly clock: () => string;
  private readonly timeoutMs: number;

  private readonly waiting: string[] = [];
  private active: ActiveRun | null = null;
  private pump: Promise<void> | null = null;
  private accepting = true;

  constructor(private readonly deps: RunQueueDeps) {
    this.clock = deps.clock ?? now;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Adds a run to the back of the queue.
   *
   * The row already exists — the route creates it so that the response can carry
   * a real run id — so this is purely the in-memory half. Enqueuing the same id
   * twice is ignored rather than an error: a retried POST should not run the
   * same search two times.
   */
  enqueue(runId: string): void {
    if (!this.accepting) {
      throw new Error('Server is shutting down and is not accepting new runs');
    }
    if (this.active?.runId === runId || this.waiting.includes(runId)) return;

    this.waiting.push(runId);
    this.deps.logger.debug({ runId, queued: this.waiting.length }, 'run queued');
    this.start();
  }

  /**
   * Stops a run, whether it has started or not.
   *
   * The row is written *before* the signal fires. The runner reads it back on
   * the way out, and an SSE client that reconnects mid-abort sees a settled
   * `cancelled` rather than a run that is somehow still `running` with no worker.
   *
   * Returns false when there was nothing to cancel — an already-finished run, or
   * an id this process never had.
   */
  cancel(runId: string): boolean {
    const at = this.clock();
    const closed = this.deps.repos.runs.cancel(runId, at);
    if (!closed) return false;

    const index = this.waiting.indexOf(runId);
    if (index >= 0) this.waiting.splice(index, 1);

    this.deps.events.publish(runId, { type: 'error', message: 'Run cancelled' });
    if (this.active?.runId === runId) this.active.controller.abort();

    this.deps.logger.info({ runId }, 'run cancelled');
    return true;
  }

  status(): QueueStatus {
    return {
      running: this.active?.runId ?? null,
      queued: [...this.waiting],
      accepting: this.accepting,
    };
  }

  /** Whether this process is currently working on, or about to work on, a run. */
  has(runId: string): boolean {
    return this.active?.runId === runId || this.waiting.includes(runId);
  }

  /**
   * Resolves when the queue has nothing left to do.
   *
   * Used by tests, and by shutdown to give an in-flight run its chance to close
   * its own row cleanly instead of being reaped as a ghost on the next boot.
   */
  async idle(): Promise<void> {
    while (this.pump) await this.pump;
  }

  /**
   * Refuses new work, aborts what is running, and waits for it to unwind.
   *
   * Runs still queued are deliberately left `queued` in the database: they never
   * started, and `reapOrphans` will close them at the next boot with a message
   * that says so. Marking them failed here would claim they were attempted.
   */
  async close(): Promise<void> {
    this.accepting = false;
    this.waiting.length = 0;
    this.active?.controller.abort();
    await this.idle();
  }

  /* ---------------------------------------------------------------------- */
  /* Worker                                                                 */
  /* ---------------------------------------------------------------------- */

  /** Starts the pump if it is not already running. One at a time is the point. */
  private start(): void {
    if (this.pump) return;
    this.pump = this.drain().finally(() => {
      this.pump = null;
    });
  }

  private async drain(): Promise<void> {
    for (;;) {
      const runId = this.waiting.shift();
      if (runId === undefined) return;
      await this.runOne(runId);
    }
  }

  /**
   * Executes one run under a timeout.
   *
   * `execute` returns a failed run rather than throwing for ordinary failures,
   * so the catch here is for the unexpected — a bug in the runner, or a profile
   * that vanished between queueing and starting. Either way the row must not be
   * left `running`, because nothing else in the process will ever close it.
   */
  private async runOne(runId: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    // The event loop should not be held open by a queue that is merely waiting.
    timer.unref?.();

    this.active = { runId, controller };
    const startedAt = Date.now();

    try {
      const outcome = await this.deps.runner.execute(runId, controller.signal);
      if (controller.signal.aborted) this.closeAborted(runId, outcome.run);
    } catch (error) {
      this.deps.logger.error({ runId, err: error }, 'run worker crashed');
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.deps.repos.runs.finish(runId, 'failed', this.clock(), message);
      this.deps.events.publish(runId, { type: 'error', message });
    } finally {
      clearTimeout(timer);
      this.active = null;
      this.deps.logger.debug({ runId, ms: Date.now() - startedAt }, 'run worker finished');
    }
  }

  /**
   * Closes a run that was aborted but has no terminal row.
   *
   * `cancel` writes its row up front, so anything still open here was stopped by
   * the timeout — and a timeout is a failure with a cause worth naming, not a
   * cancellation. Reported to the user as such.
   */
  private closeAborted(runId: string, run: SearchRun): void {
    if (run.status !== 'queued' && run.status !== 'running') return;

    this.deps.logger.warn({ runId, timeoutMs: this.timeoutMs }, 'run timed out');
    this.deps.repos.runs.finish(runId, 'failed', this.clock(), TIMEOUT_MESSAGE);
    this.deps.events.publish(runId, { type: 'error', message: TIMEOUT_MESSAGE });
  }
}

interface ActiveRun {
  runId: string;
  controller: AbortController;
}
