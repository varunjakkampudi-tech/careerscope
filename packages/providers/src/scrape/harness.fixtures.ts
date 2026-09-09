/**
 * A browser that never launches, for the scrape suites.
 *
 * Two of the three scrape adapters take a {@link ScrapeSession} rather than an
 * HTTP client, so the package-level `routedFetch` harness cannot reach them.
 * This is the same idea one layer down: replies chosen by URL substring, calls
 * recorded, nothing real started. A suite that runs against it exercises the
 * adapter's actual control flow — bootstrap, pagination, the 406 refresh, the
 * detail navigation — with no Chromium, no network and no seconds spent.
 *
 * Like `../harness.fixtures.ts`, this is a `.fixtures.ts` rather than a
 * `.test.ts`: importing one test file from another re-registers its suites in
 * the importer, so every shared test would run twice.
 *
 * ## The two deliberate divergences from Playwright
 *
 * Both make a mistaken test fail loudly instead of quietly, which is the only
 * thing a fake owes you that the real object does not:
 *
 *  - **An unmatched navigation throws** rather than returning a 404 page. A
 *    scrape adapter that navigates somewhere the test did not anticipate has a
 *    bug in the URL it built, and surfacing that as "the page was empty" is how
 *    a broken query string survives a green suite.
 *  - **A `waitForResponse` left unsatisfied by a navigation rejects at once**
 *    instead of after the adapter's real 25-second timeout. The adapters arm
 *    the waiter immediately before the navigation that triggers it, so "still
 *    pending once the page has loaded" already means "never" — waiting out the
 *    clock to discover that only makes the suite slow.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from 'playwright';
import type { ScrapeSession } from './browser.js';
import type { ScrapeContext } from './base.js';
import { context as httpContext, routedFetch } from '../harness.fixtures.js';
import type { ProviderEvent } from '../types.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

/** A saved page or payload, read from `__fixtures__/`. */
export function fixture(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

/** The same, parsed. Captured live, so tests assert against real field values. */
export function fixtureJson<T>(name: string): T {
  return JSON.parse(fixture(name)) as T;
}

/* -------------------------------------------------------------------------- */
/* Response shapes                                                            */
/* -------------------------------------------------------------------------- */

/** What a navigation returns: a status line and the document behind it. */
export interface PageReply {
  status?: number;
  body?: string;
}

/** What the browser's request context returns for a bare fetch. */
export interface ApiReply {
  status?: number;
  /** Serialised for `.text()`; `.json()` parses it, as the real one does. */
  body?: string;
  /** Convenience for the JSON case — stringified into `body`. */
  json?: unknown;
}

/** A route table value: a fixed reply, or a function called once per hit. */
type Route<T> = T | (() => T);

export interface FakeSessionOptions {
  /** Answers `page.goto()`, matched by URL substring. */
  navigate?: Record<string, Route<PageReply>>;
  /** Answers `context.request.get()`, matched by URL substring. */
  api?: Record<string, Route<ApiReply>>;
  /**
   * Requests the loaded page makes for itself, emitted to `page.on('request')`
   * listeners during every navigation. This is how Naukri's bootstrap observes
   * the token its own JavaScript mints; `null` models a page that loads but
   * never runs its search.
   */
  requests?: ReadonlyArray<{ url: string; headers: Record<string, string> }> | null;
  /**
   * XHR responses the page emits during a navigation, keyed by the URL the
   * adapter's `waitForResponse` predicate will match on.
   */
  xhr?: Record<string, { status?: number; json: unknown }>;
}

export interface FakeSession extends ScrapeSession {
  /** Every URL passed to `page.goto()`, in order. */
  navigations: string[];
  /** Every `context.request.get()`, with the headers it carried. */
  apiCalls: Array<{ url: string; headers: Record<string, string> }>;
  /** True once `dispose()` has run — the leak check every suite can make. */
  disposed: boolean;
}

/* -------------------------------------------------------------------------- */
/* The fake                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A session backed by route tables instead of a browser.
 *
 * Cast to Playwright's types at the boundary: the adapters use a handful of
 * `Page` and `BrowserContext` members between them, and implementing the full
 * interfaces to satisfy the compiler would be several hundred lines of `throw`
 * for no additional coverage. The cast is the honest form of that trade — it is
 * confined to this function, and every member the adapters actually reach is
 * implemented below.
 */
export function fakeSession(options: FakeSessionOptions = {}): FakeSession {
  const navigations: string[] = [];
  const apiCalls: Array<{ url: string; headers: Record<string, string> }> = [];
  const listeners = new Set<(request: FakeRequest) => void>();
  const waiters: Array<{
    predicate: (response: FakeResponse) => boolean;
    resolve: (response: FakeResponse) => void;
    reject: (error: Error) => void;
  }> = [];

  let current = 'about:blank';
  let document = '';
  let disposed = false;

  const page = {
    async goto(url: string): Promise<{ status(): number } | null> {
      navigations.push(url);

      const reply = resolveRoute(options.navigate, url);
      if (!reply) {
        throw new Error(`fakeSession: no navigation route matches ${url}`);
      }

      current = url;
      document = reply.body ?? '';

      // The page's own subresource requests, seen by anything listening.
      for (const request of options.requests ?? []) {
        for (const listener of listeners) {
          listener({ url: () => request.url, headers: () => ({ ...request.headers }) });
        }
      }

      // ...then the XHR responses it received, offered to anyone waiting.
      for (const [target, body] of Object.entries(options.xhr ?? {})) {
        const response: FakeResponse = {
          url: () => target,
          status: () => body.status ?? 200,
          json: async () => body.json,
        };
        for (const waiter of [...waiters]) {
          if (!waiter.predicate(response)) continue;
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(response);
        }
      }

      // See the header: still pending after the navigation means never.
      for (const waiter of waiters.splice(0)) {
        waiter.reject(new Error('fakeSession: no XHR matched the pending waitForResponse'));
      }

      const status = reply.status ?? 200;
      return { status: () => status };
    },

    async content(): Promise<string> {
      return document;
    },

    url(): string {
      return current;
    },

    on(event: string, listener: (request: FakeRequest) => void): void {
      if (event === 'request') listeners.add(listener);
    },

    off(event: string, listener: (request: FakeRequest) => void): void {
      if (event === 'request') listeners.delete(listener);
    },

    waitForResponse(predicate: (response: FakeResponse) => boolean): Promise<FakeResponse> {
      return new Promise<FakeResponse>((resolve, reject) => {
        waiters.push({ predicate, resolve, reject });
      });
    },
  };

  const context = {
    request: {
      async get(url: string, init?: { headers?: Record<string, string> }) {
        apiCalls.push({ url, headers: { ...(init?.headers ?? {}) } });

        const reply = resolveRoute(options.api, url);
        if (!reply) {
          throw new Error(`fakeSession: no API route matches ${url}`);
        }

        const body = reply.json === undefined ? (reply.body ?? '') : JSON.stringify(reply.json);
        const status = reply.status ?? 200;
        return {
          status: () => status,
          text: async () => body,
          json: async () => JSON.parse(body) as unknown,
        };
      },
    },
  };

  const session: FakeSession = {
    page: page as unknown as Page,
    context: context as unknown as BrowserContext,
    navigations,
    apiCalls,
    get disposed() {
      return disposed;
    },
    dispose: async () => {
      disposed = true;
    },
  };

  return session;
}

interface FakeRequest {
  url(): string;
  headers(): Record<string, string>;
}

interface FakeResponse {
  url(): string;
  status(): number;
  json(): Promise<unknown>;
}

function resolveRoute<T>(routes: Record<string, Route<T>> | undefined, url: string): T | null {
  if (!routes) return null;
  const key = Object.keys(routes).find((route) => url.includes(route));
  if (key === undefined) return null;
  const value = routes[key] as Route<T>;
  return typeof value === 'function' ? (value as () => T)() : value;
}

/* -------------------------------------------------------------------------- */
/* Context                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A `ScrapeContext` carrying a session, plus the event log the suites assert on.
 *
 * The HTTP client is still real — LinkedIn runs on it — so the same context type
 * serves all three adapters whether or not they take a browser.
 */
export function scrapeContext(
  session?: ScrapeSession,
  routes: Record<string, unknown | (() => Response)> = {},
): ScrapeContext & { events: ProviderEvent[] } {
  const base = httpContext(routedFetch(routes).impl);
  return { ...base, ...(session ? { session } : {}) };
}
