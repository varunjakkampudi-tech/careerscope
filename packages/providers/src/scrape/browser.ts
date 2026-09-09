/**
 * The one browser the scrape providers share.
 *
 * Two of the three scrape sources cannot be reached any other way. Naukri
 * renders its results client-side and its JSON endpoint drops an unguarded
 * connection outright; Indeed sits behind Cloudflare's bot management, which
 * refuses a bare HTTP client whatever its headers say. A real browser loading a
 * public page is the honest answer to both, and it is the *only* thing this
 * module does — there is no fingerprint spoofing, no stealth plugin and no
 * challenge solving here. Where a site still says no, the provider reports that
 * it was blocked rather than reporting zero jobs.
 *
 * ## Playwright is optional
 *
 * It is a ~150 MB dependency plus a browser download, and it is dead weight in
 * the default deployment where `ENABLE_SCRAPERS` is false. So it is never
 * imported at module scope: {@link isPlaywrightInstalled} answers synchronously
 * from the resolver, which lets the registry give a source an honest
 * `unavailableReason` at startup, and the real import happens on first launch.
 * An API image built without Playwright therefore starts fine and says exactly
 * why the three scrape sources are dark.
 *
 * ## One browser, one context per source
 *
 * Launching Chromium costs about a second and 80 MB. A run that queries three
 * scrape sources launches once and gives each source its own context, so their
 * cookies and storage stay separate while the process cost is paid once.
 * {@link BrowserPool.close} is called from a `finally` in the search
 * orchestrator, because a leaked Chromium outlives the request that spawned it
 * and there is nothing in Node that will come along and reap it.
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import { createRequire } from 'node:module';

/**
 * Resource types worth fetching. Job listings are text; the images, fonts and
 * media on a search results page are typically most of its bytes and none of its
 * meaning.
 *
 * This is courtesy as much as speed — it is a large reduction in what we cost
 * the site per page — but the ordering matters: blocking *scripts* would be
 * neither, since the pages we need are the ones that build themselves in JS.
 *
 * **`stylesheet` is deliberately not in this set, and removing it was a fix.**
 * With CSS blocked, Naukri's results page loads, renders, reports its job count
 * in the title — and never issues the search request its own JavaScript is
 * supposed to make. A five-way A/B against the live site isolated it precisely:
 * blocking `image`, `font` or `media` individually or together captured the call
 * in ~1.3s every time; blocking `stylesheet` alone never fired it at all, in
 * fifteen seconds of waiting. The likely mechanism is a layout-dependent trigger
 * — an unstyled document has no geometry, so a visibility-driven fetch never
 * decides it is time — but the mechanism is a guess and the measurement is not.
 *
 * The cost of keeping CSS is a few tens of kilobytes per page. The cost of
 * dropping it was one of the three headline sources silently returning nothing,
 * which is exactly the failure this tier is built to make impossible.
 */
const BLOCKED_RESOURCES = new Set(['image', 'media', 'font']);

/** Chromium flags that matter in a container. None of them touch fingerprinting. */
const LAUNCH_ARGS = [
  // The sandbox needs kernel capabilities a slim container image does not grant.
  // Safe here because every page we open is one we chose, never user input.
  '--no-sandbox',
  '--disable-dev-shm-usage', // /dev/shm defaults to 64 MB in Docker; Chromium wants more.
  '--disable-gpu',
];

export interface BrowserPoolOptions {
  /**
   * Overrides the browser's own user agent. Left unset by default — see
   * {@link DEFAULTS} for why this one differs from the HTTP tier.
   */
  userAgent?: string | null;
  /** Overridden in tests to avoid a real launch. */
  launch?: () => Promise<Browser>;
  headless?: boolean;
  /**
   * Which Chrome to run. `'chrome'` uses the installed Google Chrome; unset uses
   * Playwright's bundled Chromium, which is what the Playwright Docker image
   * ships. Falls back automatically when the requested channel is absent.
   */
  channel?: string | null;
  /** Per-navigation ceiling. A hung page must not hold the whole run open. */
  navigationTimeoutMs?: number;
  /**
   * Locale and timezone. Sent because a job site legitimately varies its results
   * by them — an Indian job search returning US postings is a worse answer, not
   * a safer one — not to look like any particular person.
   */
  locale?: string;
  timezoneId?: string;
}

/**
 * ## Why headed, and why no user-agent override
 *
 * These two defaults are the opposite of the HTTP tier's, and the reasoning is
 * worth stating because it looks at first glance like the thing this module
 * says it does not do.
 *
 * **Headed.** Naukri's edge refuses a headless Chromium and serves the same page
 * normally to a headed one. Running the browser for real is not a disguise — it
 * is the literal thing the site is checking for. The cost is that a server needs
 * a display: run under `xvfb-run -a` (the Playwright image includes Xvfb), which
 * is a deployment detail rather than a code one.
 *
 * **No user-agent override.** Everywhere else in this codebase the client
 * announces itself as `job-radar/1.0` rather than pretending to be a browser.
 * Here that would produce a *less* accurate self-description, not a more honest
 * one: real Chrome also sends `Sec-CH-UA` client hints, which Playwright does
 * not rewrite, so an overridden UA string leaves the request describing itself
 * two different ways. This is a real browser, so it says so.
 *
 * What is *not* done, here or anywhere in this tier: no stealth plugin, no
 * fingerprint patching, no client-hint forgery, no captcha solving, no signed
 * token reimplementation, and no signed-in session. Requests are paced, only
 * public pages are read, and a site that still says no is reported as having
 * said no. Set `userAgent` explicitly if you would rather be identified and can
 * accept being turned away for it.
 */
const DEFAULTS = {
  headless: false,
  channel: 'chrome',
  navigationTimeoutMs: 30_000,
  locale: 'en-IN',
  timezoneId: 'Asia/Kolkata',
} as const;

/* -------------------------------------------------------------------------- */
/* Availability                                                               */
/* -------------------------------------------------------------------------- */

const require_ = createRequire(import.meta.url);

let installed: boolean | null = null;

/**
 * Is Playwright importable right now?
 *
 * Synchronous on purpose. `createProviders()` builds every provider eagerly and
 * has to fill in `unavailableReason` there and then; an async check would force
 * the registry — and every caller of it — to become async so that a source could
 * explain itself. Resolution is cached because this is called once per provider
 * per registry build, and the answer cannot change inside a process.
 */
export function isPlaywrightInstalled(): boolean {
  if (installed === null) {
    try {
      require_.resolve('playwright');
      installed = true;
    } catch {
      installed = false;
    }
  }
  return installed;
}

/** Resets the memoised answer. Tests only. */
export function resetPlaywrightDetection(): void {
  installed = null;
}

/**
 * The sentence a scrape source shows when the browser is missing.
 *
 * Written for whoever is looking at a greyed-out source in the settings screen,
 * so it names the command rather than the module.
 */
export const PLAYWRIGHT_MISSING_REASON =
  'Playwright is not installed. Run `npm i playwright && npx playwright install chromium` to enable the browser-backed sources.';

/* -------------------------------------------------------------------------- */
/* Pool                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A page with its context, handed to a scrape adapter for the length of one
 * source's walk. Disposing releases the context and everything in it.
 */
export interface ScrapeSession {
  page: Page;
  context: BrowserContext;
  dispose(): Promise<void>;
}

/**
 * A claim on the pool, held for the length of one source's walk.
 *
 * Releasing the last lease closes the browser. This is what lets three sources
 * share one Chromium without any of them owning it, and without a coordinator
 * above them that would have to know which sources are enabled.
 */
export interface BrowserLease {
  pool: BrowserPool;
  release(): Promise<void>;
}

export class BrowserPool {
  private browser: Browser | null = null;
  /** De-duplicates concurrent first-launches into one. */
  private launching: Promise<Browser> | null = null;
  private readonly contexts = new Set<BrowserContext>();
  private closed = false;
  private leases = 0;

  private readonly options: {
    userAgent: string | null;
    headless: boolean;
    channel: string | null;
    navigationTimeoutMs: number;
    locale: string;
    timezoneId: string;
    launch?: () => Promise<Browser>;
  };

  constructor(options: BrowserPoolOptions = {}) {
    this.options = {
      userAgent: options.userAgent ?? null,
      headless: options.headless ?? DEFAULTS.headless,
      channel: options.channel === undefined ? DEFAULTS.channel : options.channel,
      navigationTimeoutMs: options.navigationTimeoutMs ?? DEFAULTS.navigationTimeoutMs,
      locale: options.locale ?? DEFAULTS.locale,
      timezoneId: options.timezoneId ?? DEFAULTS.timezoneId,
      ...(options.launch ? { launch: options.launch } : {}),
    };
  }

  /**
   * Launch once, on demand.
   *
   * Concurrent callers share one launch: `SEARCH_CONCURRENCY` defaults to 4, so
   * without the in-flight promise a run enabling all three scrape sources would
   * race three Chromium processes into existence and keep whichever finished
   * last, leaking the other two.
   */
  private async ensureBrowser(): Promise<Browser> {
    if (this.closed) throw new Error('the browser pool is closed');
    if (this.browser) return this.browser;
    if (this.launching) return this.launching;

    this.launching = (async () => {
      const browser = await (this.options.launch ?? (() => this.launchChromium()))();
      // `close()` may have been called while we were launching. Honour it rather
      // than holding a browser nobody will ever close.
      if (this.closed) {
        await browser.close().catch(() => undefined);
        throw new Error('the browser pool is closed');
      }
      this.browser = browser;
      return browser;
    })();

    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  /**
   * Launch, preferring the installed Google Chrome and falling back to
   * Playwright's bundled Chromium.
   *
   * The fallback is not defensive padding: the two supported deployments differ
   * on this exactly. A developer's machine has Chrome and no bundled build until
   * `playwright install` runs; the Playwright Docker image is the reverse. A
   * hard requirement either way would break one of them, and the difference does
   * not matter to any caller.
   */
  private async launchChromium(): Promise<Browser> {
    const { chromium } = await import('playwright');
    const base = { headless: this.options.headless, args: LAUNCH_ARGS };

    if (this.options.channel) {
      try {
        return await chromium.launch({ ...base, channel: this.options.channel });
      } catch {
        // Falls through to the bundled build.
      }
    }
    return chromium.launch(base);
  }

  /**
   * A fresh context and page.
   *
   * Each source gets its own context so cookies set by one site are never sent
   * to another, and so one source's session dying cannot take another's with it.
   */
  async open(): Promise<ScrapeSession> {
    const browser = await this.ensureBrowser();
    const context = await browser.newContext({
      // Omitted rather than nulled: Playwright treats an explicit `undefined` as
      // "keep the browser's own", which is the default this pool wants.
      ...(this.options.userAgent ? { userAgent: this.options.userAgent } : {}),
      locale: this.options.locale,
      timezoneId: this.options.timezoneId,
      viewport: { width: 1440, height: 900 },
    });
    this.contexts.add(context);

    context.setDefaultNavigationTimeout(this.options.navigationTimeoutMs);
    context.setDefaultTimeout(this.options.navigationTimeoutMs);

    // Drop the bytes we have no use for. Failures here are ignored: an abort on
    // a request whose page has already navigated away throws, and that is noise.
    await context.route('**/*', (route) => {
      const type = route.request().resourceType();
      const handled = BLOCKED_RESOURCES.has(type) ? route.abort() : route.continue();
      handled.catch(() => undefined);
    });

    const page = await context.newPage();

    let disposed = false;
    return {
      page,
      context,
      dispose: async () => {
        if (disposed) return;
        disposed = true;
        this.contexts.delete(context);
        await context.close().catch(() => undefined);
      },
    };
  }

  /**
   * Take a claim on the pool.
   *
   * The count is raised before any launch, so a second source arriving while
   * the first is still starting Chromium is counted and cannot have the browser
   * reaped out from under it. Releasing the last lease shuts the browser down
   * but leaves the pool usable — the next run relaunches. That distinction is
   * what keeps a long-lived API process from holding 80 MB of Chromium between
   * searches while still letting the pool be a process-wide singleton.
   */
  async lease(): Promise<BrowserLease> {
    if (this.closed) throw new Error('the browser pool is closed');
    this.leases += 1;

    let released = false;
    return {
      pool: this,
      release: async () => {
        if (released) return;
        released = true;
        this.leases -= 1;
        if (this.leases <= 0) await this.reap();
      },
    };
  }

  /**
   * Shut down the browser but stay open for business.
   *
   * Separate from {@link close} because the two mean different things: this is
   * "nobody needs it right now", `close()` is "the process is going away".
   * Conflating them would leave the shared pool permanently dead after the
   * first search.
   */
  private async reap(): Promise<void> {
    // A launch in flight has to finish before it can be closed, or it completes
    // after us and leaks the very process this method exists to reap.
    if (this.launching) await this.launching.catch(() => undefined);

    await Promise.all([...this.contexts].map((context) => context.close().catch(() => undefined)));
    this.contexts.clear();

    const browser = this.browser;
    this.browser = null;
    if (browser) await browser.close().catch(() => undefined);
  }

  /**
   * Shut everything down for good. Safe to call twice, and safe to call when
   * nothing was ever launched — which is the common case, since the pool exists
   * whether or not a scrape source is enabled.
   */
  async close(): Promise<void> {
    this.closed = true;
    this.leases = 0;
    await this.reap();
  }

  /** True once a browser has actually been launched. For tests and logging. */
  get isLaunched(): boolean {
    return this.browser !== null;
  }
}
