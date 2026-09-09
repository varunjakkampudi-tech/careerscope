import { employmentTypeFrom, periodFrom } from '../normalize.js';
import { describe, expect, it, vi } from 'vitest';
import type { RawJob } from '@job-radar/shared';
import { HttpError, type FetchLike } from '../http.js';
import type { BoardRef } from '../boards.js';
import {
  boardJson,
  boardScopedId,
  createBoardProvider,
  splitBoardScopedId,
  type BoardAdapter,
} from './base.js';
import { collect, context, query, routedFetch } from '../harness.fixtures.js';

/** An adapter that returns whatever the test hands it, with no network at all. */
function stubAdapter(
  byBoard: Record<string, Array<{ id: string; title?: string; postedAt?: string }>>,
  onList?: (slug: string) => void,
): BoardAdapter<{ id: string; title?: string; postedAt?: string }> {
  return {
    id: 'greenhouse',
    label: 'Stub',
    async listBoard(board) {
      onList?.(board.slug);
      const items = byBoard[board.slug];
      if (!items) throw new HttpError('HTTP 500', { kind: 'http', url: 'x', status: 500 });
      return items;
    },
    toRawJob(item, board) {
      if (item.title === '__throw__') throw new Error('malformed posting');
      return {
        source: 'greenhouse',
        sourceJobId: `${board.slug}:${item.id}`,
        title: item.title ?? 'Backend Engineer',
        companyName: board.company,
        hasFullDescription: true,
        sourceUrl: `https://x.test/${item.id}`,
        postedAt: item.postedAt,
      };
    },
  };
}

const board = (slug: string): BoardRef => ({ source: 'greenhouse', slug, company: slug });

/* -------------------------------------------------------------------------- */
/* The board walk                                                             */
/* -------------------------------------------------------------------------- */

describe('createBoardProvider', () => {
  const ctx = context(routedFetch({}).impl);

  it('walks every configured board', async () => {
    const seen: string[] = [];
    const provider = createBoardProvider(
      stubAdapter({ a: [{ id: '1' }], b: [{ id: '2' }] }, (s) => seen.push(s)),
      {
        boards: [board('a'), board('b')],
      },
    );
    const jobs = await collect(provider.search(query(), ctx));
    expect(seen).toEqual(['a', 'b']);
    expect(jobs.map((job) => job.sourceJobId)).toEqual(['a:1', 'b:2']);
  });

  it('caps a board at its share, so one huge board cannot eat the whole budget', async () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ id: String(i) }));
    const provider = createBoardProvider(stubAdapter({ a: big, b: big }), {
      boards: [board('a'), board('b')],
    });
    const jobs = await collect(provider.search(query({ maxResults: 10 }), ctx));
    expect(jobs.filter((job) => job.companyName === 'a')).toHaveLength(5);
    expect(jobs.filter((job) => job.companyName === 'b')).toHaveLength(5);
  });

  it('rolls an unused share forward rather than wasting it', async () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ id: String(i) }));
    const provider = createBoardProvider(stubAdapter({ a: [{ id: 'only' }], b: big }), {
      boards: [board('a'), board('b')],
    });
    const jobs = await collect(provider.search(query({ maxResults: 10 }), ctx));
    // a used 1 of its 5; b may then take 9.
    expect(jobs).toHaveLength(10);
    expect(jobs.filter((job) => job.companyName === 'b')).toHaveLength(9);
  });

  it('never squeezes a board below the floor, even with a long board list', async () => {
    const boards = Array.from({ length: 40 }, (_, i) => board(`b${i}`));
    const items = Array.from({ length: 10 }, (_, i) => ({ id: String(i) }));
    const byBoard = Object.fromEntries(boards.map((b) => [b.slug, items]));
    const provider = createBoardProvider(stubAdapter(byBoard), { boards });
    const jobs = await collect(provider.search(query({ maxResults: 20 }), ctx));
    // 20/40 rounds to a share of 0.5 — the floor of 3 applies instead.
    expect(jobs.filter((job) => job.companyName === 'b0')).toHaveLength(3);
  });

  it('stops at maxResults', async () => {
    const big = Array.from({ length: 100 }, (_, i) => ({ id: String(i) }));
    const provider = createBoardProvider(stubAdapter({ a: big }), { boards: [board('a')] });
    const jobs = await collect(provider.search(query({ maxResults: 7 }), ctx));
    expect(jobs).toHaveLength(7);
  });

  it('keeps going when one board fails, and says which', async () => {
    const local = context(routedFetch({}).impl);
    const provider = createBoardProvider(stubAdapter({ a: [{ id: '1' }], c: [{ id: '3' }] }), {
      boards: [board('a'), board('dead'), board('c')],
    });
    const jobs = await collect(provider.search(query(), local));
    expect(jobs.map((job) => job.sourceJobId)).toEqual(['a:1', 'c:3']);
    expect(local.events.some((e) => e.level === 'warn' && e.message.includes('dead'))).toBe(true);
  });

  it('skips one unreadable posting without losing the rest of the board', async () => {
    const local = context(routedFetch({}).impl);
    const provider = createBoardProvider(
      stubAdapter({ a: [{ id: '1' }, { id: '2', title: '__throw__' }, { id: '3' }] }),
      { boards: [board('a')] },
    );
    const jobs = await collect(provider.search(query(), local));
    expect(jobs.map((job) => job.sourceJobId)).toEqual(['a:1', 'a:3']);
    expect(local.events.some((e) => e.level === 'debug' && e.message.includes('unreadable'))).toBe(
      true,
    );
  });

  it('ends quietly when the run is cancelled', async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    const provider = createBoardProvider(
      stubAdapter({ a: [{ id: '1' }], b: [{ id: '2' }] }, (slug) => {
        seen.push(slug);
        controller.abort();
      }),
      { boards: [board('a'), board('b')] },
    );
    const jobs = await collect(provider.search(query(), { ...ctx, signal: controller.signal }));
    expect(seen).toEqual(['a']);
    expect(jobs).toHaveLength(1);
  });

  it('ranks a board by closeness to a target title before applying the cap', async () => {
    const items = [
      { id: 'sales', title: 'Sales Manager' },
      { id: 'data', title: 'Data Engineer' },
      { id: 'backend', title: 'Senior Backend Engineer, Payments' },
    ];
    const provider = createBoardProvider(stubAdapter({ a: items }), { boards: [board('a')] });
    const jobs = await collect(
      provider.search(query({ titles: ['Backend Engineer'], maxResults: 1 }), ctx),
    );
    expect(jobs[0]?.sourceJobId).toBe('a:backend');
  });

  it('falls back to freshness when the user has no target titles', async () => {
    const items = [
      { id: 'old', postedAt: '2020-01-01T00:00:00Z' },
      { id: 'new', postedAt: '2026-08-01T00:00:00Z' },
      { id: 'undated' },
    ];
    const provider = createBoardProvider(stubAdapter({ a: items }), { boards: [board('a')] });
    const jobs = await collect(provider.search(query({ maxResults: 1 }), ctx));
    expect(jobs[0]?.sourceJobId).toBe('a:new');
  });

  it('reports itself unavailable when it has no boards to walk', () => {
    const provider = createBoardProvider(stubAdapter({}), { boards: [] });
    expect(provider.unavailableReason).toMatch(/no stub company boards/i);
  });

  it('exposes fetchDetail only when the ATS actually has a detail endpoint', () => {
    const withoutDetail = createBoardProvider(stubAdapter({}), { boards: [board('a')] });
    expect(withoutDetail.fetchDetail).toBeUndefined();

    const adapter = { ...stubAdapter({}), fetchDetail: async (job: RawJob) => job };
    expect(createBoardProvider(adapter, { boards: [board('a')] }).fetchDetail).toBeTypeOf(
      'function',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Board plumbing                                                             */
/* -------------------------------------------------------------------------- */

describe('boardJson', () => {
  it('reads a board', async () => {
    const { impl } = routedFetch({ '/board': { jobs: [{ id: 1 }] } });
    await expect(
      boardJson<{ jobs: unknown[] }>(context(impl), 'https://x.test/board'),
    ).resolves.toEqual({
      jobs: [{ id: 1 }],
    });
  });

  it('treats a dead slug as an empty board, not a failure', async () => {
    for (const status of [404, 410]) {
      const impl: FetchLike = async () => new Response('gone', { status });
      await expect(boardJson(context(impl), 'https://x.test/board')).resolves.toBeNull();
    }
  });

  it('still throws on a real server error', async () => {
    const impl: FetchLike = async () => new Response('boom', { status: 500 });
    await expect(boardJson(context(impl), 'https://x.test/board')).rejects.toBeInstanceOf(
      HttpError,
    );
  });

  it('names the URL when a board answers HTML instead of JSON', async () => {
    const impl: FetchLike = async () => new Response('<html>blocked</html>', { status: 200 });
    const error = await boardJson(context(impl), 'https://x.test/board').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).url).toBe('https://x.test/board');
  });
});

describe('boardScopedId', () => {
  it('round-trips a slug and an id', () => {
    expect(splitBoardScopedId(boardScopedId('stripe', 4567))).toEqual({
      slug: 'stripe',
      id: '4567',
    });
  });

  it('splits on the first colon, so an id containing one survives', () => {
    expect(splitBoardScopedId('acme:a:b')).toEqual({ slug: 'acme', id: 'a:b' });
  });

  it('returns null for anything that is not a scoped id', () => {
    for (const value of ['plain', ':leading', 'trailing:', '']) {
      expect(splitBoardScopedId(value)).toBeNull();
    }
  });
});

describe('periodFrom', () => {
  it('reads each ATS spelling of the same period', () => {
    expect(periodFrom('per-year-salary')).toBe('year');
    expect(periodFrom('1 YEAR')).toBe('year');
    expect(periodFrom('annually')).toBe('year');
    expect(periodFrom('monthly')).toBe('month');
    expect(periodFrom('per-hour')).toBe('hour');
    expect(periodFrom('weekly')).toBe('week');
  });

  it('returns null for an unknown or absent interval, so nothing is scaled by guesswork', () => {
    expect(periodFrom('NONE')).toBeNull();
    expect(periodFrom(undefined)).toBeNull();
    expect(periodFrom('')).toBeNull();
  });
});

describe('employmentTypeFrom', () => {
  it('reads the five casings the six ATSs use for the same thing', () => {
    for (const value of ['FullTime', 'full_time', 'Full-time', 'FULL_TIME', 'full time']) {
      expect(employmentTypeFrom(value), value).toBe('fulltime');
    }
  });

  it('reads the other types', () => {
    expect(employmentTypeFrom('Intern')).toBe('internship');
    expect(employmentTypeFrom('CONTRACTOR')).toBe('contract');
    expect(employmentTypeFrom('part_time')).toBe('parttime');
  });

  it('is null when the board said nothing', () => {
    expect(employmentTypeFrom(undefined)).toBeNull();
    expect(employmentTypeFrom('')).toBeNull();
  });
});

describe('provider identity', () => {
  it('is an ATS provider, which is how the UI groups it', () => {
    const provider = createBoardProvider(stubAdapter({}), { boards: [board('a')] });
    expect(provider.kind).toBe('ats');
    expect(vi.isMockFunction(provider.search)).toBe(false);
  });
});
