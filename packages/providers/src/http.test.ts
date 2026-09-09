import { describe, expect, it, vi } from 'vitest';
import {
  ALL_STATUSES,
  HttpClient,
  HttpError,
  isAbortError,
  parseRetryAfter,
  type FetchLike,
} from './http.js';

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

interface Recorded {
  url: string;
  init: RequestInit;
}

/**
 * One scripted reply. A thunk rather than a `Response`, because a body can only
 * be read once and several tests deliberately ask for the same URL twice.
 */
type Reply = () => Response | Error;

function json(body: unknown, init: ResponseInit = {}): Reply {
  return () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    });
}

function text(body: string, init: ResponseInit = {}): Reply {
  return () => new Response(body, { status: 200, ...init });
}

function fails(error: Error): Reply {
  return () => error;
}

/** A fetch that replies from a script, and remembers what it was asked. */
function fakeFetch(replies: Reply[]) {
  const calls: Recorded[] = [];
  const impl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (!reply) throw new Error(`no scripted reply for call ${calls.length}`);
    const result = reply();
    if (result instanceof Error) throw result;
    return result;
  };
  return { impl, calls };
}

/** Records what the client wanted to wait for without actually waiting. */
function fakeSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

/**
 * A sleep that never finishes. Anything genuinely waiting on the pacing gate
 * stays pending, which is what makes "was this request delayed?" observable.
 */
function blockingSleep() {
  const started: number[] = [];
  return {
    started,
    sleep: (ms: number) => {
      started.push(ms);
      return new Promise<void>(() => undefined);
    },
  };
}

/** Resolves on the next macrotask — later than any pending microtask chain. */
function nextTick<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 0));
}

/** A clock the test moves by hand. */
function fakeClock(start = 1_700_000_000_000) {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function client(
  fetchImpl: FetchLike,
  overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {},
) {
  return new HttpClient({
    fetch: fetchImpl,
    sleep: async () => undefined,
    random: () => 1,
    minIntervalMs: 0,
    ...overrides,
  });
}

/* -------------------------------------------------------------------------- */
/* Basics                                                                     */
/* -------------------------------------------------------------------------- */

describe('HttpClient', () => {
  it('parses a JSON body', async () => {
    const { impl } = fakeFetch([json({ jobs: [{ id: 7 }] })]);
    const out = await client(impl).getJson<{ jobs: { id: number }[] }>('https://a.test/jobs');
    expect(out.jobs[0]!.id).toBe(7);
  });

  it('identifies itself rather than impersonating a browser', async () => {
    const { impl, calls } = fakeFetch([json({})]);
    await client(impl).getJson('https://a.test/jobs');

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['user-agent']).toContain('job-radar');
  });

  it('lets a caller override a header', async () => {
    const { impl, calls } = fakeFetch([json({})]);
    await client(impl).getJson('https://a.test/jobs', {
      headers: { authorization: 'Bearer k' },
    });

    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer k');
    expect(headers['user-agent']).toContain('job-radar');
  });

  it('turns an HTML error page into an HttpError naming the URL', async () => {
    const { impl } = fakeFetch([text('<html>login</html>', { status: 200 })]);

    await expect(client(impl).getJson('https://a.test/jobs')).rejects.toMatchObject({
      name: 'HttpError',
      message: expect.stringContaining('not valid JSON'),
      url: 'https://a.test/jobs',
    });
  });

  it('rejects an empty body where JSON was expected', async () => {
    const { impl } = fakeFetch([text('', { status: 200 })]);
    await expect(client(impl).getJson('https://a.test/jobs')).rejects.toThrow(/empty/);
  });
});

/* -------------------------------------------------------------------------- */
/* Retry                                                                      */
/* -------------------------------------------------------------------------- */

describe('HttpClient — retry', () => {
  it('retries a 503 and returns the eventual success', async () => {
    const { impl, calls } = fakeFetch([text('nope', { status: 503 }), json({ ok: true })]);

    const out = await client(impl).getJson<{ ok: boolean }>('https://a.test/jobs');

    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('retries a thrown network error', async () => {
    const { impl, calls } = fakeFetch([fails(new TypeError('fetch failed')), json({ ok: true })]);
    await client(impl).getJson('https://a.test/jobs');
    expect(calls).toHaveLength(2);
  });

  it('does not retry a 404 — that is an answer, not a hiccup', async () => {
    const { impl, calls } = fakeFetch([text('missing', { status: 404 })]);

    await expect(client(impl).getJson('https://a.test/jobs')).rejects.toMatchObject({
      kind: 'http',
      status: 404,
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('gives up after the configured number of retries', async () => {
    const { impl, calls } = fakeFetch([text('busy', { status: 500 })]);

    await expect(
      client(impl, { retries: 2 }).getJson('https://a.test/jobs'),
    ).rejects.toBeInstanceOf(HttpError);

    expect(calls).toHaveLength(3); // the first attempt plus two retries
  });

  it('backs off exponentially between attempts', async () => {
    const { waits, sleep } = fakeSleep();
    const { impl } = fakeFetch([text('busy', { status: 500 })]);

    await expect(
      client(impl, { sleep, retries: 3, baseBackoffMs: 100, random: () => 1 }).getJson(
        'https://a.test/jobs',
      ),
    ).rejects.toBeInstanceOf(HttpError);

    expect(waits).toEqual([100, 200, 400]);
  });

  it('caps the backoff so a long outage does not stall the run', async () => {
    const { waits, sleep } = fakeSleep();
    const { impl } = fakeFetch([text('busy', { status: 500 })]);

    await expect(
      client(impl, {
        sleep,
        retries: 5,
        baseBackoffMs: 1_000,
        maxBackoffMs: 3_000,
        random: () => 1,
      }).getJson('https://a.test/jobs'),
    ).rejects.toBeInstanceOf(HttpError);

    expect(Math.max(...waits)).toBe(3_000);
  });

  it('jitters the backoff so a fan-out does not retry in lockstep', async () => {
    const { waits, sleep } = fakeSleep();
    const { impl } = fakeFetch([text('busy', { status: 500 })]);

    await expect(
      client(impl, { sleep, retries: 1, baseBackoffMs: 100, random: () => 0 }).getJson(
        'https://a.test/jobs',
      ),
    ).rejects.toBeInstanceOf(HttpError);

    // random() === 0 is the bottom of the full-jitter band: half the ceiling.
    expect(waits).toEqual([50]);
  });

  it('waits exactly as long as a 429 asked it to', async () => {
    const { waits, sleep } = fakeSleep();
    const { impl } = fakeFetch([
      text('slow down', { status: 429, headers: { 'retry-after': '7' } }),
      json({ ok: true }),
    ]);

    await client(impl, { sleep, baseBackoffMs: 100 }).getJson('https://a.test/jobs');

    expect(waits).toEqual([7_000]);
  });

  it('will not honour a Retry-After longer than its own ceiling', async () => {
    const { waits, sleep } = fakeSleep();
    const { impl } = fakeFetch([
      text('slow down', { status: 429, headers: { 'retry-after': '3600' } }),
      json({ ok: true }),
    ]);

    await client(impl, { sleep, maxBackoffMs: 15_000 }).getJson('https://a.test/jobs');

    expect(waits).toEqual([15_000]);
  });
});

/* -------------------------------------------------------------------------- */
/* Cancellation and limits                                                    */
/* -------------------------------------------------------------------------- */

describe('HttpClient — cancellation and limits', () => {
  it('makes no request at all when already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const { impl, calls } = fakeFetch([json({})]);

    await expect(
      client(impl).getJson('https://a.test/jobs', { signal: controller.signal }),
    ).rejects.toSatisfy(isAbortError);
    expect(calls).toHaveLength(0);
  });

  it('does not retry a cancelled request', async () => {
    const controller = new AbortController();
    const { impl, calls } = fakeFetch([
      () => {
        controller.abort();
        const error = new Error('aborted');
        error.name = 'AbortError';
        return error;
      },
    ]);

    await expect(
      client(impl, { retries: 3 }).getJson('https://a.test/jobs', { signal: controller.signal }),
    ).rejects.toSatisfy(isAbortError);
    expect(calls).toHaveLength(1);
  });

  it('reports a timeout as a timeout, and retries it', async () => {
    // The fake never answers, so only the client's own deadline ends the call.
    const calls: string[] = [];
    const impl: FetchLike = (url, init) =>
      new Promise((_resolve, reject) => {
        calls.push(url);
        init.signal?.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });

    await expect(
      client(impl, { timeoutMs: 5, retries: 1 }).getJson('https://a.test/jobs'),
    ).rejects.toMatchObject({ kind: 'timeout' });
    expect(calls).toHaveLength(2);
  });

  it('refuses a response that declares itself larger than the limit', async () => {
    const { impl, calls } = fakeFetch([
      text('x', { status: 200, headers: { 'content-length': '999999999' } }),
    ]);

    await expect(
      client(impl, { maxBytes: 1_000 }).getJson('https://a.test/jobs'),
    ).rejects.toMatchObject({ kind: 'too-large' });
    expect(calls).toHaveLength(1); // not retried: it will be just as large next time
  });

  it('refuses an oversized body even when content-length lied', async () => {
    const { impl } = fakeFetch([text('x'.repeat(5_000), { status: 200 })]);

    await expect(
      client(impl, { maxBytes: 1_000 }).getJson('https://a.test/jobs'),
    ).rejects.toMatchObject({ kind: 'too-large' });
  });
});

/* -------------------------------------------------------------------------- */
/* Accepted statuses and probe                                                */
/* -------------------------------------------------------------------------- */

describe('HttpClient — statuses the caller expects', () => {
  it('hands back a 404 the caller said to accept', async () => {
    const { impl } = fakeFetch([text('no such board', { status: 404 })]);

    const response = await client(impl).get('https://a.test/boards/unknown', {
      acceptStatuses: [404],
    });

    expect(response.status).toBe(404);
  });

  it('probe confirms a page that exists', async () => {
    const { impl } = fakeFetch([text('<html>careers</html>', { status: 200 })]);
    await expect(client(impl).probe('https://a.test/careers')).resolves.toMatchObject({
      ok: true,
      status: 200,
    });
  });

  it('probe reports a missing page instead of throwing', async () => {
    const { impl } = fakeFetch([text('nope', { status: 404 })]);
    await expect(client(impl).probe('https://a.test/careers')).resolves.toMatchObject({
      ok: false,
      status: 404,
    });
  });

  it('probe reports an unreachable host as unconfirmed', async () => {
    const { impl } = fakeFetch([fails(new TypeError('getaddrinfo ENOTFOUND'))]);
    // "We could not confirm it" is the answer either way — enrichment records a
    // null rather than a guessed URL.
    await expect(
      client(impl, { retries: 0 }).probe('https://nope.test/careers'),
    ).resolves.toMatchObject({ ok: false, status: null });
  });

  it('probe still surfaces a cancelled run', async () => {
    const controller = new AbortController();
    controller.abort();
    const { impl } = fakeFetch([json({})]);

    await expect(
      client(impl).probe('https://a.test/careers', { signal: controller.signal }),
    ).rejects.toSatisfy(isAbortError);
  });
});

/* -------------------------------------------------------------------------- */
/* Cache                                                                      */
/* -------------------------------------------------------------------------- */

describe('HttpClient — cache', () => {
  it('serves a repeat GET without a second request', async () => {
    const { impl, calls } = fakeFetch([json({ n: 1 })]);
    const http = client(impl, { cacheTtlMs: 60_000 });

    const first = await http.get('https://a.test/jobs');
    const second = await http.get('https://a.test/jobs');

    expect(calls).toHaveLength(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.body).toBe(first.body);
  });

  it('re-fetches once the entry has expired', async () => {
    const clock = fakeClock();
    const { impl, calls } = fakeFetch([json({ n: 1 }), json({ n: 2 })]);
    const http = client(impl, { cacheTtlMs: 1_000, now: clock.now });

    await http.get('https://a.test/jobs');
    clock.advance(1_001);
    await http.get('https://a.test/jobs');

    expect(calls).toHaveLength(2);
  });

  it('collapses concurrent identical requests into one', async () => {
    const calls: string[] = [];
    let release!: (value: Response) => void;
    const answered = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const impl: FetchLike = (url) => {
      calls.push(url);
      return answered;
    };
    const http = client(impl, { cacheTtlMs: 60_000 });

    const both = Promise.all([http.get('https://a.test/jobs'), http.get('https://a.test/jobs')]);
    release(new Response(JSON.stringify({ n: 1 }), { status: 200 }));
    const [first, second] = await both;

    expect(calls).toHaveLength(1);
    expect(second!.body).toBe(first!.body);
  });

  it('honours noCache', async () => {
    const { impl, calls } = fakeFetch([json({ n: 1 }), json({ n: 2 })]);
    const http = client(impl, { cacheTtlMs: 60_000 });

    await http.get('https://a.test/jobs');
    await http.get('https://a.test/jobs', { noCache: true });

    expect(calls).toHaveLength(2);
  });

  it('never caches a POST', async () => {
    const { impl, calls } = fakeFetch([json({ n: 1 }), json({ n: 2 })]);
    const http = client(impl, { cacheTtlMs: 60_000 });

    await http.postJson('https://a.test/search', { q: 'react' });
    await http.postJson('https://a.test/search', { q: 'react' });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.init.method).toBe('POST');
  });

  it('evicts the least recently used entry when full', async () => {
    const { impl, calls } = fakeFetch([json({})]);
    const http = client(impl, { cacheTtlMs: 60_000, maxCacheEntries: 2 });

    await http.get('https://a.test/1');
    await http.get('https://a.test/2');
    await http.get('https://a.test/1'); // touch 1, making 2 the oldest
    await http.get('https://a.test/3'); // evicts 2
    await http.get('https://a.test/1'); // still cached
    await http.get('https://a.test/2'); // gone: refetched

    expect(calls.map((c) => c.url)).toEqual([
      'https://a.test/1',
      'https://a.test/2',
      'https://a.test/3',
      'https://a.test/2',
    ]);
  });

  it('clearCache drops everything', async () => {
    const { impl, calls } = fakeFetch([json({})]);
    const http = client(impl, { cacheTtlMs: 60_000 });

    await http.get('https://a.test/jobs');
    http.clearCache();
    await http.get('https://a.test/jobs');

    expect(calls).toHaveLength(2);
  });

  it('does not cache a failure', async () => {
    const { impl, calls } = fakeFetch([text('nope', { status: 404 }), json({ ok: true })]);
    const http = client(impl, { cacheTtlMs: 60_000 });

    await expect(http.get('https://a.test/jobs')).rejects.toBeInstanceOf(HttpError);
    await expect(http.get('https://a.test/jobs')).resolves.toMatchObject({ status: 200 });
    expect(calls).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Per-host pacing                                                            */
/* -------------------------------------------------------------------------- */

describe('HttpClient — pacing', () => {
  it('does not delay the first request to a host', async () => {
    // The gate is blocked from the outset. If the first request waited on it,
    // this test would hang rather than fail — which is the honest signal.
    const { sleep } = blockingSleep();
    const { impl } = fakeFetch([json({})]);

    const response = await client(impl, { sleep, minIntervalMs: 250 }).get('https://a.test/1');

    expect(response.status).toBe(200);
  });

  it('makes the next request to that host wait its turn', async () => {
    const { started, sleep } = blockingSleep();
    const { impl, calls } = fakeFetch([json({})]);
    const http = client(impl, { sleep, minIntervalMs: 250, cacheTtlMs: 0 });

    await http.get('https://a.test/1');
    const second = http.get('https://a.test/2');

    await expect(Promise.race([second, nextTick('still waiting')])).resolves.toBe('still waiting');
    expect(calls).toHaveLength(1);
    expect(started).toEqual([250]); // one slot booked, by the request that got through
  });

  it('lets a fast host run while a slow one is still waiting', async () => {
    // Real timers here: the point of the test is that the two hosts' queues are
    // genuinely independent, which a synchronous fake sleep would hide.
    const order: string[] = [];
    const impl: FetchLike = async (url) => {
      order.push(new URL(url).pathname);
      return new Response('{}', { status: 200 });
    };
    const http = new HttpClient({
      fetch: impl,
      minIntervalMs: 40,
      cacheTtlMs: 0,
      random: () => 1,
    });

    await Promise.all([
      http.get('https://slow.test/first'),
      http.get('https://slow.test/second'),
      http.get('https://fast.test/only'),
    ]);

    expect(order).toEqual(['/first', '/only', '/second']);
  });

  it('skips pacing entirely when the interval is zero', async () => {
    const { waits, sleep } = fakeSleep();
    const { impl } = fakeFetch([json({})]);
    const http = client(impl, { sleep, minIntervalMs: 0, cacheTtlMs: 0 });

    await http.get('https://a.test/1');
    await http.get('https://a.test/2');

    expect(waits).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Small pieces                                                               */
/* -------------------------------------------------------------------------- */

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');

  it('reads a delay in seconds', () => {
    expect(parseRetryAfter('30', now)).toBe(30_000);
  });

  it('reads an HTTP date', () => {
    expect(parseRetryAfter('Sat, 05 Sep 2026 12:00:45 GMT', now)).toBe(45_000);
  });

  it('never returns a negative wait for a date already past', () => {
    expect(parseRetryAfter('Sat, 05 Sep 2026 11:00:00 GMT', now)).toBe(0);
  });

  it('ignores a header it cannot read', () => {
    expect(parseRetryAfter('soon', now)).toBeNull();
    expect(parseRetryAfter(undefined, now)).toBeNull();
  });
});

describe('isAbortError', () => {
  it('recognises a cancelled run', () => {
    expect(isAbortError(new HttpError('x', { kind: 'aborted', url: '' }))).toBe(true);
  });

  it('does not mistake a real failure for a cancellation', () => {
    expect(isAbortError(new HttpError('x', { kind: 'network', url: '' }))).toBe(false);
    expect(isAbortError(new Error('boom'))).toBe(false);
  });

  it('recognises the platform AbortError', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    expect(isAbortError(error)).toBe(true);
  });
});

describe('ALL_STATUSES', () => {
  it('accepts anything the server returns', async () => {
    const { impl } = fakeFetch([text('gone', { status: 410 })]);
    const response = await client(impl).get('https://a.test/x', { acceptStatuses: ALL_STATUSES });
    expect(response.status).toBe(410);
  });

  it('is frozen, so a caller cannot turn it into a real list by accident', () => {
    expect(Object.isFrozen(ALL_STATUSES)).toBe(true);
  });
});

describe('HttpClient — logging surface', () => {
  it('keeps the failing URL and a body excerpt on the error', async () => {
    const { impl } = fakeFetch([text('rate limit exceeded for org', { status: 403 })]);
    const spy = vi.fn();

    await client(impl)
      .getJson('https://a.test/boards/acme')
      .catch((error: unknown) => spy(error));

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://a.test/boards/acme',
        status: 403,
        body: 'rate limit exceeded for org',
      }),
    );
  });
});
