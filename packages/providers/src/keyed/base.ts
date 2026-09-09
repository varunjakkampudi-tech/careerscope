/**
 * The shape every keyed aggregator shares.
 *
 * This is the third provider family, and it differs from the other two in the
 * way that matters most to the loop: **these boards can actually be searched.**
 * An ATS is company-scoped and must be walked employer by employer; a remote
 * feed is global but has no keyword parameter, so it is walked and filtered
 * locally. Adzuna, Jooble and JSearch all take a keyword and a location and do
 * the narrowing server-side.
 *
 * That changes three things:
 *
 * **The walk fans out over titles, not pages.** The user's target titles are
 * separate searches, because "Senior Backend Engineer" and "Platform Engineer"
 * return different jobs on a board that matches on text. Depth is traded for
 * breadth: a few pages of each title beats many pages of the first one.
 *
 * **Results must be de-duplicated across those searches.** Overlapping titles
 * return overlapping jobs, and without a seen-set the same posting is offered to
 * the user once per title that matched it.
 *
 * **Requests are the budget, not pages.** All three are metered — Adzuna and
 * JSearch on a monthly call quota, Jooble on a contract — so a run that would
 * otherwise spend fifty calls to fill a fifty-result page is spending someone's
 * free tier. The ceiling here is a request count, and when it is what ended the
 * walk that is logged rather than passed off as "nothing more matched".
 *
 * Credentials are handed in rather than read from `process.env`, so this package
 * stays free of ambient configuration and a test can construct a provider with
 * and without a key.
 */

import type { ApiSource, ProviderQuery, RawJob } from '@job-radar/shared';
import { matchesQuery } from '../filter.js';
import { isAbortError } from '../http.js';
import { describeFailure, rankByRelevance } from '../rank.js';
import type { JobProvider, ProviderContext } from '../types.js';

/** Pages per keyword. Breadth over depth: page 4 of a text search is thin. */
const MAX_PAGES_PER_KEYWORD = 3;

/** Titles searched per run. Beyond this the marginal title repeats the others. */
const MAX_KEYWORDS = 4;

/** Total requests per run, across every keyword. The quota guard. */
const MAX_REQUESTS = 10;

/** What the loop asks an adapter for. */
export interface KeyedPageRequest {
  /** One target title, or an empty string when the user named none. */
  keyword: string;
  /** The first preferred location, or undefined for an unrestricted search. */
  location: string | undefined;
  /** 1-based, because every one of these APIs numbers its pages from one. */
  page: number;
  query: ProviderQuery;
  /** The loop's clock, for adapters whose date filters are relative. */
  now: number;
  /**
   * The resolved credential values, by variable name.
   *
   * These ride on the request rather than on `ProviderContext` because that
   * context is shared with the ATS and feed families, which have no keys and no
   * business holding any. Every name in `requiredCredentials` is present and
   * non-blank by the time `fetchPage` is called — the loop does not start
   * otherwise — so an adapter only needs to guard the optional ones.
   */
  credentials: Readonly<Record<string, string | undefined>>;
}

export interface KeyedPage<TItem> {
  items: TItem[];
  /**
   * Whether another page exists. Adapters that cannot tell should return
   * `items.length > 0` — one wasted request beats truncating a real result set.
   */
  hasMore: boolean;
}

export interface KeyedAdapter<TItem> {
  readonly id: ApiSource;
  readonly label: string;

  /**
   * The credentials this board needs, by environment variable name.
   *
   * These names reach the user: `/api/sources` renders the unavailable reason
   * verbatim in the search screen, so "Set ADZUNA_APP_ID and ADZUNA_APP_KEY"
   * is the whole of the instruction they get. Values are never echoed.
   */
  readonly requiredCredentials: readonly string[];

  fetchPage(request: KeyedPageRequest, ctx: ProviderContext): Promise<KeyedPage<TItem>>;

  /** One result to a `RawJob`, or null when it is not a usable posting. */
  toRawJob(item: TItem, now: number): RawJob | null;
}

export interface KeyedProviderOptions {
  /**
   * Credential values by variable name — `process.env` at the call site. Absent
   * or blank entries make the provider unavailable rather than failing at
   * request time, so the user is told before the run rather than during it.
   */
  credentials?: Readonly<Record<string, string | undefined>>;
  /** Injected so recency filtering is deterministic under test. */
  now?: () => number;
}

export function createKeyedProvider<TItem>(
  adapter: KeyedAdapter<TItem>,
  options: KeyedProviderOptions = {},
): JobProvider {
  const credentials = options.credentials ?? {};
  const now = options.now ?? Date.now;

  const missing = adapter.requiredCredentials.filter((name) => !credentials[name]?.trim());

  return {
    id: adapter.id,
    kind: 'api',
    label: adapter.label,
    unavailableReason:
      missing.length === 0
        ? null
        : `${adapter.label} needs ${missing.length === 1 ? 'an API key' : 'API keys'}. ` +
          `Set ${formatList(missing)} to enable it.`,

    async *search(query: ProviderQuery, ctx: ProviderContext): AsyncGenerator<RawJob> {
      if (missing.length > 0) return;

      const at = now();
      const keywords = keywordsFor(query, adapter.id, ctx);
      const location = query.remoteOnly ? undefined : query.locations[0]?.trim() || undefined;

      // Shared across keywords: the same posting matches several titles, and it
      // is one job either way.
      const seen = new Set<string>();
      let yielded = 0;
      let requests = 0;

      for (const keyword of keywords) {
        if (yielded >= query.maxResults || ctx.signal?.aborted) return;

        for (let page = 1; page <= MAX_PAGES_PER_KEYWORD; page += 1) {
          if (yielded >= query.maxResults || ctx.signal?.aborted) return;

          if (requests >= MAX_REQUESTS) {
            ctx.log?.({
              level: 'info',
              source: adapter.id,
              message:
                `stopped after ${MAX_REQUESTS} requests — the per-run call budget, not the end ` +
                `of the results. Narrow the titles or raise the budget to search further.`,
            });
            return;
          }

          let result: KeyedPage<TItem>;
          requests += 1;
          try {
            result = await adapter.fetchPage(
              { keyword, location, page, query, now: at, credentials },
              ctx,
            );
          } catch (error) {
            if (isAbortError(error)) return;
            // A failed keyword is not a failed source: the next title may work,
            // and a board that rate-limits one call often serves the next.
            ctx.log?.({
              level: 'warn',
              source: adapter.id,
              message: `"${keyword || 'all jobs'}" page ${page}: ${describeFailure(error)}`,
            });
            break;
          }

          const matched: RawJob[] = [];
          for (const item of result.items) {
            let raw: RawJob | null;
            try {
              raw = adapter.toRawJob(item, at);
            } catch (error) {
              ctx.log?.({
                level: 'debug',
                source: adapter.id,
                message: `skipped an unreadable posting — ${describeFailure(error)}`,
              });
              continue;
            }
            if (!raw || seen.has(raw.sourceJobId)) continue;
            if (!matchesQuery(raw, query, { now: at })) continue;
            seen.add(raw.sourceJobId);
            matched.push(raw);
          }

          rankByRelevance(matched, query.titles);

          for (const job of matched.slice(0, query.maxResults - yielded)) {
            yield job;
            yielded += 1;
          }

          if (!result.hasMore) break;
        }
      }

      ctx.log?.({
        level: 'debug',
        source: adapter.id,
        message: `${yielded} postings from ${requests} requests across ${keywords.length} searches`,
      });
    },
  };
}

/**
 * The titles to search, capped.
 *
 * An empty list is not an error: it becomes a single unrestricted search, which
 * these boards accept and which is the right reading of "the user has not said
 * what they want yet". Beyond the cap the marginal title mostly returns what the
 * earlier ones already did, at full quota price — so it is dropped, and said so.
 */
function keywordsFor(query: ProviderQuery, source: ApiSource, ctx: ProviderContext): string[] {
  const titles = query.titles.map((title) => title.trim()).filter(Boolean);
  if (titles.length === 0) return [''];

  if (titles.length > MAX_KEYWORDS) {
    ctx.log?.({
      level: 'info',
      source,
      message:
        `searched the first ${MAX_KEYWORDS} of ${titles.length} target titles — ` +
        `${titles.slice(MAX_KEYWORDS).join(', ')} were not searched`,
    });
  }
  return titles.slice(0, MAX_KEYWORDS);
}

/** "A and B", "A, B and C" — this ends up in front of the user. */
function formatList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? '';
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

export { MAX_KEYWORDS, MAX_PAGES_PER_KEYWORD, MAX_REQUESTS };
