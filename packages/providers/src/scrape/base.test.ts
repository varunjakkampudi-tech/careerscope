/**
 * The scrape provider shell.
 *
 * `base.ts` owns the three guarantees that make this tier worth trusting, and
 * not one of them is visible from inside an adapter: a refusal is reported as a
 * refusal, a cancelled run says nothing rather than "no jobs found", and the
 * browser is always given back. All three fail *quietly* — the run finishes
 * either way, with a number in it that looks like an answer — so they are pinned
 * here rather than left to review.
 *
 * The adapter under test is a recorder, not a scraper. LinkedIn, Naukri and
 * Indeed each have their own suite for the site-specific half; what is left for
 * this one is the control flow around them, which is identical whichever site is
 * on the other end. That also means no page, no browser and no network: the only
 * real objects here are `BrowserPool` and a Chromium made of counters.
 */

import type { ProviderQuery, RawJob, ScrapeSource } from '@job-radar/shared';
import type { Browser, BrowserContext, Page } from 'playwright';
import { describe, expect, it, vi } from 'vitest';
import { collect, query } from '../harness.fixtures.js';
import { HttpError } from '../http.js';
import type { ProviderEvent } from '../types.js';
import {
  closeSharedBrowser,
  createScrapeProvider,
  SCRAPERS_DISABLED_REASON,
  type ScrapeAdapter,
  type ScrapeContext,
  type ScrapePage,
} from './base.js';
import { type BlockDetection, describeEmptyOutcome, detectBlock } from './block.js';
import { BrowserPool, PLAYWRIGHT_MISSING_REASON, type ScrapeSession } from './browser.js';
import { scrapeContext } from './harness.fixtures.js';

const SOURCE: ScrapeSource = 'linkedin';
const NOTE = 'Detail pages are robots-disallowed here, so every lead is capped at 80%.';
const AT = Date.parse('2026-09-06T00:00:00Z');

/** A wall with the real wording, so a test never quotes a copy of block.ts. */
const WALL = detectBlock(SOURCE, { status: 403 })!;

/* -------------------------------------------------------------------------- */
/* An adapter that only records                                               */
/* -------------------------------------------------------------------------- */

interface Card {
  id: string;
  title?: string;
  postedAt?: string;
  /** Makes `toRawJob` throw — one malformed card planted in a good page. */
  poison?: boolean;
  /** Makes `toRawJob` return null — a row that is not a lead. */
  unusable?: boolean;
}

type Walk = (
  ctx: ScrapeContext,
  query: ProviderQuery,
  now: number,
) => AsyncIterable<ScrapePage<Card>>;

interface AdapterSpec {
  needsBrowser?: boolean;
  note?: string;
  /** Pages served in order, pulled only as the shell asks for them. */
  pages?: ReadonlyArray<ScrapePage<Card>>;
  /** Replaces `pages` when the walk itself has to misbehave. */
  walk?: Walk;
  detail?: (job: RawJob, ctx: ScrapeContext) => Promise<RawJob>;
}

function recordingAdapter(spec: AdapterSpec = {}): {
  adapter: ScrapeAdapter<Card>;
  /** One entry per `pages()` call: the query, the clock, the session. */
  walks: Array<{ query: ProviderQuery; at: number; session: ScrapeSession | undefined }>;
  /** The `now` each `toRawJob` was handed, in order. */
  mappedAt: number[];
  /** Indexes of the pages the shell actually pulled. */
  served: number[];
  detailed: Array<{ job: RawJob; ctx: ScrapeContext }>;
} {
  const walks: Array<{ query: ProviderQuery; at: number; session: ScrapeSession | undefined }> = [];
  const mappedAt: number[] = [];
  const served: number[] = [];
  const detailed: Array<{ job: RawJob; ctx: ScrapeContext }> = [];

  const base: ScrapeAdapter<Card> = {
    id: SOURCE,
    label: 'Recorder',
    needsBrowser: spec.needsBrowser ?? false,
    ...(spec.note ? { note: spec.note } : {}),

    async *pages(ctx, q, at) {
      walks.push({ query: q, at, session: ctx.session });
      if (spec.walk) {
        yield* spec.walk(ctx, q, at);
        return;
      }
      for (const [index, item] of (spec.pages ?? []).entries()) {
        served.push(index);
        yield item;
      }
    },

    toRawJob(item, at) {
      mappedAt.push(at);
      if (item.poison) throw new Error(`unreadable card ${item.id}`);
      if (item.unusable) return null;
      return {
        source: SOURCE,
        sourceJobId: item.id,
        title: item.title ?? `Role ${item.id}`,
        companyName: `Company ${item.id}`,
        hasFullDescription: false,
        sourceUrl: `https://example.test/${item.id}`,
        ...(item.postedAt ? { postedAt: item.postedAt } : {}),
      };
    },
  };

  const adapter: ScrapeAdapter<Card> = spec.detail
    ? {
        ...base,
        async fetchDetail(job, ctx) {
          detailed.push({ job, ctx });
          return spec.detail!(job, ctx);
        },
      }
    : base;

  return { adapter, walks, mappedAt, served, detailed };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function cards(count: number, prefix = 'c'): Card[] {
  return Array.from({ length: count }, (_, index) => ({ id: `${prefix}${index}` }));
}

function page(items: Card[], block?: BlockDetection): ScrapePage<Card> {
  return block ? { items, block } : { items };
}

/** The run log, flattened — every assertion here is about level *and* wording. */
function log(ctx: { events: ProviderEvent[] }): string[] {
  return ctx.events.map((event) => `${event.level}: ${event.message}`);
}

/** A cancellation in the shape the DOM throws it. */
function cancelled(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/** A walk that dies before it produces anything — the first page never loads. */
function failingWalk(error: Error): Walk {
  // A generator whose entire job is to throw has no `yield` to give.
  // eslint-disable-next-line require-yield
  return async function* (): AsyncIterable<ScrapePage<Card>> {
    throw error;
  };
}

/**
 * A pool over a Chromium made of counters.
 *
 * The real `BrowserPool` is used deliberately: what is under test is that the
 * shell takes a lease, opens through it, and gives both back — a fake pool would
 * only prove the shell calls the methods a fake pool has.
 */
function chromium(): {
  pool: BrowserPool;
  launches: () => number;
  closed: { browser: number; contexts: number };
} {
  const closed = { browser: 0, contexts: 0 };
  let launches = 0;

  const browser = {
    newContext: async () => ({
      setDefaultNavigationTimeout: () => undefined,
      setDefaultTimeout: () => undefined,
      route: async () => undefined,
      newPage: async () => ({}),
      close: async () => void (closed.contexts += 1),
    }),
    close: async () => void (closed.browser += 1),
  } as unknown as Browser;

  const pool = new BrowserPool({
    launch: async () => {
      launches += 1;
      return browser;
    },
  });

  return { pool, launches: () => launches, closed };
}

/**
 * A pool whose teardown throws.
 *
 * Duck-typed and cast, because this state is unreachable through the real pool —
 * it already swallows a context that will not close. What is being exercised is
 * the layer above: if `dispose()` or `release()` rejected and `base.ts` did not
 * guard them, the `finally` would throw, the caller would lose both the results
 * already yielded and the terminal log, and the browser would never be reaped.
 */
function brokenPool(failures: { dispose?: boolean; release?: boolean }): {
  pool: BrowserPool;
  seen: { disposed: number; released: number };
} {
  const seen = { disposed: 0, released: 0 };

  const release = async (): Promise<void> => {
    seen.released += 1;
    if (failures.release) throw new Error('release blew up');
  };

  const open = async (): Promise<ScrapeSession> => ({
    page: {} as Page,
    context: {} as BrowserContext,
    dispose: async () => {
      seen.disposed += 1;
      if (failures.dispose) throw new Error('dispose blew up');
    },
  });

  const pool = { open } as unknown as BrowserPool;
  Object.assign(pool, { lease: async () => ({ pool, release }) });

  return { pool, seen };
}

/** The shell, wired to a fixed clock so recency is never the wall clock. */
function provide(adapter: ScrapeAdapter<Card>, options: { pool?: BrowserPool } = {}) {
  return createScrapeProvider(adapter, { enableScrapers: true, now: () => AT, ...options });
}

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

describe('unavailableReason', () => {
  it('is dark by default, and says so in a sentence a settings screen can render', () => {
    const provider = createScrapeProvider(recordingAdapter().adapter);

    // Resolved at construction, not on search: `/api/sources` prints this
    // verbatim, and finding out should not cost a run.
    expect(provider.unavailableReason).toBe(SCRAPERS_DISABLED_REASON);
    expect(provider.unavailableReason).toContain('ENABLE_SCRAPERS=true');
  });

  it('clears once the flag is on', () => {
    expect(provide(recordingAdapter().adapter).unavailableReason).toBeNull();
    expect(provide(recordingAdapter({ needsBrowser: true }).adapter).unavailableReason).toBeNull();
  });

  it('names the missing browser rather than reporting an empty source', async () => {
    vi.resetModules();
    vi.doMock('./browser.js', async () => ({
      ...(await vi.importActual<typeof import('./browser.js')>('./browser.js')),
      isPlaywrightInstalled: () => false,
    }));

    try {
      const { createScrapeProvider: create } = await import('./base.js');
      const provider = create(recordingAdapter({ needsBrowser: true }).adapter, {
        enableScrapers: true,
      });

      // The distinction that matters on a server built without Chromium: the
      // source is off because a dependency is absent, and the row says which
      // command fixes it — rather than running and finding nothing, forever.
      expect(provider.unavailableReason).toBe(PLAYWRIGHT_MISSING_REASON);
    } finally {
      vi.doUnmock('./browser.js');
      vi.resetModules();
    }
  });

  it('leaves a source that needs no browser alone about one', async () => {
    vi.resetModules();
    vi.doMock('./browser.js', async () => ({
      ...(await vi.importActual<typeof import('./browser.js')>('./browser.js')),
      isPlaywrightInstalled: () => false,
    }));

    try {
      const { createScrapeProvider: create } = await import('./base.js');

      // LinkedIn's guest endpoints answer a plain HTTP client, so an install
      // with no Chromium still has a working scrape source.
      expect(
        create(recordingAdapter().adapter, { enableScrapers: true }).unavailableReason,
      ).toBeNull();
    } finally {
      vi.doUnmock('./browser.js');
      vi.resetModules();
    }
  });

  it('carries the adapter through to the source list', () => {
    const provider = provide(recordingAdapter().adapter);

    expect(provider.id).toBe(SOURCE);
    expect(provider.kind).toBe('scrape');
    expect(provider.label).toBe('Recorder');
  });

  it('does not walk, or say anything, while it is unavailable', async () => {
    const ctx = scrapeContext();
    const { adapter, walks } = recordingAdapter({ note: NOTE, pages: [page(cards(3))] });

    // Off by default, so no `enableScrapers` here.
    const jobs = await collect(
      createScrapeProvider(adapter, { now: () => AT }).search(query(), ctx),
    );

    expect(jobs).toEqual([]);
    expect(walks).toEqual([]);
    // Silent, not "0 postings matched": a source that never ran must not appear
    // in the run log as one that answered.
    expect(log(ctx)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The standing note                                                          */
/* -------------------------------------------------------------------------- */

describe('search — the standing note', () => {
  it('states the limitation before the walk, not after it', async () => {
    const ctx = scrapeContext();
    let atWalk: string[] = [];
    const { adapter } = recordingAdapter({
      note: NOTE,
      walk: async function* () {
        atWalk = log(ctx);
        yield page(cards(1));
      },
    });

    await collect(provide(adapter).search(query(), ctx));

    // Already logged by the time the first page is asked for — so it lands
    // whatever the outcome, including the outcome it exists to explain.
    expect(atWalk).toEqual([`info: ${NOTE}`]);
  });

  it('states it even when the source comes back with nothing', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({ note: NOTE, pages: [] });

    await collect(provide(adapter).search(query(), ctx));

    // The case that motivated the field. Indeed's leads are capped at 80% and
    // none clear the default 85% threshold; without this line the run reads as
    // "Indeed found nothing", which is both wrong and unfalsifiable.
    expect(log(ctx)).toEqual([`info: ${NOTE}`, `debug: ${describeEmptyOutcome(SOURCE, 0, null)}`]);
  });

  it('states it once per search, not once per page', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({
      note: NOTE,
      pages: [page(cards(1, 'a')), page(cards(1, 'b')), page(cards(1, 'c'))],
    });

    await collect(provide(adapter).search(query(), ctx));

    expect(ctx.events.filter((event) => event.level === 'info')).toHaveLength(1);
  });

  it('says nothing when the adapter has no limitation to declare', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({ pages: [page(cards(1))] });

    await collect(provide(adapter).search(query(), ctx));

    expect(ctx.events.some((event) => event.level === 'info')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Yielding                                                                   */
/* -------------------------------------------------------------------------- */

describe('search — what comes out', () => {
  it("yields the adapter's postings untouched", async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({ pages: [page(cards(2))] });

    const jobs = await collect(provide(adapter).search(query(), ctx));

    // Asserted whole: the shell is a pipe, and a field quietly added or dropped
    // here would be attributed to the adapter by every suite that tests one.
    expect(jobs).toEqual([
      {
        source: SOURCE,
        sourceJobId: 'c0',
        title: 'Role c0',
        companyName: 'Company c0',
        hasFullDescription: false,
        sourceUrl: 'https://example.test/c0',
      },
      {
        source: SOURCE,
        sourceJobId: 'c1',
        title: 'Role c1',
        companyName: 'Company c1',
        hasFullDescription: false,
        sourceUrl: 'https://example.test/c1',
      },
    ]);
  });

  it('drops a row the adapter says is not a lead', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({
      pages: [page([{ id: 'a' }, { id: 'b', unusable: true }, { id: 'c' }])],
    });

    const jobs = await collect(provide(adapter).search(query(), ctx));

    // A `null` from `toRawJob` is a decision, not a fault — nothing is logged,
    // but the row still counts as scanned.
    expect(jobs.map((job) => job.sourceJobId)).toEqual(['a', 'c']);
    expect(log(ctx)).toEqual(['debug: 2 of 3 postings matched']);
  });

  it('loses one unreadable card, not the page it was on', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({
      pages: [page([{ id: 'a' }, { id: 'b', poison: true }, { id: 'c' }])],
    });

    const jobs = await collect(provide(adapter).search(query(), ctx));

    expect(jobs.map((job) => job.sourceJobId)).toEqual(['a', 'c']);
    expect(log(ctx)).toEqual([
      'debug: skipped an unreadable posting — unreadable card b',
      'debug: 2 of 3 postings matched',
    ]);
  });

  it('runs the query filter locally, and counts what it rejected', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({
      pages: [page([{ id: 'a' }, { id: 'b', title: 'Sales Engineer' }, { id: 'c' }])],
    });

    const jobs = await collect(provide(adapter).search(query({ excludeKeywords: ['sales'] }), ctx));

    // "2 of 3" rather than "2 of 2": the denominator is what the source
    // returned, which is the number that says whether the source is healthy.
    expect(jobs.map((job) => job.sourceJobId)).toEqual(['a', 'c']);
    expect(log(ctx)).toEqual(['debug: 2 of 3 postings matched']);
  });

  it('reads the clock once for the whole walk', async () => {
    const ctx = scrapeContext();
    const { adapter, walks, mappedAt } = recordingAdapter({
      pages: [page(cards(2, 'a')), page(cards(2, 'b'))],
    });
    let reads = 0;
    const moving = () => {
      reads += 1;
      return AT + reads * 60_000;
    };

    await collect(
      createScrapeProvider(adapter, { enableScrapers: true, now: moving }).search(query(), ctx),
    );

    // One reading, shared by the walk and every mapping. Otherwise a posting
    // could be inside the recency window on page one and outside it on page
    // four, purely because the run took a minute.
    expect(reads).toBe(1);
    expect(walks[0]?.at).toBe(AT + 60_000);
    expect(new Set(mappedAt)).toEqual(new Set([AT + 60_000]));
  });

  it('stops mid-page at the result budget', async () => {
    const ctx = scrapeContext();
    const { adapter, served } = recordingAdapter({
      pages: [page(cards(5, 'a')), page(cards(5, 'b'))],
    });

    const jobs = await collect(provide(adapter).search(query({ maxResults: 2 }), ctx));

    expect(jobs.map((job) => job.sourceJobId)).toEqual(['a0', 'a1']);
    // And does not pay for the next page to discover it was already full.
    expect(served).toEqual([0]);
  });

  it('ranks a page before the budget cuts it', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({
      pages: [
        page([
          { id: 'near', title: 'Full Stack Engineer' },
          { id: 'exact', title: 'Backend Engineer' },
        ]),
      ],
    });

    const jobs = await collect(
      provide(adapter).search(query({ titles: ['Backend Engineer'], maxResults: 1 }), ctx),
    );

    // Both survive the filter, and the source returned them worst-first. With
    // the cap applied in arrival order the user would get the weaker match and
    // never learn the better one existed.
    expect(jobs.map((job) => job.sourceJobId)).toEqual(['exact']);
  });

  it('falls back to freshness when no title is targeted', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({
      pages: [
        page([
          { id: 'old', postedAt: '2026-01-04' },
          { id: 'new', postedAt: '2026-09-01' },
        ]),
      ],
    });

    const jobs = await collect(provide(adapter).search(query({ maxResults: 1 }), ctx));

    expect(jobs.map((job) => job.sourceJobId)).toEqual(['new']);
  });
});

/* -------------------------------------------------------------------------- */
/* Detail                                                                     */
/* -------------------------------------------------------------------------- */

describe('search — the detail fetch', () => {
  it('spends a request only on postings that survived and fit', async () => {
    const ctx = scrapeContext();
    const { adapter, detailed } = recordingAdapter({
      pages: [page([{ id: 'a' }, { id: 'b', title: 'Sales Engineer' }, { id: 'c' }])],
      detail: async (job) => ({ ...job, description: 'full text', hasFullDescription: true }),
    });

    const jobs = await collect(
      provide(adapter).search(query({ excludeKeywords: ['sales'], maxResults: 1 }), ctx),
    );

    // Three cards on the page; one filtered out, one over budget. The detail
    // fetch is the expensive half of a scrape — one request per posting — so it
    // runs once, after both gates, not three times before them.
    expect(detailed.map((call) => call.job.sourceJobId)).toEqual(['a']);
    expect(jobs[0]?.hasFullDescription).toBe(true);
    expect(jobs[0]?.description).toBe('full text');
  });

  it('hands the detail fetch the same session the walk was given', async () => {
    const ctx = scrapeContext();
    const { pool } = chromium();
    const { adapter, walks, detailed } = recordingAdapter({
      needsBrowser: true,
      pages: [page(cards(1))],
      detail: async (job) => job,
    });

    await collect(provide(adapter, { pool }).search(query(), ctx));

    // One context per source per run: a detail navigation that opened its own
    // would throw away the cookies the search page just set.
    expect(detailed[0]?.ctx.session).toBe(walks[0]?.session);
    expect(detailed[0]?.ctx.session).toBeDefined();
  });

  it('keeps the lead when the detail fetch is refused', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({
      pages: [page(cards(1))],
      detail: async () => {
        throw new HttpError('Forbidden', {
          kind: 'http',
          url: 'https://example.test/jobs/c0?key=SUPER-SECRET',
          status: 403,
        });
      },
    });

    const jobs = await collect(provide(adapter).search(query(), ctx));

    // Title, company and an apply link is still a usable lead. It stays
    // `hasFullDescription: false`, which the engine reads as low confidence and
    // caps at 80% — so a posting we could not read can never claim to clear 85%.
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.hasFullDescription).toBe(false);
    expect(log(ctx)).toEqual([
      'debug: kept "Role c0" without its full description — HTTP 403',
      // The per-posting line above is `debug`, which most run logs do not show.
      // This one is `info`, and it is the one that reaches the user: without it
      // a lead is silently capped at 80% and nothing on screen says why.
      'info: 1 of 1 postings could not be read in full — their descriptions were unavailable, so they are marked low-confidence and capped at 80%.',
      'debug: 1 of 1 postings matched',
    ]);
    // The run log is a user-facing surface. Some of these URLs carry keys.
    expect(log(ctx).join('\n')).not.toContain('SUPER-SECRET');
  });

  it('says nothing about descriptions when every one of them was read', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({
      pages: [page(cards(2))],
      detail: async (job) => ({ ...job, description: 'x'.repeat(600), hasFullDescription: true }),
    });

    await collect(provide(adapter).search(query(), ctx));

    // The caveat has to stay rare to stay meaningful. A line that appears on
    // every successful run is one the user learns to skip, and then it is not
    // there on the run where two leads really were capped.
    expect(log(ctx)).toEqual(['debug: 2 of 2 postings matched']);
  });

  it('does not blame a source for a description it never promised to fetch', async () => {
    const ctx = scrapeContext();
    // No `detail`, so the adapter has no `fetchDetail` at all — Indeed's shape,
    // where the detail page is robots-disallowed and every lead is a summary by
    // design. That is a standing limitation `note` already states once per run;
    // reporting it again per-run as though the fetch had failed would turn a
    // deliberate choice into an apparent malfunction.
    const { adapter } = recordingAdapter({ pages: [page(cards(2))] });

    const jobs = await collect(provide(adapter).search(query(), ctx));

    expect(jobs.every((job) => !job.hasFullDescription)).toBe(true);
    expect(log(ctx)).toEqual(['debug: 2 of 2 postings matched']);
  });

  it('lets a cancelled detail fetch end the run', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({
      pages: [page(cards(2))],
      detail: async (job) => {
        if (job.sourceJobId === 'c1') {
          throw new HttpError('aborted', { kind: 'aborted', url: 'https://example.test/jobs/c1' });
        }
        return job;
      },
    });

    const jobs = await collect(provide(adapter).search(query(), ctx));

    // A cancellation is the one failure `withDetail` rethrows: swallowing it
    // would keep the run walking a source the user has already stopped.
    expect(jobs.map((job) => job.sourceJobId)).toEqual(['c0']);
    // And it leaves no trace in the log — see the cancellation suite.
    expect(log(ctx)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Blocks                                                                     */
/* -------------------------------------------------------------------------- */

describe('search — being turned away', () => {
  it('says "blocked" rather than "nothing found" when nothing got through', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({ pages: [page([], WALL)] });

    const jobs = await collect(provide(adapter).search(query(), ctx));

    expect(jobs).toEqual([]);
    // A warning, and in the block's own words — "0 postings matched" here would
    // read as a quiet market and send the user away for a day.
    expect(log(ctx)).toEqual([`warn: ${WALL.message}`]);
    expect(WALL.message).toContain('this is a refusal, not an empty result');
  });

  it('keeps what came before the wall and calls the source partial', async () => {
    const ctx = scrapeContext();
    const { adapter, served } = recordingAdapter({
      pages: [page(cards(2, 'a')), page(cards(2, 'b'), WALL), page(cards(2, 'c'))],
    });

    const jobs = await collect(provide(adapter).search(query(), ctx));

    expect(jobs.map((job) => job.sourceJobId)).toEqual(['a0', 'a1']);
    // The most misleading state of all: leads on screen, and a source that was
    // never fully read. The number is what actually came through — the walled
    // page contributed nothing — and page three is never asked for.
    expect(log(ctx)).toEqual([
      `warn: ${WALL.message} 2 postings had already been read, so this source is partial.`,
    ]);
    expect(served).toEqual([0, 1]);
  });

  it('writes the singular when exactly one posting made it through', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({ pages: [page(cards(1, 'a')), page([], WALL)] });

    await collect(provide(adapter).search(query(), ctx));

    expect(log(ctx)).toEqual([
      `warn: ${WALL.message} 1 posting had already been read, so this source is partial.`,
    ]);
  });

  it('tells a quiet query apart from a wall', async () => {
    const empty = scrapeContext();
    await collect(provide(recordingAdapter({ pages: [page([])] }).adapter).search(query(), empty));

    // Nothing there, and the source said so plainly. Debug, not warn: this is
    // an answer, and warning about it would train the user to ignore warnings.
    expect(log(empty)).toEqual([`debug: ${describeEmptyOutcome(SOURCE, 0, null)}`]);
    expect(log(empty)[0]).toContain('The source answered normally');

    const filtered = scrapeContext();
    const { adapter } = recordingAdapter({
      pages: [page([{ id: 'a', title: 'Sales Engineer' }])],
    });
    await collect(provide(adapter).search(query({ excludeKeywords: ['sales'] }), filtered));

    // Postings arrived; our own filters rejected them. A different sentence,
    // because it points at the query rather than at the source.
    expect(log(filtered)).toEqual([`debug: ${describeEmptyOutcome(SOURCE, 1, null)}`]);
    expect(log(filtered)[0]).toContain('none of which matched');
  });
});

/* -------------------------------------------------------------------------- */
/* Failure                                                                    */
/* -------------------------------------------------------------------------- */

describe('search — when the walk fails', () => {
  it('keeps what a source delivered before it died', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({
      walk: async function* () {
        yield page(cards(2, 'a'));
        throw new Error('the page never loaded');
      },
    });

    const jobs = await collect(provide(adapter).search(query(), ctx));

    // A source that dies halfway still found what it found — and the last line
    // has to say so itself. This assertion used to expect "2 of 2 postings
    // matched", on the theory that the warning above it carried the caveat. It
    // does not: the warning scrolls, the count is what gets read as the
    // conclusion, and "2 of 2" is a sentence about a source that was fully
    // walked. Two of an unknown number is a different result.
    expect(jobs.map((job) => job.sourceJobId)).toEqual(['a0', 'a1']);
    expect(log(ctx)).toEqual([
      'warn: the page never loaded',
      'warn: This source stopped on an error, reported above. 2 postings had already been read, so this source is partial.',
    ]);
    expect(log(ctx)[1]).not.toContain('2 of 2');
  });

  it('does not take the rest of the run down with it', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({ walk: failingWalk(new Error('boom')) });

    // Resolves rather than rejects. One dead source must cost the user that
    // source, not the four that were still walking beside it.
    await expect(collect(provide(adapter).search(query(), ctx))).resolves.toEqual([]);

    // Swallowing the throw is what keeps the run alive; `failed` is what stops
    // that from being reported as health. The old expectation here was the
    // plain empty line — "The source answered normally" — printed directly
    // beneath a stack trace, which is the exact contradiction a live run
    // produced and this branch exists to prevent.
    expect(log(ctx)).toEqual([
      'warn: boom',
      `warn: ${describeEmptyOutcome(SOURCE, 0, null, true)}`,
    ]);
    expect(log(ctx)[1]).toContain('This is a fault, not an empty result.');
    expect(log(ctx)[1]).not.toContain('answered normally');
  });

  it('does not call a fault an empty market when postings were read but none matched', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({
      walk: async function* () {
        // Every card is rejected locally, so the walk both reads postings and
        // yields none — the one shape where "0 results" and "we crashed"
        // collide, and the count alone cannot tell them apart.
        yield page([
          { id: 'a', unusable: true },
          { id: 'b', unusable: true },
          { id: 'c', unusable: true },
        ]);
        throw new Error('the connection dropped');
      },
    });

    await expect(collect(provide(adapter).search(query(), ctx))).resolves.toEqual([]);

    const [, terminal = ''] = log(ctx);
    expect(terminal).toContain('after reading 3 postings');
    expect(terminal).toContain('This is a fault, not an empty result.');
    // A fault is a warning even at zero, because the number is not the news.
    expect(terminal.startsWith('warn:')).toBe(true);
  });

  it('reports an HTTP failure as a status, never as a URL', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({
      walk: failingWalk(
        new HttpError('Service Unavailable', {
          kind: 'http',
          url: 'https://example.test/search?api_key=SUPER-SECRET',
          status: 503,
        }),
      ),
    });

    await collect(provide(adapter).search(query(), ctx));

    expect(log(ctx)[0]).toBe('warn: HTTP 503');
    expect(log(ctx).join('\n')).not.toContain('SUPER-SECRET');
  });
});

/* -------------------------------------------------------------------------- */
/* Cancellation                                                               */
/* -------------------------------------------------------------------------- */

describe('search — when the run is cancelled', () => {
  it('goes silent rather than reporting an empty source', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = { ...scrapeContext(), signal: controller.signal };
    const { adapter } = recordingAdapter({ note: NOTE, pages: [page(cards(3))] });

    const jobs = await collect(provide(adapter).search(query(), ctx));

    expect(jobs).toEqual([]);
    // The note is still stated — it is said before the walk on purpose — but
    // there is no terminal line. "linkedin returned no postings" after the user
    // pressed cancel is a claim about the market that nobody made.
    expect(log(ctx)).toEqual([`info: ${NOTE}`]);
  });

  it('stops asking for pages the moment it is cancelled', async () => {
    const controller = new AbortController();
    const ctx = { ...scrapeContext(), signal: controller.signal };
    const { adapter, served } = recordingAdapter({
      walk: async function* () {
        yield page(cards(2, 'a'));
        controller.abort();
        yield page(cards(2, 'b'));
        yield page(cards(2, 'c'));
      },
    });

    const jobs = await collect(provide(adapter).search(query(), ctx));

    // Page one's leads survive — they were already found and handed over.
    expect(jobs.map((job) => job.sourceJobId)).toEqual(['a0', 'a1']);
    expect(served).toEqual([]);
    expect(log(ctx)).toEqual([]);
  });

  it('treats a thrown cancellation as a cancellation, not a fault', async () => {
    const ctx = scrapeContext();
    const { adapter } = recordingAdapter({
      walk: async function* () {
        yield page(cards(1, 'a'));
        throw cancelled();
      },
    });

    const jobs = await collect(provide(adapter).search(query(), ctx));

    // An `AbortError` reaching the catch means the run was stopped, so it is not
    // a warning and it does not get a terminal line either.
    expect(jobs).toHaveLength(1);
    expect(log(ctx)).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* The browser                                                                */
/* -------------------------------------------------------------------------- */

describe('search — the browser lease', () => {
  it('never launches one for a source that does not need it', async () => {
    const ctx = scrapeContext();
    const { pool, launches } = chromium();
    const { adapter, walks } = recordingAdapter({ pages: [page(cards(1))] });

    await collect(provide(adapter, { pool }).search(query(), ctx));

    // LinkedIn is the case: its logged-out endpoints answer plain HTTP, so it
    // never pays the second and the 80 MB.
    expect(launches()).toBe(0);
    expect(pool.isLaunched).toBe(false);
    // And the adapter is handed no session at all, rather than an unused one.
    expect(walks[0]?.session).toBeUndefined();
  });

  it('leases one for a source that does, and gives it back', async () => {
    const ctx = scrapeContext();
    const { pool, launches, closed } = chromium();
    const { adapter, walks } = recordingAdapter({
      needsBrowser: true,
      pages: [page(cards(1))],
    });

    await collect(provide(adapter, { pool }).search(query(), ctx));

    expect(launches()).toBe(1);
    expect(walks[0]?.session).toBeDefined();
    // Context disposed, then the last lease released, which reaps Chromium.
    expect(closed).toEqual({ contexts: 1, browser: 1 });
    expect(pool.isLaunched).toBe(false);
  });

  it('gives it back when the walk fails', async () => {
    const ctx = scrapeContext();
    const { pool, closed } = chromium();
    const { adapter } = recordingAdapter({
      needsBrowser: true,
      walk: failingWalk(new Error('the page never loaded')),
    });

    await collect(provide(adapter, { pool }).search(query(), ctx));

    expect(closed).toEqual({ contexts: 1, browser: 1 });
  });

  it('gives it back when the run is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const ctx = { ...scrapeContext(), signal: controller.signal };
    const { pool, closed } = chromium();
    const { adapter } = recordingAdapter({ needsBrowser: true, pages: [page(cards(1))] });

    await collect(provide(adapter, { pool }).search(query(), ctx));

    // The path the `finally` exists for. A cancelled run is when a leaked
    // browser is both most likely and least noticed — nobody is watching the
    // results of a search they just stopped.
    expect(closed).toEqual({ contexts: 1, browser: 1 });
  });

  it('releases the lease even when the session refuses to close', async () => {
    const ctx = scrapeContext();
    const { pool, seen } = brokenPool({ dispose: true });
    const { adapter } = recordingAdapter({ needsBrowser: true, pages: [page(cards(1))] });

    const jobs = await collect(provide(adapter, { pool }).search(query(), ctx));

    // Unguarded, a rejecting `dispose()` would skip the release entirely —
    // leaking the browser — and reject the iterator, costing the caller both
    // the lead already found and the terminal log.
    expect(seen).toEqual({ disposed: 1, released: 1 });
    expect(jobs).toHaveLength(1);
    expect(log(ctx)).toEqual(['debug: 1 of 1 postings matched']);
  });

  it('finishes the run even when the release itself fails', async () => {
    const ctx = scrapeContext();
    const { pool, seen } = brokenPool({ release: true });
    const { adapter } = recordingAdapter({ needsBrowser: true, pages: [page(cards(1))] });

    const jobs = await collect(provide(adapter, { pool }).search(query(), ctx));

    expect(seen).toEqual({ disposed: 1, released: 1 });
    expect(jobs).toHaveLength(1);
    expect(log(ctx)).toEqual(['debug: 1 of 1 postings matched']);
  });
});

/* -------------------------------------------------------------------------- */
/* Shutdown                                                                   */
/* -------------------------------------------------------------------------- */

describe('closeSharedBrowser', () => {
  it('is safe on an install that never launched a browser', async () => {
    // The default path, and the one that runs most often: `ENABLE_SCRAPERS` is
    // false by default, so most API shutdowns close a browser that was never
    // created. Nothing here may launch a real Chromium to find that out.
    await expect(closeSharedBrowser()).resolves.toBeUndefined();
    await expect(closeSharedBrowser()).resolves.toBeUndefined();
  });
});
