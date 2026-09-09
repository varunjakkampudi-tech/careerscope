/**
 * The shape every ATS provider shares.
 *
 * All six ATS APIs work the same way: you name a company, they hand back that
 * company's whole board. None of them accept a search term. So each provider is
 * the same loop — walk the curated slug list, pull each board, filter locally —
 * differing only in the URL, the JSON shape, and whether descriptions arrive in
 * the list or need a second request. That loop lives here; the adapters supply
 * only what is genuinely per-ATS.
 *
 * Two behaviours in this loop matter more than they look:
 *
 * **A dead board must not cost the user the other seventy.** Slugs rot, boards
 * 404, and one company's API having a bad afternoon is not a reason to end a
 * run. Every board is isolated: it fails, it is logged, the walk continues.
 *
 * **Board budget is shared fairly.** Without a per-board cap, one 775-posting
 * board at the top of the list would consume the entire result budget and the
 * user would never see the other sixty companies. Each board gets an equal
 * share, and a board that comes in under its share passes the remainder forward
 * rather than wasting it.
 */

import type { AtsSource, ProviderQuery, RawJob } from '@job-radar/shared';
import { boardsFor, type BoardRef } from '../boards.js';
import { matchesQuery } from '../filter.js';
import { describeFailure, rankByRelevance } from '../rank.js';
import { HttpError, isAbortError, type RequestOptions } from '../http.js';
import type { JobProvider, ProviderContext } from '../types.js';

/**
 * Even a large slug list should never squeeze a board down to one posting — at
 * that point the cap is deciding the search results, which is the matching
 * engine's job.
 */
const MIN_PER_BOARD = 3;

/** What one ATS has to supply. Everything else is handled by the loop. */
export interface BoardAdapter<TItem> {
  readonly id: AtsSource;
  readonly label: string;

  /**
   * Every posting on one board. An unknown slug returns `[]` rather than
   * throwing — a 404 from a board API means "no such company", which is an
   * answer, not a failure.
   */
  listBoard(board: BoardRef, ctx: ProviderContext, query: ProviderQuery): Promise<TItem[]>;

  /** One posting to a `RawJob`, or null when the item is not a live listing. */
  toRawJob(item: TItem, board: BoardRef): RawJob | null;

  /**
   * Fetch the description for boards whose list endpoint omits it. Left
   * undefined by the ATSs that return descriptions inline, so the orchestrator
   * knows not to spend a request.
   */
  fetchDetail?(job: RawJob, ctx: ProviderContext): Promise<RawJob>;
}

export interface BoardProviderOptions {
  /** Override the curated list — used by tests and by discovered boards. */
  boards?: readonly BoardRef[];
  /** Injected so recency filtering is deterministic under test. */
  now?: () => number;
}

export function createBoardProvider<TItem>(
  adapter: BoardAdapter<TItem>,
  options: BoardProviderOptions = {},
): JobProvider {
  const boards = options.boards ?? boardsFor(adapter.id);
  const now = options.now ?? (() => Date.now());

  const provider: JobProvider = {
    id: adapter.id,
    kind: 'ats',
    label: adapter.label,
    unavailableReason:
      boards.length > 0 ? null : `No ${adapter.label} company boards are configured.`,

    async *search(query: ProviderQuery, ctx: ProviderContext): AsyncGenerator<RawJob> {
      const share = Math.max(
        MIN_PER_BOARD,
        Math.ceil(query.maxResults / Math.max(1, boards.length)),
      );
      let allowance = 0;
      let yielded = 0;

      for (const board of boards) {
        if (yielded >= query.maxResults) return;
        // Cancellation ends the walk quietly: the run was stopped, which is not
        // a provider failure and should not be reported as one.
        if (ctx.signal?.aborted) return;

        allowance += share;

        let items: TItem[];
        try {
          items = await adapter.listBoard(board, ctx, query);
        } catch (error) {
          if (isAbortError(error)) return;
          ctx.log?.({
            level: 'warn',
            source: adapter.id,
            message: `${board.company} (${board.slug}): ${describeFailure(error)}`,
          });
          continue;
        }

        const matched: RawJob[] = [];
        for (const item of items) {
          let raw: RawJob | null;
          try {
            raw = adapter.toRawJob(item, board);
          } catch (error) {
            // One malformed posting is not worth losing the rest of the board.
            ctx.log?.({
              level: 'debug',
              source: adapter.id,
              message: `${board.company}: skipped an unreadable posting — ${describeFailure(error)}`,
            });
            continue;
          }
          if (raw && matchesQuery(raw, query, { now: now() })) matched.push(raw);
        }

        rankByRelevance(matched, query.titles);

        const take = Math.min(allowance, query.maxResults - yielded, matched.length);
        for (const job of matched.slice(0, take)) {
          yield job;
          yielded += 1;
          allowance -= 1;
        }

        ctx.log?.({
          level: 'debug',
          source: adapter.id,
          message: `${board.company}: ${matched.length} of ${items.length} postings matched, ${take} kept`,
        });
      }
    },
  };

  if (adapter.fetchDetail) {
    provider.fetchDetail = (job, ctx) => adapter.fetchDetail!(job, ctx);
  }

  return provider;
}

/* -------------------------------------------------------------------------- */
/* Shared board plumbing                                                      */
/* -------------------------------------------------------------------------- */

/** A slug that no longer exists. Not an error — just nothing to read. */
const GONE = new Set([404, 410]);

/**
 * Fetch a board's JSON, treating "no such company" as an empty board.
 *
 * Company slugs go stale: a company migrates ATS, renames itself, or takes its
 * board private. That produces a 404, which is a definite answer and should not
 * be retried, logged as a failure, or allowed to look like an outage.
 */
export async function boardJson<T>(
  ctx: ProviderContext,
  url: string,
  options: RequestOptions = {},
): Promise<T | null> {
  const response = await ctx.http.get(url, {
    ...options,
    signal: ctx.signal,
    headers: { accept: 'application/json', ...options.headers },
    acceptStatuses: [...GONE, ...(options.acceptStatuses ?? [])],
  });
  if (GONE.has(response.status)) return null;
  return parseBoardJson<T>(response.body, url, response.status);
}

/** As `boardJson`, for the one ATS whose list endpoint is a POST. */
export async function boardPostJson<T>(
  ctx: ProviderContext,
  url: string,
  body: unknown,
  options: RequestOptions = {},
): Promise<T | null> {
  try {
    return await ctx.http.postJson<T>(url, body, { ...options, signal: ctx.signal });
  } catch (error) {
    if (error instanceof HttpError && error.status !== null && GONE.has(error.status)) return null;
    throw error;
  }
}

function parseBoardJson<T>(body: string, url: string, status: number): T {
  try {
    return JSON.parse(body) as T;
  } catch (error) {
    // Boards answer HTML when they mean "logged out" or "blocked". Saying which
    // URL did it turns a bare SyntaxError into something actionable.
    throw new HttpError('the board returned something that was not JSON', {
      kind: 'http',
      url,
      status,
      body: body.slice(0, 300),
      cause: error,
    });
  }
}

/**
 * An identifier that addresses a posting on a company-scoped API.
 *
 * These APIs have no global job endpoint: fetching one Workable posting needs
 * both the account and the shortcode, and the same is true of Greenhouse and
 * SmartRecruiters. So the board token is genuinely part of the posting's
 * address, and carrying both here is what lets `fetchDetail` work from a
 * `RawJob` alone.
 */
export function boardScopedId(slug: string, id: string | number): string {
  return `${slug}:${id}`;
}

export function splitBoardScopedId(value: string): { slug: string; id: string } | null {
  const at = value.indexOf(':');
  if (at <= 0 || at === value.length - 1) return null;
  return { slug: value.slice(0, at), id: value.slice(at + 1) };
}
