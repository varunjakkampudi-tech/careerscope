/**
 * The shape every scrape provider shares.
 *
 * Structurally this is the sibling of `remote/base.ts` — a page walk, a local
 * filter, a budget — and it deliberately reads the same way so that moving
 * between the two is not a context switch. Three things are genuinely different,
 * and all three come from the fact that these sources can refuse us:
 *
 * **Being blocked is a distinct outcome, not an empty one.** A page walk that
 * ends because Cloudflare served an interstitial reports that, in those words.
 * See `block.ts` for why this is the load-bearing decision in the tier.
 *
 * **The browser is leased, not owned.** Chromium costs a second and 80 MB, so
 * the sources that need one share it and the last to finish closes it. The lease
 * is released in a `finally` that also covers the abort path, because a
 * cancelled run is exactly when a leaked browser is most likely and least
 * noticed.
 *
 * **The whole tier is opt-in.** `ENABLE_SCRAPERS` defaults to false and a source
 * that is off still appears in `/api/sources` with the reason — the registry's
 * standing rule that "we did not look" must never be presented as "we found
 * nothing".
 */

import type { ProviderQuery, RawJob, ScrapeSource } from '@job-radar/shared';
import { matchesQuery } from '../filter.js';
import { isAbortError } from '../http.js';
import { describeFailure, rankByRelevance } from '../rank.js';
import type { JobProvider, ProviderContext } from '../types.js';
import type { BlockDetection } from './block.js';
import { describeEmptyOutcome } from './block.js';
import {
  BrowserPool,
  isPlaywrightInstalled,
  PLAYWRIGHT_MISSING_REASON,
  type ScrapeSession,
} from './browser.js';

/** The reason shown for every scrape source while the flag is off. */
export const SCRAPERS_DISABLED_REASON =
  'Browser-backed sources are off. Set ENABLE_SCRAPERS=true to switch them on — they are slower than the API boards and are yours to enable deliberately.';

/**
 * One page of a walk.
 *
 * `block` is how an adapter reports a wall without throwing: throwing would be
 * indistinguishable from a network fault, and the two need different words in
 * the run log. An adapter that sets `block` is saying "stop, and tell them why".
 */
export interface ScrapePage<TItem> {
  items: TItem[];
  block?: BlockDetection | null;
}

/** What an adapter is handed. `session` is present only when it asked for one. */
export interface ScrapeContext extends ProviderContext {
  session?: ScrapeSession;
}

export interface ScrapeAdapter<TItem> {
  readonly id: ScrapeSource;
  readonly label: string;
  /**
   * Whether this source needs a real browser. LinkedIn does not — its
   * logged-out guest endpoints answer a plain HTTP client — so it never pays
   * for a launch.
   */
  readonly needsBrowser: boolean;

  /**
   * A standing limitation of this source, stated once per run.
   *
   * Not an error and not a warning — a fact about what this source can and
   * cannot deliver, which the user needs in order to read its results correctly.
   * Indeed is the case that motivated it: its detail pages are robots-disallowed,
   * so every lead it produces is capped at 80% and none of them clear the default
   * 85% threshold. Without this line that reads as "Indeed found nothing", which
   * is both wrong and unfalsifiable from the outside.
   */
  readonly note?: string;

  pages(ctx: ScrapeContext, query: ProviderQuery, now: number): AsyncIterable<ScrapePage<TItem>>;

  toRawJob(item: TItem, now: number): RawJob | null;

  /** Fetch the full description for one posting, when the list omits it. */
  fetchDetail?(job: RawJob, ctx: ScrapeContext): Promise<RawJob>;
}

export interface ScrapeProviderOptions {
  /** False by default. The whole tier is dark unless this is set. */
  enableScrapers?: boolean;
  /** Injected so recency filtering is deterministic under test. */
  now?: () => number;
  /** Shared across the scrape sources in one run; a test passes its own. */
  pool?: BrowserPool;
}

export function createScrapeProvider<TItem>(
  adapter: ScrapeAdapter<TItem>,
  options: ScrapeProviderOptions = {},
): JobProvider {
  const now = options.now ?? Date.now;
  const enabled = options.enableScrapers ?? false;

  // Resolved once, at construction, because `/api/sources` renders it verbatim
  // and the settings screen should not have to run a search to find out.
  const unavailableReason = !enabled
    ? SCRAPERS_DISABLED_REASON
    : adapter.needsBrowser && !isPlaywrightInstalled()
      ? PLAYWRIGHT_MISSING_REASON
      : null;

  const provider: JobProvider = {
    id: adapter.id,
    kind: 'scrape',
    label: adapter.label,
    unavailableReason,

    async *search(query: ProviderQuery, ctx: ProviderContext): AsyncIterable<RawJob> {
      if (unavailableReason !== null) return;

      // Said before the walk rather than after it, so it lands whatever the
      // outcome — a limitation only mentioned on success is worthless precisely
      // when it explains the result.
      if (adapter.note) {
        ctx.log?.({ level: 'info', source: adapter.id, message: adapter.note });
      }

      let yielded = 0;
      let scanned = 0;
      let unread = 0;
      let block: BlockDetection | null = null;
      let failed = false;

      // One clock reading for the whole walk, so a posting cannot be fresh on
      // page one and stale on page four because the run took a minute.
      const at = now();

      let session: ScrapeSession | undefined;
      let release: (() => Promise<void>) | undefined;

      try {
        if (adapter.needsBrowser) {
          const pool = options.pool ?? sharedPool();
          const lease = await pool.lease();
          release = lease.release;
          session = await lease.pool.open();
        }

        const scrapeCtx: ScrapeContext = { ...ctx, ...(session ? { session } : {}) };

        for await (const page of adapter.pages(scrapeCtx, query, at)) {
          if (ctx.signal?.aborted) return;

          if (page.block) {
            block = page.block;
            break;
          }

          scanned += page.items.length;

          const matched: RawJob[] = [];
          for (const item of page.items) {
            let raw: RawJob | null;
            try {
              raw = adapter.toRawJob(item, at);
            } catch (error) {
              // One malformed card is not worth the rest of the page.
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
            // The detail fetch is the expensive half of a scrape — one request
            // per posting — so it is spent only on jobs that already survived
            // the filter and fit inside the budget.
            const lead = adapter.fetchDetail ? await withDetail(adapter, job, scrapeCtx, ctx) : job;
            yield lead;
            yielded += 1;
            // Counted only where a detail fetch was actually attempted. A source
            // with no `fetchDetail` is not failing to read descriptions — it has
            // a standing reason it cannot, which `note` already stated.
            if (adapter.fetchDetail && !lead.hasFullDescription) unread += 1;
          }

          // Checked after the body, not on entry: `for await` advances the
          // generator before the body runs, so an entry check has already paid
          // for the page it then throws away.
          if (yielded >= query.maxResults) break;
        }
      } catch (error) {
        if (isAbortError(error)) return;
        // A source that dies halfway still delivered what it delivered — so the
        // throw is swallowed here rather than propagated. `failed` is what stops
        // that mercy from turning into a lie: every terminal message below has
        // to know the walk ended on a fault, or it will describe a crash as a
        // healthy source with nothing to offer.
        failed = true;
        ctx.log?.({ level: 'warn', source: adapter.id, message: describeFailure(error) });
      } finally {
        await session?.dispose().catch(() => undefined);
        await release?.().catch(() => undefined);
      }

      if (yielded === 0) {
        ctx.log?.({
          // A block or a fault is a warning; a genuinely quiet query is not.
          level: block || failed ? 'warn' : 'debug',
          source: adapter.id,
          message: describeEmptyOutcome(adapter.id, scanned, block, failed),
        });
        return;
      }

      // Partial results plus a wall is the most misleading state of all: the
      // user sees leads and assumes the source was fully read. A fault is the
      // same shape and gets the same treatment — the only difference is whether
      // the reason was named above by `block.message` or by `describeFailure`.
      if (block || failed) {
        const cause = block
          ? `${block.message} `
          : 'This source stopped on an error, reported above. ';
        ctx.log?.({
          level: 'warn',
          source: adapter.id,
          message: `${cause}${yielded} posting${yielded === 1 ? '' : 's'} had already been read, so this source is partial.`,
        });
        return;
      }

      // Why some of these leads will score lower than their titles suggest.
      //
      // A detail fetch can come back 200 and still carry nothing readable — an
      // empty payload, a description too short to score against — in which case
      // the lead is kept and honestly capped at 80% by `hasFullDescription:
      // false`. That cap is correct, and from the outside it is inexplicable:
      // the user sees five Naukri leads for the same query, three scoring
      // normally and two mysteriously held down, with nothing in the log
      // between them. This is the sentence that closes that gap.
      //
      // Only on the success path. A blocked or failed run already carries the
      // stronger "this source is partial" caveat above, and stacking a second
      // one under it buries the first.
      if (unread > 0) {
        ctx.log?.({
          level: 'info',
          source: adapter.id,
          message: `${unread} of ${yielded} postings could not be read in full — their descriptions were unavailable, so they are marked low-confidence and capped at 80%.`,
        });
      }

      ctx.log?.({
        level: 'debug',
        source: adapter.id,
        message: `${yielded} of ${scanned} postings matched`,
      });
    },
  };

  return provider;
}

/**
 * Attach the full description, or keep the posting without it.
 *
 * A failed detail fetch must not cost the lead: the card already carries a
 * title, a company and an apply link, which is a usable result. It stays
 * `hasFullDescription: false`, which the matching engine reads as low confidence
 * and caps at 80% — so a posting we could not read fully can never claim to
 * clear an 85% threshold.
 */
async function withDetail<TItem>(
  adapter: ScrapeAdapter<TItem>,
  job: RawJob,
  scrapeCtx: ScrapeContext,
  ctx: ProviderContext,
): Promise<RawJob> {
  try {
    return await adapter.fetchDetail!(job, scrapeCtx);
  } catch (error) {
    if (isAbortError(error)) throw error;
    ctx.log?.({
      level: 'debug',
      source: adapter.id,
      message: `kept "${job.title}" without its full description — ${describeFailure(error)}`,
    });
    return job;
  }
}

/* -------------------------------------------------------------------------- */
/* Shared browser                                                             */
/* -------------------------------------------------------------------------- */

/**
 * One browser per process, reference-counted.
 *
 * The alternative — a pool owned by the search orchestrator — would mean
 * threading a browser handle through `ProviderContext` and every provider that
 * has no use for one. Reference counting keeps the lifetime beside the code that
 * needs it: the last scrape source to finish closes Chromium, and the `finally`
 * that releases the lease is in the same function as the one that took it, so
 * there is no path where a run ends with a browser still up.
 */
let shared: BrowserPool | null = null;

function sharedPool(): BrowserPool {
  shared ??= new BrowserPool();
  return shared;
}

/** Closes the process-wide browser. Called on API shutdown and by tests. */
export async function closeSharedBrowser(): Promise<void> {
  const pool = shared;
  shared = null;
  await pool?.close();
}
