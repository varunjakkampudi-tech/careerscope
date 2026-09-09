/**
 * The shared browser pool.
 *
 * Everything here is about lifetime, because that is the only part of this
 * module that can fail silently. A leaked Chromium is 80 MB and a process that
 * Node will never reap; a browser closed a moment too early takes a live scrape
 * down with it. Both are invisible from the outside — the run still finishes,
 * just wrongly — so the reference counting is pinned here rather than trusted.
 *
 * No real browser is launched. `BrowserPoolOptions.launch` exists for exactly
 * this: the pool's job is deciding *when* to launch, open, reap and close, and
 * that logic is entirely independent of whether the thing on the other end is
 * Chromium or a counter.
 */

import type { Browser, BrowserContext } from 'playwright';
import { describe, expect, it } from 'vitest';
import {
  BrowserPool,
  isPlaywrightInstalled,
  PLAYWRIGHT_MISSING_REASON,
  resetPlaywrightDetection,
} from './browser.js';

/* -------------------------------------------------------------------------- */
/* A browser made of counters                                                 */
/* -------------------------------------------------------------------------- */

type RouteHandler = (route: FakeRoute) => void;

interface FakeRoute {
  request(): { resourceType(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}

interface FakeContext {
  options: Record<string, unknown>;
  navigationTimeouts: number[];
  defaultTimeouts: number[];
  routes: RouteHandler[];
  pages: number;
  closes: number;
  setDefaultNavigationTimeout(ms: number): void;
  setDefaultTimeout(ms: number): void;
  route(pattern: string, handler: RouteHandler): Promise<void>;
  newPage(): Promise<unknown>;
  close(): Promise<void>;
}

function fakeContext(options: Record<string, unknown>): FakeContext {
  const ctx: FakeContext = {
    options,
    navigationTimeouts: [],
    defaultTimeouts: [],
    routes: [],
    pages: 0,
    closes: 0,
    setDefaultNavigationTimeout: (ms) => void ctx.navigationTimeouts.push(ms),
    setDefaultTimeout: (ms) => void ctx.defaultTimeouts.push(ms),
    route: async (_pattern, handler) => void ctx.routes.push(handler),
    newPage: async () => {
      ctx.pages += 1;
      return {};
    },
    close: async () => void (ctx.closes += 1),
  };
  return ctx;
}

interface FakeBrowser {
  browser: Browser;
  contexts: FakeContext[];
  closes: number;
}

function fakeBrowser(): FakeBrowser {
  const record: FakeBrowser = {
    browser: null as unknown as Browser,
    contexts: [],
    closes: 0,
  };
  record.browser = {
    newContext: async (options: Record<string, unknown>) => {
      const ctx = fakeContext(options);
      record.contexts.push(ctx);
      return ctx as unknown as BrowserContext;
    },
    close: async () => void (record.closes += 1),
  } as unknown as Browser;
  return record;
}

/** A pool over a fake browser, plus the launch counter every test wants. */
function pooled(options: { headless?: boolean } = {}) {
  const record = fakeBrowser();
  let launches = 0;
  const pool = new BrowserPool({
    ...options,
    launch: async () => {
      launches += 1;
      return record.browser;
    },
  });
  return { pool, record, launches: () => launches };
}

/** Drives one route handler and reports which branch it took. */
async function routeVerdict(handler: RouteHandler, resourceType: string): Promise<string> {
  return new Promise<string>((resolve) => {
    handler({
      request: () => ({ resourceType: () => resourceType }),
      abort: async () => resolve('abort'),
      continue: async () => resolve('continue'),
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Launching                                                                  */
/* -------------------------------------------------------------------------- */

describe('BrowserPool — launching', () => {
  it('does not launch until something asks for a page', async () => {
    const { pool, launches } = pooled();

    // The pool is a process-wide singleton constructed whether or not a scrape
    // source is enabled, so construction has to be free.
    expect(launches()).toBe(0);
    expect(pool.isLaunched).toBe(false);

    await pool.open();
    expect(launches()).toBe(1);
    expect(pool.isLaunched).toBe(true);
  });

  it('launches once for concurrent openers', async () => {
    const { pool, launches, record } = pooled();

    // The real hazard: SEARCH_CONCURRENCY is 4, so three scrape sources start
    // within microseconds of each other. Without the in-flight promise each
    // would race a Chromium into existence and the pool would keep only the
    // last, leaking two processes that nothing is left holding a handle to.
    await Promise.all([pool.open(), pool.open(), pool.open()]);

    expect(launches()).toBe(1);
    expect(record.contexts).toHaveLength(3);
  });

  it('gives every source its own context', async () => {
    const { pool, record } = pooled();

    const first = await pool.open();
    const second = await pool.open();

    // Separate contexts, so a cookie Naukri sets is never sent to Indeed and a
    // session dying on one source cannot take the other's down with it.
    expect(record.contexts).toHaveLength(2);
    expect(first.context).not.toBe(second.context);
    expect(record.contexts.every((ctx) => ctx.pages === 1)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Context configuration                                                      */
/* -------------------------------------------------------------------------- */

describe('BrowserPool — context configuration', () => {
  it('omits the user agent rather than nulling it', async () => {
    const { pool, record } = pooled();
    await pool.open();

    const options = record.contexts[0]?.options ?? {};

    // Not cosmetic. Playwright reads an explicit `undefined` as "keep the
    // browser's own", but the key being absent is what documents the intent:
    // this is a real Chrome and it says so. Overriding the UA string while
    // Playwright still sends real Sec-CH-UA client hints would leave the
    // request describing itself two different ways — less honest, not more.
    expect('userAgent' in options).toBe(false);
  });

  it('sends a user agent only when one was asked for', async () => {
    const record = fakeBrowser();
    const pool = new BrowserPool({
      userAgent: 'job-radar/1.0',
      launch: async () => record.browser,
    });

    await pool.open();

    expect(record.contexts[0]?.options.userAgent).toBe('job-radar/1.0');
  });

  it('sets locale and timezone, because the results depend on them', async () => {
    const { pool, record } = pooled();
    await pool.open();

    // An Indian job search answered with US postings is a worse result, not a
    // safer one. This is the reason these are sent — not to look like anyone.
    expect(record.contexts[0]?.options).toMatchObject({
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      viewport: { width: 1440, height: 900 },
    });
  });

  it('caps every navigation, so one hung page cannot hold the run open', async () => {
    const record = fakeBrowser();
    const pool = new BrowserPool({
      navigationTimeoutMs: 5_000,
      launch: async () => record.browser,
    });

    await pool.open();

    expect(record.contexts[0]?.navigationTimeouts).toEqual([5_000]);
    expect(record.contexts[0]?.defaultTimeouts).toEqual([5_000]);
  });

  it('drops the bytes with no meaning in them and keeps the ones with', async () => {
    const { pool, record } = pooled();
    await pool.open();

    const handler = record.contexts[0]?.routes[0];
    expect(handler).toBeDefined();

    for (const type of ['image', 'media', 'font']) {
      expect(await routeVerdict(handler!, type)).toBe('abort');
    }

    // Scripts are the exception that makes the whole tier work: the pages this
    // pool exists to read are the ones that build themselves in JavaScript, so
    // blocking scripts would save bytes by removing the results.
    for (const type of ['document', 'script', 'xhr', 'fetch']) {
      expect(await routeVerdict(handler!, type)).toBe('continue');
    }

    // Stylesheets belong in that second list, which is not obvious and was not
    // free to learn. CSS looks like the most droppable thing on a job board —
    // and dropping it made Naukri load, render, report its job count, and never
    // issue the search request its own JavaScript makes. Measured against the
    // live site: blocking image/font/media captured that call in ~1.3s; blocking
    // stylesheet alone never fired it in fifteen seconds. An unstyled document
    // has no geometry, and something on that page waits for geometry.
    expect(await routeVerdict(handler!, 'stylesheet')).toBe('continue');
  });
});

/* -------------------------------------------------------------------------- */
/* Leases                                                                     */
/* -------------------------------------------------------------------------- */

describe('BrowserPool — leases', () => {
  it('closes the browser when the last lease goes', async () => {
    const { pool, record } = pooled();

    const lease = await pool.lease();
    await pool.open();
    expect(pool.isLaunched).toBe(true);

    await lease.release();

    expect(record.closes).toBe(1);
    expect(pool.isLaunched).toBe(false);
  });

  it('holds the browser open while any source is still walking', async () => {
    const { pool, record } = pooled();

    const first = await pool.lease();
    const second = await pool.lease();
    await pool.open();

    await first.release();

    // LinkedIn finishing first must not tear the page out from under Naukri.
    expect(record.closes).toBe(0);
    expect(pool.isLaunched).toBe(true);

    await second.release();
    expect(record.closes).toBe(1);
  });

  it('ignores a second release of the same lease', async () => {
    const { pool, record } = pooled();

    const first = await pool.lease();
    const second = await pool.lease();
    await pool.open();

    await first.release();
    await first.release();

    // `base.ts` releases in a `finally` that also runs on the abort path, so a
    // double release is a realistic call, not a hypothetical one. Without the
    // guard the count would go negative and reap the browser Naukri is using.
    expect(record.closes).toBe(0);
    expect(pool.isLaunched).toBe(true);

    await second.release();
    expect(record.closes).toBe(1);
  });

  it('stays usable after the last lease — the next run relaunches', async () => {
    const { pool, launches, record } = pooled();

    const first = await pool.lease();
    await pool.open();
    await first.release();

    const second = await pool.lease();
    await pool.open();

    // The distinction `reap` exists for: "nobody needs it right now" must not
    // become "this pool is dead", or a long-lived API process would serve
    // exactly one search with browser sources and none after it.
    expect(launches()).toBe(2);
    expect(pool.isLaunched).toBe(true);

    await second.release();
    expect(record.closes).toBe(2);
  });

  it('closes the contexts along with the browser', async () => {
    const { pool, record } = pooled();

    const lease = await pool.lease();
    await pool.open();
    await pool.open();

    await lease.release();

    expect(record.contexts.map((ctx) => ctx.closes)).toEqual([1, 1]);
  });
});

/* -------------------------------------------------------------------------- */
/* Disposal and shutdown                                                      */
/* -------------------------------------------------------------------------- */

describe('BrowserPool — shutdown', () => {
  it('disposes a session once, however many times it is asked', async () => {
    const { pool, record } = pooled();
    const session = await pool.open();

    await session.dispose();
    await session.dispose();

    // `base.ts` disposes in a `finally`; a caller that also disposes explicitly
    // must not double-close a context Playwright has already reclaimed.
    expect(record.contexts[0]?.closes).toBe(1);
  });

  it('does not close a disposed context a second time during reap', async () => {
    const { pool, record } = pooled();

    const lease = await pool.lease();
    const session = await pool.open();
    await session.dispose();
    await lease.release();

    expect(record.contexts[0]?.closes).toBe(1);
    expect(record.closes).toBe(1);
  });

  it('refuses new work once closed', async () => {
    const { pool } = pooled();
    await pool.close();

    await expect(pool.lease()).rejects.toThrow('the browser pool is closed');
    await expect(pool.open()).rejects.toThrow('the browser pool is closed');
  });

  it('closes cleanly when nothing was ever launched', async () => {
    const { pool, record, launches } = pooled();

    // The default path. `closeSharedBrowser()` runs on every API shutdown, and
    // most installs never enable a scrape source at all.
    await expect(pool.close()).resolves.toBeUndefined();
    await expect(pool.close()).resolves.toBeUndefined();

    expect(launches()).toBe(0);
    expect(record.closes).toBe(0);
  });

  it('does not strand a browser that finishes launching after close', async () => {
    const record = fakeBrowser();
    let resolveLaunch!: () => void;
    const gate = new Promise<void>((resolve) => {
      resolveLaunch = resolve;
    });

    const pool = new BrowserPool({
      launch: async () => {
        await gate;
        return record.browser;
      },
    });

    const opening = pool.open();
    const closing = pool.close();
    resolveLaunch();

    // The race that leaks: shutdown arrives mid-launch, and a pool that only
    // checked `closed` on the way in would store a browser nobody will ever
    // close again. The launch is awaited, the result closed, the caller told.
    await expect(opening).rejects.toThrow('the browser pool is closed');
    await closing;

    expect(record.closes).toBe(1);
    expect(pool.isLaunched).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

describe('isPlaywrightInstalled', () => {
  it('resolves Playwright in this workspace', () => {
    resetPlaywrightDetection();

    // A devDependency of this package, so the scrape tier is testable here even
    // though the shipped API image may be built without it.
    expect(isPlaywrightInstalled()).toBe(true);
  });

  it('answers synchronously and remembers', () => {
    resetPlaywrightDetection();

    // Synchronous is the requirement, not an optimisation: `createProviders()`
    // builds every provider eagerly and has to fill in `unavailableReason`
    // there and then. An async check would make the registry — and every
    // caller of it — async just so a source could explain why it is dark.
    expect(isPlaywrightInstalled()).toBe(isPlaywrightInstalled());
  });

  it('tells the user the command rather than the module', () => {
    // Read off a greyed-out row in the settings screen by someone who has never
    // heard of Playwright.
    expect(PLAYWRIGHT_MISSING_REASON).toContain('npx playwright install chromium');
  });
});
