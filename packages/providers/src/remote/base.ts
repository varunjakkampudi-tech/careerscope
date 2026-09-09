/**
 * The shape every remote-board provider shares.
 *
 * These three sources are the mirror image of the ATS boards. An ATS is
 * company-scoped and cannot be queried — you name an employer and get their
 * whole board. Remotive, RemoteOK and Himalayas are the opposite: one global
 * feed of every employer, with little or no server-side filtering. So there is
 * no slug list and no per-board budget here; there is a page walk, a local
 * filter, and a cap.
 *
 * Two things this loop is careful about:
 *
 * **A feed is not a search engine.** Himalayas alone carries north of 100,000
 * postings and offers no keyword parameter, so a narrow query can walk a long
 * way before filling its budget. Each adapter therefore sets a page ceiling,
 * and when the walk stops with the budget unfilled the reason is logged — a cap
 * the user cannot see reads as "there was nothing else", which is a different
 * and much worse claim.
 *
 * **Attribution is a licence condition, not a courtesy.** Remotive and RemoteOK
 * both require that listings link back to their posting URL and name them as
 * the source, on pain of losing access. That is why `sourceUrl` on these jobs
 * always points at the board's own page rather than the employer's, and why the
 * source id travels with every lead through to the leads table.
 */

import type { ProviderQuery, RawJob, RemoteSource } from '@job-radar/shared';
import { matchesQuery } from '../filter.js';
import { isAbortError } from '../http.js';
import { describeFailure, rankByRelevance } from '../rank.js';
import type { JobProvider, ProviderContext } from '../types.js';

/** What one remote board has to supply. Everything else is handled by the loop. */
export interface FeedAdapter<TItem> {
  readonly id: RemoteSource;
  readonly label: string;

  /**
   * Pages of the feed, newest first, ending when the feed does.
   *
   * Implemented as an async generator so each board expresses its own paging —
   * cursor, offset, or a single shot — without the loop needing to know which.
   * The generator is responsible for its own page ceiling and for logging when
   * it stops early.
   */
  pages(ctx: ProviderContext, query: ProviderQuery, now: number): AsyncIterable<TItem[]>;

  /**
   * One feed item to a `RawJob`, or null when it is not a live posting.
   *
   * `now` is the loop's clock rather than `Date.now()` so that an adapter which
   * drops expired postings — Himalayas publishes an `expiryDate` — stays
   * deterministic under a fixture.
   */
  toRawJob(item: TItem, now: number): RawJob | null;
}

export interface FeedProviderOptions {
  /** Injected so recency filtering is deterministic under test. */
  now?: () => number;
}

export function createFeedProvider<TItem>(
  adapter: FeedAdapter<TItem>,
  options: FeedProviderOptions = {},
): JobProvider {
  const now = options.now ?? Date.now;

  return {
    id: adapter.id,
    kind: 'remote',
    label: adapter.label,
    unavailableReason: null,

    async *search(query: ProviderQuery, ctx: ProviderContext): AsyncIterable<RawJob> {
      let yielded = 0;
      let scanned = 0;

      // One reading of the clock for the whole walk. A posting must not be live
      // on the first page and expired on the fourth because the run took a
      // minute, and a fixture must not depend on where in a second it ran.
      const at = now();

      let pages: AsyncIterable<TItem[]>;
      try {
        pages = adapter.pages(ctx, query, at);
      } catch (error) {
        if (isAbortError(error)) return;
        ctx.log?.({ level: 'warn', source: adapter.id, message: describeFailure(error) });
        return;
      }

      try {
        for await (const page of pages) {
          if (ctx.signal?.aborted) return;
          scanned += page.length;

          const matched: RawJob[] = [];
          for (const item of page) {
            let raw: RawJob | null;
            try {
              raw = adapter.toRawJob(item, at);
            } catch (error) {
              // One malformed posting is not worth losing the rest of the page.
              ctx.log?.({
                level: 'debug',
                source: adapter.id,
                message: `skipped an unreadable posting — ${describeFailure(error)}`,
              });
              continue;
            }
            if (raw && matchesQuery(raw, query, { now: at })) matched.push(raw);
          }

          rankByRelevance(matched, query.titles);

          for (const job of matched.slice(0, query.maxResults - yielded)) {
            yield job;
            yielded += 1;
          }

          // The budget is checked here rather than on the way into the loop
          // because `for await` advances the generator *before* the body runs:
          // a check on entry has already paid for the page it then discards,
          // which on Himalayas is a hundred postings fetched for nothing.
          if (yielded >= query.maxResults) break;
        }
      } catch (error) {
        if (isAbortError(error)) return;
        // A feed that dies halfway still delivered what it delivered. Report it
        // and end this source, rather than failing the whole run.
        ctx.log?.({ level: 'warn', source: adapter.id, message: describeFailure(error) });
      }

      ctx.log?.({
        level: 'debug',
        source: adapter.id,
        message: `${yielded} of ${scanned} postings matched`,
      });
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Shared feed plumbing                                                       */
/* -------------------------------------------------------------------------- */

/**
 * An epoch-seconds timestamp as an ISO string, or undefined.
 *
 * Two of the three feeds date their postings in seconds, and the one place this
 * reliably goes wrong is feeding seconds to a constructor that wants
 * milliseconds — which silently dates every posting to January 1970 and makes
 * the recency filter discard the entire board. Values outside a plausible range
 * are rejected rather than converted, because a wrong date is worse than none.
 */
export function epochSecondsToIso(seconds: number | null | undefined): string | undefined {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return undefined;
  // 1990-01-01 through 2100-01-01. A millisecond value lands far above this.
  if (seconds < 631_152_000 || seconds > 4_102_444_800) return undefined;
  return new Date(seconds * 1000).toISOString();
}

/**
 * Append a board's own taxonomy to the description as a trailing line.
 *
 * All three feeds tag their postings — Remotive with `tags` and a category,
 * RemoteOK with `tags`, Himalayas with `categories` — and those tags routinely
 * name technologies the prose never spells out. The skill extractor reads the
 * description text and nothing else, so a tag that stays in its own field is a
 * skill the matcher cannot see.
 *
 * It goes in as a labelled paragraph rather than being spliced into the prose,
 * so the user reading the JD can tell what the employer wrote from what the
 * board added.
 */
export function withKeywordLine(
  description: string,
  keywords: readonly (string | null | undefined)[],
): string {
  const seen = new Set<string>();
  for (const keyword of keywords) {
    const value = keyword?.trim();
    if (value) seen.add(value);
  }
  if (seen.size === 0) return description;
  return `${description}\n<p>Keywords: ${[...seen].join(', ')}</p>`;
}
