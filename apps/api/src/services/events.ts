/**
 * The run event bus — one place where a run's progress is both persisted and
 * fanned out to whoever is watching.
 *
 * Every event goes to the database first and to subscribers second, in that
 * order and never the reverse. That ordering is what makes SSE resume correct:
 * a client that receives event 47 and then loses its connection can ask for
 * "everything after 47" and be certain the row exists, because it was written
 * before the byte was sent.
 *
 * The subtle part is `stream()`. Naively you would replay from the database and
 * then subscribe — but an event published in the gap between those two steps is
 * in neither set and is lost forever. So `stream()` subscribes *first*, buffers
 * whatever arrives live, then replays from the database, then drains the buffer
 * discarding anything the replay already covered. Sequence numbers make that
 * de-duplication exact rather than approximate.
 */

import type { RunEvent } from '@job-radar/shared';
import type { RunRepo, StoredEvent } from '../db/repo/runs.js';
import { now } from '../util/time.js';

export type { StoredEvent };

type Listener = (event: StoredEvent) => void;

/**
 * How far a single slow client may fall behind before it is cut loose.
 *
 * A browser tab that has been throttled in the background can stop reading its
 * socket while a run keeps producing leads. Holding every event for it would
 * grow without bound; dropping the connection costs that client one reconnect,
 * which it already knows how to do, and `Last-Event-ID` means it loses nothing.
 */
const MAX_PENDING_PER_STREAM = 512;

export class RunEventBus {
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(
    private readonly runs: RunRepo,
    private readonly clock: () => string = now,
  ) {}

  /**
   * Persists an event and delivers it to every live subscriber.
   *
   * A throwing listener must not abort the publish — the database write has
   * already happened and the other subscribers are entitled to their copy — so
   * failures are swallowed here. In practice the only listener is `stream`'s
   * push, which does not throw.
   */
  publish(runId: string, event: RunEvent): StoredEvent {
    const createdAt = this.clock();
    const seq = this.runs.appendEvent(runId, event, createdAt);
    const stored: StoredEvent = { seq, event, createdAt };

    for (const listener of this.listeners.get(runId) ?? []) {
      try {
        listener(stored);
      } catch {
        /* A broken subscriber is its own problem; the run continues. */
      }
    }
    return stored;
  }

  /** Registers a listener, returning the function that removes it. */
  subscribe(runId: string, listener: Listener): () => void {
    let set = this.listeners.get(runId);
    if (!set) {
      set = new Set();
      this.listeners.set(runId, set);
    }
    set.add(listener);

    return () => {
      const current = this.listeners.get(runId);
      if (!current) return;
      current.delete(listener);
      // Drop the empty bucket rather than accumulating one per run for the life
      // of the process.
      if (current.size === 0) this.listeners.delete(runId);
    };
  }

  /** How many clients are watching — used by the health endpoint. */
  subscriberCount(): number {
    let total = 0;
    for (const set of this.listeners.values()) total += set.size;
    return total;
  }

  /**
   * Every event after `sinceSeq`, replayed then live, until the run ends or the
   * caller aborts.
   *
   * Terminates on its own after a `done` or `error` event, so the SSE route can
   * simply `for await` and close the response when the loop falls out.
   */
  async *stream(
    runId: string,
    sinceSeq = 0,
    signal?: AbortSignal,
  ): AsyncGenerator<StoredEvent, void, void> {
    const pending: StoredEvent[] = [];
    let overflowed = false;
    let wake: (() => void) | null = null;

    const push = (event: StoredEvent) => {
      if (pending.length >= MAX_PENDING_PER_STREAM) {
        overflowed = true;
      } else {
        pending.push(event);
      }
      wake?.();
    };

    // Subscribe before replaying: an event published during the replay lands in
    // `pending` and is emitted after, rather than falling through the gap.
    const unsubscribe = this.subscribe(runId, push);
    const onAbort = () => wake?.();
    signal?.addEventListener('abort', onAbort);

    try {
      let lastSeq = sinceSeq;
      for (const event of this.runs.eventsSince(runId, sinceSeq)) {
        if (signal?.aborted) return;
        lastSeq = event.seq;
        yield event;
        if (isTerminal(event.event)) return;
      }

      for (;;) {
        if (signal?.aborted) return;

        if (pending.length === 0) {
          if (overflowed) return; // Client is too far behind; let it reconnect.
          await new Promise<void>((resolve) => {
            wake = () => {
              wake = null;
              resolve();
            };
          });
          continue;
        }

        const event = pending.shift();
        if (!event) continue;
        // The replay and the live feed overlap by however many events landed
        // while the replay query was running; sequence order makes the overlap
        // exactly identifiable.
        if (event.seq <= lastSeq) continue;
        lastSeq = event.seq;
        yield event;
        if (isTerminal(event.event)) return;
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
      unsubscribe();
    }
  }
}

/** After these, there is nothing more to send. */
function isTerminal(event: RunEvent): boolean {
  return event.type === 'done' || event.type === 'error';
}
