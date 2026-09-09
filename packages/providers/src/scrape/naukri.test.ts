/**
 * Naukri, through the JSON API its own search page calls.
 *
 * This adapter has more moving parts than the other two, and all of them are
 * about a token it is not allowed to forge. The suite is organised around that:
 *
 *  - **Bootstrap** observes the `nkparam` the page mints for itself. The tests
 *    pin what is resent and what is dropped, and — the case that matters — that
 *    a page which loads but never runs its own search is reported as a wall
 *    rather than as a market with no jobs in it.
 *  - **The walk** pins the query Naukri is actually asked, the two independent
 *    reasons pagination stops, and the one-shot re-bootstrap on a mid-walk 406.
 *  - **Detail** is the expensive call, so the tests pin when it is *skipped* as
 *    carefully as what it returns.
 *
 * Both payloads are captured from the live API, which is why the assertions can
 * be exact: real job ids, a real 912-character description, Naukri's real
 * `"Full Time, Permanent"` spelling of an employment type.
 */

import type { ProviderQuery, RawJob } from '@job-radar/shared';
import { describe, expect, it, vi } from 'vitest';
import { query } from '../harness.fixtures.js';
import type { ScrapeContext, ScrapePage } from './base.js';
import {
  fakeSession,
  type FakeSessionOptions,
  fixtureJson,
  scrapeContext,
} from './harness.fixtures.js';
import { type NaukriJob, naukriAdapter, seoSearchUrl } from './naukri.js';

const ORIGIN = 'https://www.naukri.com';
const SEARCH_API = `${ORIGIN}/jobapi/v3/search`;

interface SearchPayload {
  noOfJobs: number;
  jobDetails: NaukriJob[];
}

const searchPayload = fixtureJson<SearchPayload>('naukri-search.json');
const detailPayload = fixtureJson<{ jobDetails: Record<string, unknown> }>('naukri-detail.json');

/** The posting `naukri-detail.json` was captured from. */
const DETAIL_ID = '010926914885';

/** A plausible captured request, carrying the token and the noise around it. */
const PAGE_REQUEST = {
  url: `${SEARCH_API}?noOfResults=20&keyword=full+stack`,
  headers: {
    nkparam: 'AbC123==',
    appid: '109',
    systemid: 'Naukri',
    accept: 'application/json',
    // Everything below is dropped on the way back out.
    ':authority': 'www.naukri.com',
    'sec-fetch-mode': 'cors',
    host: 'www.naukri.com',
    cookie: 'test=1',
    'content-length': '0',
    'accept-encoding': 'gzip, deflate, br',
  },
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** A session that boots cleanly, with whatever search replies the test needs. */
function booted(options: FakeSessionOptions = {}) {
  const session = fakeSession({
    navigate: { [ORIGIN]: { status: 200, body: '<html><body>Naukri</body></html>' } },
    requests: [PAGE_REQUEST],
    ...options,
  });
  return { session, ctx: scrapeContext(session) };
}

/** `count` distinct postings, so pagination is not confused with deduping. */
function stubs(count: number, page = 1): NaukriJob[] {
  return Array.from({ length: count }, (_unused, index) => ({
    jobId: `p${page}-${index}`,
    title: `Role ${page}-${index}`,
    companyName: 'Acme',
  }));
}

/** Replies in order, repeating the last — a paginated endpoint in three lines. */
function serve(...payloads: readonly SearchPayload[]): () => { json: unknown } {
  let index = 0;
  return () => {
    const payload = payloads[Math.min(index, payloads.length - 1)];
    index += 1;
    return { json: payload };
  };
}

async function walk(ctx: ScrapeContext, q: ProviderQuery): Promise<Array<ScrapePage<NaukriJob>>> {
  const pages: Array<ScrapePage<NaukriJob>> = [];
  for await (const page of naukriAdapter.pages(ctx, q, 0)) pages.push(page);
  return pages;
}

/** Drains a walk that spans pages, paying its 900 ms courtesy gaps instantly. */
async function walkFast(
  ctx: ScrapeContext,
  q: ProviderQuery,
): Promise<Array<ScrapePage<NaukriJob>>> {
  vi.useFakeTimers();
  try {
    const pending = walk(ctx, q);
    await vi.advanceTimersByTimeAsync(60_000);
    return await pending;
  } finally {
    vi.useRealTimers();
  }
}

/** The params of the nth search call. */
function paramsOf(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

/* -------------------------------------------------------------------------- */
/* The search page we bootstrap from                                          */
/* -------------------------------------------------------------------------- */

describe('seoSearchUrl', () => {
  it('builds the human URL Naukri publishes', () => {
    expect(
      seoSearchUrl(query({ titles: ['Full Stack Developer'], locations: ['Bengaluru'] })),
    ).toBe(`${ORIGIN}/full-stack-developer-jobs-in-bengaluru`);
  });

  it('drops the city when the user only wants remote', () => {
    // A city in the slug of a work-from-home search narrows it for no reason —
    // the posting is remote, so where the office is is not the question.
    expect(
      seoSearchUrl(query({ titles: ['Backend Engineer'], locations: ['Pune'], remoteOnly: true })),
    ).toBe(`${ORIGIN}/backend-engineer-jobs`);
  });

  it('still lands on a real search page when the profile is empty', () => {
    // Naukri renders a search for any slug rather than 404ing, but an empty one
    // would produce `${ORIGIN}/-jobs` — a URL, not a search.
    expect(seoSearchUrl(query())).toBe(`${ORIGIN}/software-developer-jobs`);

    // The regression this pair exists for: the default is the *title's*. When it
    // was `slug()`'s, a profile with no usable city bootstrapped off
    // "software-developer-jobs-in-software-developer" — a page that loads, and
    // searches for the wrong thing, which is the kind of wrong nobody notices.
    expect(seoSearchUrl(query({ titles: ['!!!'], locations: ['???'] }))).toBe(
      `${ORIGIN}/software-developer-jobs`,
    );
    expect(seoSearchUrl(query({ titles: ['Data Engineer'], locations: [] }))).toBe(
      `${ORIGIN}/data-engineer-jobs`,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Bootstrap                                                                  */
/* -------------------------------------------------------------------------- */

describe('bootstrap', () => {
  it('resends the token the page minted, and none of the noise around it', async () => {
    const { session, ctx } = booted({
      api: { 'jobapi/v3/search': { json: { jobDetails: [], noOfJobs: 0 } } },
    });

    await walk(ctx, query({ titles: ['Full Stack'], locations: ['Bengaluru'] }));

    const sent = session.apiCalls[0]?.headers ?? {};
    // The whole mechanism: the token is observed, never computed. Forging it is
    // the evasion work this tier does not do.
    expect(sent.nkparam).toBe('AbC123==');
    expect(sent.appid).toBe('109');
    expect(sent.systemid).toBe('Naukri');

    // HTTP/2 pseudo-headers and the `sec-*` family are the client's to set and
    // are rejected or ignored when passed explicitly; the cookie jar already
    // lives on the context, so resending it can only contradict it.
    for (const dropped of [
      ':authority',
      'sec-fetch-mode',
      'host',
      'cookie',
      'content-length',
      'accept-encoding',
    ]) {
      expect(sent[dropped]).toBeUndefined();
    }
  });

  it('navigates once for a walk of many queries', async () => {
    const { session, ctx } = booted({
      api: { 'jobapi/v3/search': { json: { jobDetails: [], noOfJobs: 0 } } },
    });

    await walk(ctx, query({ titles: ['Full Stack', 'Backend'], locations: ['Bengaluru', 'Pune'] }));

    // Four keyword/location pairs on one token. This is why the adapter is
    // affordable at all: a navigation per query would be four page loads.
    expect(session.navigations).toHaveLength(1);
    expect(session.apiCalls).toHaveLength(4);
  });

  it('reports a refused navigation as a block, and asks for nothing after it', async () => {
    const session = fakeSession({
      navigate: { [ORIGIN]: { status: 403, body: '<html>denied</html>' } },
      requests: [],
    });
    const ctx = scrapeContext(session);

    const pages = await walk(ctx, query({ titles: ['Full Stack'], locations: ['Bengaluru'] }));

    expect(pages).toHaveLength(1);
    expect(pages[0]?.items).toEqual([]);
    expect(pages[0]?.block?.kind).toBe('forbidden');
    // No token, so no request could have been honest. Zero, not "try anyway".
    expect(session.apiCalls).toHaveLength(0);
  });

  it('names a challenge served with a 200', async () => {
    const session = fakeSession({
      navigate: {
        [ORIGIN]: {
          status: 200,
          body: '<html><head><title>Just a moment...</title></head></html>',
        },
      },
      requests: [],
    });

    const pages = await walk(
      scrapeContext(session),
      query({ titles: ['Full Stack'], locations: ['Bengaluru'] }),
    );

    expect(pages[0]?.block?.kind).toBe('challenge');
  });

  it('refuses to call a page that never ran its own search an empty market', async () => {
    // The quietest failure in the adapter. The page loads, the status is 200,
    // nothing looks like a wall — and no search ever happens, because the
    // JavaScript that mints the token was never allowed to run. Reporting that
    // as zero jobs is how a user concludes hiring has stopped.
    const session = fakeSession({
      navigate: { [ORIGIN]: { status: 200, body: '<html><body>shell</body></html>' } },
      requests: null,
    });

    vi.useFakeTimers();
    try {
      const pending = walk(
        scrapeContext(session),
        query({ titles: ['Full Stack'], locations: ['Bengaluru'] }),
      );
      // Past the 15-second poll, in steps, so each `delay(250)` the loop
      // schedules mid-advance is also run.
      await vi.advanceTimersByTimeAsync(20_000);
      const pages = await pending;

      expect(pages[0]?.block?.kind).toBe('challenge');
      expect(pages[0]?.block?.message).toContain('never ran its own job search');
      expect(pages[0]?.block?.message).toContain('this is not an empty market');
      expect(session.apiCalls).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up the poll early when the run is cancelled', async () => {
    const session = fakeSession({
      navigate: { [ORIGIN]: { status: 200, body: '<html><body>shell</body></html>' } },
      requests: null,
    });
    const ctx = { ...scrapeContext(session), signal: AbortSignal.abort() };

    // Aborted before the first tick, so the 15 seconds are never spent. A run
    // the user cancelled must not hold the queue open waiting for a token it
    // has no use for.
    const pages = await walk(ctx, query({ titles: ['Full Stack'], locations: ['Bengaluru'] }));

    expect(pages[0]?.block?.kind).toBe('challenge');
  });
});

/* -------------------------------------------------------------------------- */
/* The query                                                                  */
/* -------------------------------------------------------------------------- */

describe('pages — the query Naukri is asked', () => {
  it('throws rather than running without a browser', async () => {
    // `base.ts` only leases a browser for `needsBrowser` adapters, so reaching
    // here without one is a wiring bug — and a silent empty result would hide it.
    await expect(walk(scrapeContext(), query())).rejects.toThrow('naukri needs a browser session');
  });

  it("sends the keyword, the location and Naukri's own recency filter", async () => {
    const { session, ctx } = booted({
      api: { 'jobapi/v3/search': { json: { jobDetails: [], noOfJobs: 0 } } },
    });

    await walk(
      ctx,
      query({ titles: ['Full Stack'], locations: ['Bengaluru'], postedWithinDays: 7 }),
    );

    const params = paramsOf(session.apiCalls[0]?.url ?? '');
    expect(params.get('keyword')).toBe('Full Stack');
    // Lowercased because Naukri's location facet is, and a mismatched case
    // silently widens the search to the whole country.
    expect(params.get('location')).toBe('bengaluru');
    expect(params.get('noOfResults')).toBe('20');
    expect(params.get('pageNo')).toBe('1');
    expect(params.get('urlType')).toBe('search_by_key_loc');
    expect(params.get('searchType')).toBe('adv');
    // Filtering server-side took a 15,151-result probe down to 1,759 — all of
    // them inside the window the local gate would have kept anyway.
    expect(params.get('jobAge')).toBe('7');
    expect(params.get('wfhType')).toBeNull();
  });

  it('omits the recency filter when the user did not ask for one', async () => {
    const { session, ctx } = booted({
      api: { 'jobapi/v3/search': { json: { jobDetails: [], noOfJobs: 0 } } },
    });

    await walk(
      ctx,
      query({ titles: ['Full Stack'], locations: ['Bengaluru'], postedWithinDays: 0 }),
    );

    // `jobAge=0` is not "no filter" to Naukri — it is a filter that matches
    // almost nothing.
    expect(paramsOf(session.apiCalls[0]?.url ?? '').get('jobAge')).toBeNull();
  });

  it("searches all of India on Naukri's own remote facet", async () => {
    const { session, ctx } = booted({
      api: { 'jobapi/v3/search': { json: { jobDetails: [], noOfJobs: 0 } } },
    });

    await walk(ctx, query({ titles: ['Backend'], locations: ['Pune'], remoteOnly: true }));

    const params = paramsOf(session.apiCalls[0]?.url ?? '');
    expect(params.get('location')).toBe('india');
    expect(params.get('wfhType')).toBe('2');
  });

  it('tries the first title everywhere before it tries the second anywhere', async () => {
    const { session, ctx } = booted({
      api: { 'jobapi/v3/search': { json: { jobDetails: [], noOfJobs: 0 } } },
    });

    await walk(ctx, query({ titles: ['Full Stack', 'Backend'], locations: ['Bengaluru', 'Pune'] }));

    // The result budget is far likelier to run out mid-walk than to survive it,
    // and running out having covered the title the user cares about is the
    // better failure.
    expect(
      session.apiCalls.map(({ url }) => {
        const params = paramsOf(url);
        return `${params.get('keyword')}/${params.get('location')}`;
      }),
    ).toEqual(['Full Stack/bengaluru', 'Full Stack/pune', 'Backend/bengaluru', 'Backend/pune']);
  });

  it('caps how many titles and locations it will spend a walk on', async () => {
    const { session, ctx } = booted({
      api: { 'jobapi/v3/search': { json: { jobDetails: [], noOfJobs: 0 } } },
    });

    await walk(
      ctx,
      query({
        titles: ['A', 'B', 'C', 'D', 'E'],
        locations: ['L1', 'L2', 'L3', 'L4'],
      }),
    );

    // Three titles × two locations. Uncapped, a well-filled profile turns into
    // twenty paginated walks and a run that never finishes.
    expect(session.apiCalls).toHaveLength(6);
  });
});

/* -------------------------------------------------------------------------- */
/* Pagination                                                                 */
/* -------------------------------------------------------------------------- */

describe('pages — pagination', () => {
  it('stops a query as soon as a page comes back short', async () => {
    const { session, ctx } = booted({
      api: { 'jobapi/v3/search': { json: { jobDetails: stubs(19), noOfJobs: 500 } } },
    });

    const pages = await walk(ctx, query({ titles: ['Full Stack'], locations: ['Bengaluru'] }));

    // 19 of a possible 20 means the end, whatever `noOfJobs` claims.
    expect(session.apiCalls).toHaveLength(1);
    expect(pages[0]?.items).toHaveLength(19);
  });

  it('stops when it has already seen everything Naukri says exists', async () => {
    const { session, ctx } = booted({
      api: { 'jobapi/v3/search': { json: { jobDetails: stubs(20), noOfJobs: 20 } } },
    });

    // A full page that is also the whole result set. Without this check the
    // adapter would ask for page 2 of a 20-result query on every walk.
    await walk(ctx, query({ titles: ['Full Stack'], locations: ['Bengaluru'] }));

    expect(session.apiCalls).toHaveLength(1);
  });

  it('walks three pages and no further', async () => {
    const { session, ctx } = booted({
      api: {
        'jobapi/v3/search': serve(
          { jobDetails: stubs(20, 1), noOfJobs: 500 },
          { jobDetails: stubs(20, 2), noOfJobs: 500 },
          { jobDetails: stubs(20, 3), noOfJobs: 500 },
          { jobDetails: stubs(20, 4), noOfJobs: 500 },
        ),
      },
    });

    const pages = await walkFast(ctx, query({ titles: ['Full Stack'], locations: ['Bengaluru'] }));

    // Page 4 of a probe came back entirely "30+ Days Ago": past three pages the
    // ordering has stopped being about the query, so breadth across the user's
    // other titles is worth more than depth here.
    expect(session.apiCalls.map(({ url }) => paramsOf(url).get('pageNo'))).toEqual(['1', '2', '3']);
    expect(pages.map((page) => page.items.length)).toEqual([20, 20, 20]);
  });

  it('never yields the same posting twice across queries', async () => {
    const { ctx } = booted({
      api: { 'jobapi/v3/search': { json: searchPayload } },
    });

    const pages = await walk(
      ctx,
      query({ titles: ['Full Stack', 'Backend'], locations: ['Bengaluru'] }),
    );

    // The same three postings answer both titles. Each repeat would otherwise
    // cost a detail *navigation* downstream, which is the expensive call.
    expect(pages.flatMap((page) => page.items.map((job) => job.jobId))).toEqual([
      '200826920707',
      '030926023934',
      '020926010034',
    ]);
    expect(pages[1]?.items).toEqual([]);
  });

  it('stops mid-walk when the run is cancelled', async () => {
    const controller = new AbortController();
    const { session } = booted({
      api: { 'jobapi/v3/search': { json: { jobDetails: stubs(5), noOfJobs: 5 } } },
    });
    const ctx = { ...scrapeContext(session), signal: controller.signal };

    controller.abort();
    const pages = await walk(ctx, query({ titles: ['Full Stack'], locations: ['Bengaluru'] }));

    // Bootstrapped, then abandoned before the first search. Cancelling a run
    // has to stop the requests, not just discard their answers.
    expect(pages).toEqual([]);
    expect(session.apiCalls).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Refusal                                                                    */
/* -------------------------------------------------------------------------- */

describe('pages — when Naukri says no', () => {
  it('refreshes an aged-out token once and carries on', async () => {
    let attempt = 0;
    const { session, ctx } = booted({
      api: {
        'jobapi/v3/search': () => {
          attempt += 1;
          return attempt === 1
            ? { status: 406, body: 'Not Acceptable' }
            : { json: { jobDetails: stubs(3), noOfJobs: 3 } };
        },
      },
    });

    const pages = await walk(ctx, query({ titles: ['Full Stack'], locations: ['Bengaluru'] }));

    // 406 mid-walk means the token expired, not that we are unwelcome. One
    // extra navigation turns a dead run into a live one; treating it as a block
    // would throw away a walk that was about to succeed.
    expect(session.navigations).toHaveLength(2);
    expect(session.apiCalls).toHaveLength(2);
    expect(pages[0]?.items).toHaveLength(3);
    expect(pages[0]?.block).toBeUndefined();
  });

  it('gives up when the refreshed session is itself walled', async () => {
    let navigation = 0;
    const session = fakeSession({
      navigate: {
        [ORIGIN]: () => {
          navigation += 1;
          return navigation === 1
            ? { status: 200, body: '<html><body>Naukri</body></html>' }
            : { status: 200, body: '<div class="g-recaptcha"></div>' };
        },
      },
      requests: [PAGE_REQUEST],
      api: { 'jobapi/v3/search': { status: 406, body: 'Not Acceptable' } },
    });

    const pages = await walk(
      scrapeContext(session),
      query({ titles: ['Full Stack'], locations: ['Bengaluru'] }),
    );

    // The retry is once, not a loop. A second 406 with a fresh token is Naukri
    // declining, and the honest answer is to say so.
    expect(pages[0]?.block?.kind).toBe('captcha');
    expect(session.apiCalls).toHaveLength(1);
  });

  it('names a rate limit rather than reporting an empty page', async () => {
    const { ctx } = booted({
      api: { 'jobapi/v3/search': { status: 429, body: 'slow down' } },
    });

    const pages = await walk(ctx, query({ titles: ['Full Stack'], locations: ['Bengaluru'] }));

    expect(pages[0]?.items).toEqual([]);
    expect(pages[0]?.block?.kind).toBe('rate-limited');
  });

  it('calls an unrecognised refusal a refusal anyway', async () => {
    const { session, ctx } = booted({
      api: { 'jobapi/v3/search': { status: 500, body: 'upstream exploded' } },
    });

    const pages = await walk(
      ctx,
      query({ titles: ['Full Stack', 'Backend'], locations: ['Bengaluru'] }),
    );

    // No signature matches a 500, and `detectBlock` correctly declines to
    // invent one — so the adapter supplies the sentence itself. The one thing
    // that must never happen here is `{ items: [] }` with no block on it: the
    // user would read "0 postings" and conclude the market is quiet.
    expect(pages[0]?.block?.kind).toBe('forbidden');
    expect(pages[0]?.block?.message).toContain('HTTP 500');
    expect(pages[0]?.block?.message).toContain('this is a refusal, not an empty result');
    // And the walk stops — the second title is not attempted.
    expect(session.apiCalls).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* -------------------------------------------------------------------------- */

describe('toRawJob', () => {
  const [infosys, tcs] = searchPayload.jobDetails;

  it('maps a real posting, field for field', () => {
    expect(naukriAdapter.toRawJob(infosys!, 0)).toEqual({
      source: 'naukri',
      sourceJobId: '200826920707',
      title: 'Full Stack Developer',
      companyName: 'Infosys',
      location: 'Bengaluru',
      isRemote: false,
      description: 'Bachelor of Engineering,Intergrated course BCA+MCA,MCA',
      descriptionIsHtml: true,
      hasFullDescription: false,
      postedAt: '2026-09-03T04:36:49.703Z',
      applyUrl: `${ORIGIN}/job-listings-full-stack-developer-infosys-limited-bengaluru-3-to-5-years-200826920707`,
      sourceUrl: `${ORIGIN}/job-listings-full-stack-developer-infosys-limited-bengaluru-3-to-5-years-200826920707`,
    });
  });

  it('admits the list description is a teaser', () => {
    // 54 characters, 148, and 374 — every posting in the capture is under the
    // engine's 400-character floor. Claiming otherwise here is exactly how a
    // strong match would be capped at 80% for being unread, or a two-line
    // teaser would be scored as though it were the whole job.
    for (const job of searchPayload.jobDetails) {
      expect(naukriAdapter.toRawJob(job, 0)?.hasFullDescription).toBe(false);
    }
  });

  it('records no salary at all when Naukri hides it', () => {
    const job = naukriAdapter.toRawJob(infosys!, 0)!;

    // `hideSalary` postings return zeros. Writing those through as ₹0 would
    // read as "this job pays nothing" and sink the compensation dimension;
    // absent is undisclosed, which the engine scores as neutral.
    expect(job.salaryMin).toBeUndefined();
    expect(job.salaryMax).toBeUndefined();
    expect(job.salaryRaw).toBeUndefined();
    expect(job.salaryCurrency).toBeUndefined();
  });

  it('reads a disclosed salary as absolute annual rupees', () => {
    const disclosed = naukriAdapter.toRawJob(
      {
        ...infosys!,
        placeholders: [
          { type: 'salary', label: '20-30 Lacs PA' },
          { type: 'location', label: 'Pune' },
        ],
        salaryDetail: {
          minimumSalary: 2_000_000,
          maximumSalary: 3_000_000,
          currency: 'INR',
          hideSalary: false,
        },
      },
      0,
    );

    // Confirmed against twelve disclosed postings: 3000000 renders as
    // "20-30 Lacs PA", so the numbers need no unit guessing. The label rides
    // along because it is what the user recognises in the export.
    expect(disclosed).toMatchObject({
      salaryMin: 2_000_000,
      salaryMax: 3_000_000,
      salaryCurrency: 'INR',
      salaryPeriod: 'year',
      salaryRaw: '20-30 Lacs PA',
    });
  });

  it('does not record "Not disclosed" as a salary the user could read', () => {
    const job = naukriAdapter.toRawJob(
      {
        ...infosys!,
        salaryDetail: { minimumSalary: 500_000, hideSalary: false },
      },
      0,
    );

    // The chip says "Not disclosed" while the payload carries a number. Copying
    // the chip into `salaryRaw` would print a contradiction in the export.
    expect(job?.salaryMin).toBe(500_000);
    expect(job?.salaryRaw).toBeUndefined();
  });

  it('reads remote out of the title as well as the location', () => {
    expect(
      naukriAdapter.toRawJob({ ...tcs!, title: 'Backend Engineer (Remote)' }, 0)?.isRemote,
    ).toBe(true);
    expect(
      naukriAdapter.toRawJob(
        { ...tcs!, placeholders: [{ type: 'location', label: 'Work From Home' }] },
        0,
      )?.isRemote,
    ).toBe(true);
  });

  it('falls back to a link it can build when the payload has none', () => {
    const job = naukriAdapter.toRawJob({ jobId: '42', title: 'Dev', companyName: 'Acme' }, 0);

    // A lead with no link is not a lead. Naukri's id-only URL resolves.
    expect(job?.sourceUrl).toBe(`${ORIGIN}/job-listings-42`);
  });

  it('refuses a posting it cannot identify', () => {
    expect(naukriAdapter.toRawJob({ ...infosys!, jobId: undefined }, 0)).toBeNull();
    expect(naukriAdapter.toRawJob({ ...infosys!, title: '   ' }, 0)).toBeNull();
    expect(naukriAdapter.toRawJob({ ...infosys!, companyName: '' }, 0)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Detail                                                                     */
/* -------------------------------------------------------------------------- */

describe('fetchDetail', () => {
  /** A lead for the posting `naukri-detail.json` was captured from. */
  function lead(overrides: Partial<RawJob> = {}): RawJob {
    return {
      ...naukriAdapter.toRawJob(
        { jobId: DETAIL_ID, title: 'Full Stack Developer', companyName: 'Capgemini' },
        0,
      )!,
      ...overrides,
    };
  }

  function detailSession(json: unknown = detailPayload) {
    const session = fakeSession({
      navigate: { 'job-listings-': { status: 200, body: '<html><body>JD</body></html>' } },
      xhr: { [`${ORIGIN}/jobapi/v4/job/${DETAIL_ID}`]: { status: 200, json } },
    });
    return { session, ctx: scrapeContext(session) };
  }

  it("completes a truncated description from the posting's own page", async () => {
    const { ctx } = detailSession();

    const detailed = await naukriAdapter.fetchDetail!(lead(), ctx);

    expect(detailed.description).toContain('Job Description - Grade Specific');
    // 912 characters of text, well past the 400-character floor — which is what
    // earns this lead the right to score above 80%.
    expect(detailed.hasFullDescription).toBe(true);
    expect(detailed.employmentType).toBe('fulltime');
  });

  it("appends Naukri's own skill tags where the extractor already looks", async () => {
    const { ctx } = detailSession();

    const detailed = await naukriAdapter.fetchDetail!(lead(), ctx);

    // An employer-curated list, often naming a framework the prose only alludes
    // to. Appending it beats adding a parallel signal path that one source uses.
    expect(detailed.description).toContain(
      'Key skills: Full Stack Developer, Software Development, Programming, Software Design',
    );
  });

  it('does not spend a navigation on a posting it already read', async () => {
    const { session, ctx } = detailSession();
    const complete = lead({ hasFullDescription: true });

    expect(await naukriAdapter.fetchDetail!(complete, ctx)).toBe(complete);

    // The detail call is a real page load — three seconds and a browser tab.
    // The extra fields it would bring back are not worth that when the
    // description they accompany is one we already have in full.
    expect(session.navigations).toHaveLength(0);
  });

  it('leaves an on-site posting on-site', async () => {
    const { ctx } = detailSession();

    const detailed = await naukriAdapter.fetchDetail!(lead(), ctx);

    // `wfhType: "0"` is Naukri's "no". The flag is only ever used to turn remote
    // *on*, so a posting the list already read as remote is never un-flagged by
    // a field that is frequently just unset.
    expect(detailed.isRemote).toBe(false);
  });

  it('turns remote on when the detail payload says so', async () => {
    const { ctx } = detailSession({
      jobDetails: { ...detailPayload.jobDetails, wfhType: '2' },
    });

    expect((await naukriAdapter.fetchDetail!(lead(), ctx)).isRemote).toBe(true);
  });

  it('does not record an empty company website as a website', async () => {
    const { ctx } = detailSession();

    // Capgemini's captured record has `websiteUrl: ""`. Writing that through
    // would render an empty link in the drawer where "Not yet verified" belongs.
    expect(await naukriAdapter.fetchDetail!(lead(), ctx)).not.toHaveProperty('companyWebsite');
  });

  it('records a company website when the payload actually has one', async () => {
    const { ctx } = detailSession({
      jobDetails: {
        ...detailPayload.jobDetails,
        companyDetail: { websiteUrl: ' https://capgemini.com ' },
      },
    });

    expect((await naukriAdapter.fetchDetail!(lead(), ctx)).companyWebsite).toBe(
      'https://capgemini.com',
    );
  });

  it('keeps the lead as it was when the detail page has nothing to add', async () => {
    const original = lead();

    // Both shapes a detail navigation can disappoint with: no payload at all,
    // and a payload whose description is as thin as the one we already had.
    // Neither may promote the lead to "fully read" — that claim is what lets a
    // posting clear 85%.
    expect(await naukriAdapter.fetchDetail!(original, detailSession({}).ctx)).toEqual(original);
    expect(
      await naukriAdapter.fetchDetail!(
        original,
        detailSession({ jobDetails: { description: '<p>Hi</p>' } }).ctx,
      ),
    ).toEqual(original);
  });

  it('does not navigate for a run that has been cancelled', async () => {
    const { session, ctx } = detailSession();
    const cancelled = { ...ctx, signal: AbortSignal.abort() };

    const original = lead();
    expect(await naukriAdapter.fetchDetail!(original, cancelled)).toBe(original);
    expect(session.navigations).toHaveLength(0);
  });
});
