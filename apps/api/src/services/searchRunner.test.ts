/**
 * The per-source fetch budget.
 *
 * These are not tests about scoring or storage — they are about the one decision
 * this stage makes that nothing else in the app can make for it: what to do when
 * a single board goes quiet while the others have finished.
 *
 * The trap being pinned is a real one that happened here. Nine keyless sources
 * were queried, eight returned, and Workable sat in `HttpClient`'s 429 backoff
 * for the rest of the run. Without a per-source deadline the whole run rode to
 * the 15-minute backstop in `queue.ts`, which writes `failed` and discards every
 * posting all nine sources found. One rate-limited board should cost you that
 * board, not the run.
 *
 * The runner is built directly rather than through `createContainer`, because
 * the seam under test *is* `SearchRunnerDeps` — and with no resolver and no
 * rerank client, `execute` never touches the network or the disk.
 */

import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { HttpClient } from '@job-radar/providers';
import type { JobProvider, ProviderContext } from '@job-radar/providers';
import type { ProviderQuery, RawJob, SourceId } from '@job-radar/shared';
import { SearchRunner } from './searchRunner.js';
import { RunEventBus } from './events.js';
import {
  createTestRepos,
  makeProfile,
  makeSearchRequest,
  makeJob,
  makeBreakdown,
  storeJob,
  NOW,
} from '../db/repo/repo.fixtures.js';

/** Short enough that a hung source is settled in milliseconds, not minutes. */
const BUDGET_MS = 40;

/* -------------------------------------------------------------------------- */
/* Stub providers                                                             */
/* -------------------------------------------------------------------------- */

function rawJob(source: SourceId, n: number): RawJob {
  return {
    source,
    sourceJobId: `${source}-${n}`,
    title: 'Senior Software Engineer',
    companyName: 'Acme',
    location: 'Hyderabad, India',
    description: 'We need TypeScript, React and Node.js.',
    hasFullDescription: true,
    sourceUrl: `https://example.test/${source}/${n}`,
    postedAt: NOW,
  };
}

/** Yields `count` postings and returns, the way a healthy board does. */
function fastProvider(id: SourceId, count: number): JobProvider {
  return {
    id,
    kind: 'ats',
    label: id,
    unavailableReason: null,
    async *search(): AsyncIterable<RawJob> {
      for (let n = 0; n < count; n += 1) yield rawJob(id, n);
    },
  };
}

/**
 * Yields one posting and then stops responding.
 *
 * `mode` covers both shapes a real provider takes when its signal fires. The
 * interface asks for `'clean'` — stop iterating, do not throw — but a provider
 * that forwards the signal into `fetch` gets an `AbortError` thrown through it
 * instead, and the runner has to read both as "this source ran out of time"
 * rather than one of them as a failure.
 */
function hangingProvider(id: SourceId, mode: 'clean' | 'throws'): JobProvider {
  return {
    id,
    kind: 'ats',
    label: id,
    unavailableReason: null,
    async *search(_query: ProviderQuery, ctx: ProviderContext): AsyncIterable<RawJob> {
      yield rawJob(id, 0);

      const signal = ctx.signal;
      if (signal && !signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      if (mode === 'throws') throw new DOMException('The operation was aborted.', 'AbortError');
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

function harness(
  providers: readonly JobProvider[],
  http = new HttpClient({ userAgent: 'job-radar-test/1.0' }),
) {
  const repos = createTestRepos();
  repos.profiles.save(makeProfile(), NOW);

  const runner = new SearchRunner({
    repos,
    events: new RunEventBus(repos.runs, () => NOW),
    logger: pino({ level: 'silent' }),
    // Constructed but unreachable: every provider here is a stub, and without a
    // resolver or a rerank client no later stage makes a request either.
    http,
    providers,
    clock: () => NOW,
    sourceBudgetMs: BUDGET_MS,
  });

  const start = (sources: SourceId[], signal = new AbortController().signal) => {
    const run = repos.runs.create(makeSearchRequest({ sources }), NOW);
    return runner.execute(run.id, signal);
  };

  return { repos, start, cleanup: () => repos.cleanup() };
}

/* -------------------------------------------------------------------------- */

describe('SearchRunner per-source fetch budget', () => {
  it('removes a confirmed withdrawn older lead during a refresh, not merely because it was absent', async () => {
    const http = new HttpClient({
      minIntervalMs: 0,
      fetch: async (url) =>
        String(url).endsWith('/123')
          ? new Response('{"error":"Job not found"}', { status: 404 })
          : new Response('{"jobs":[]}', { status: 200 }),
    });
    const fixture = harness([fastProvider('greenhouse', 0)], http);
    try {
      const job = storeJob(
        fixture.repos,
        makeJob({ sourceJobId: '123', sourceUrl: 'https://boards.greenhouse.io/acme/jobs/123' }),
      );
      const lead = fixture.repos.leads.upsert(
        { jobId: job.id, runId: null, breakdown: makeBreakdown() },
        NOW,
      );
      const result = await fixture.start(['greenhouse']);
      expect(result.run.status).toBe('completed');
      expect(fixture.repos.leads.get(lead.id)).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  it.each(['warn', 'error'] as const)(
    'surfaces handled provider %s events in source summaries',
    async (level) => {
      const provider = fastProvider('greenhouse', 0);
      provider.search = async function* (_query, ctx) {
        ctx.log?.({
          level,
          source: 'greenhouse',
          message: 'One company board rejected the request.',
        });
        yield rawJob('greenhouse', 1);
      };
      const fixture = harness([provider]);
      try {
        const { run } = await fixture.start(['greenhouse']);
        expect(run.status).toBe('completed');
        expect(run.stats.bySource[0]).toMatchObject({
          source: 'greenhouse',
          fetched: 1,
          errors: level === 'error' ? 1 : 0,
          message: 'Results may be incomplete: One company board rejected the request.',
        });
      } finally {
        fixture.cleanup();
      }
    },
  );

  it.each(['clean', 'throws'] as const)(
    'keeps a healthy source when another hangs and %ss out',
    async (mode) => {
      const h = harness([fastProvider('greenhouse', 3), hangingProvider('lever', mode)]);
      try {
        const { run } = await h.start(['greenhouse', 'lever']);

        // The whole point: one stuck board does not fail the run.
        expect(run.status).toBe('completed');

        const fast = run.stats.bySource.find((stat) => stat.source === 'greenhouse');
        const stuck = run.stats.bySource.find((stat) => stat.source === 'lever');

        expect(fast?.fetched).toBe(3);
        expect(fast?.errors).toBe(0);
        expect(fast?.message).toBeNull();

        // The posting it managed to yield before stalling is kept, not discarded.
        expect(stuck?.fetched).toBe(1);
        // A budget expiry is not a failure — nothing went wrong, we stopped waiting.
        expect(stuck?.errors).toBe(0);
        expect(stuck?.message).toMatch(/results are partial/);
      } finally {
        h.cleanup();
      }
    },
  );

  it('reports the budget in the message, so "1 kept" is not read as complete', async () => {
    const h = harness([hangingProvider('lever', 'clean')]);
    try {
      const { run } = await h.start(['lever']);
      expect(run.stats.bySource[0]?.message).toBe(
        `Stopped after 1s — still responding, so these results are partial.`,
      );
    } finally {
      h.cleanup();
    }
  });

  it('lets a cancelled run unwind instead of reporting every source as partial', async () => {
    const h = harness([hangingProvider('lever', 'clean')]);
    const controller = new AbortController();
    try {
      const pending = h.start(['lever'], controller.signal);
      // Cancellation and the budget race here on purpose: both signals fire, and
      // the run signal has to win. Reading this as a budget expiry would let the
      // run complete normally and quietly overwrite the `cancelled` row.
      controller.abort();
      const { run, leads } = await pending;

      expect(leads).toHaveLength(0);
      // The stopper owns the terminal row, so the runner leaves it as it found
      // it — what matters is that it did not write `completed`.
      expect(run.status).not.toBe('completed');
      expect(run.stats.bySource.find((stat) => stat.source === 'lever')?.message ?? '').not.toMatch(
        /results are partial/,
      );
    } finally {
      h.cleanup();
    }
  });
});
