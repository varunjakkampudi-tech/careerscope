/**
 * Test harness shared by the provider suites.
 *
 * This lives in a `.fixtures.ts` file rather than inside `base.test.ts` because
 * importing one test file from another re-registers its suites in the importer,
 * so every shared test would run twice. `tsconfig.json` excludes this pattern
 * from the build, and the Vitest `include` glob only picks up `*.test.ts`, so
 * the file is invisible to both.
 */

import type { ProviderQuery, RawJob } from '@job-radar/shared';
import { HttpClient, type FetchLike } from './http.js';
import type { ProviderContext, ProviderEvent } from './types.js';

/** Replies chosen by URL substring — boards are addressed, not sequenced. */
export function routedFetch(routes: Record<string, unknown | (() => Response)>): {
  impl: FetchLike;
  calls: string[];
} {
  const calls: string[] = [];
  const impl: FetchLike = async (url) => {
    calls.push(url);
    const key = Object.keys(routes).find((route) => url.includes(route));
    if (key === undefined) return new Response('not found', { status: 404 });
    const value = routes[key];
    if (typeof value === 'function') return (value as () => Response)();
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl, calls };
}

/** A provider context with no pacing and no retries, so tests run at full speed. */
export function context(impl: FetchLike): ProviderContext & { events: ProviderEvent[] } {
  const events: ProviderEvent[] = [];
  return {
    http: new HttpClient({
      fetch: impl,
      sleep: async () => undefined,
      minIntervalMs: 0,
      retries: 0,
    }),
    log: (event) => events.push(event),
    events,
  };
}

export function query(overrides: Partial<ProviderQuery> = {}): ProviderQuery {
  return {
    titles: [],
    locations: [],
    excludeKeywords: [],
    remoteOnly: false,
    employmentTypes: [],
    postedWithinDays: 3650,
    maxResults: 100,
    ...overrides,
  };
}

export async function collect(iterable: AsyncIterable<RawJob>): Promise<RawJob[]> {
  const out: RawJob[] = [];
  for await (const job of iterable) out.push(job);
  return out;
}
