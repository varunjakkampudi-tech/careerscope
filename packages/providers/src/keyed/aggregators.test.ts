/**
 * The keyed-aggregator family: the loop, and the three adapters on top of it.
 *
 * The mapping fixtures here are honest about their provenance, because it
 * differs by adapter and that difference matters. Adzuna's shape is taken from
 * the Swagger document its API still serves, so those fixtures are as
 * authoritative as the ATS ones. **Jooble's and JSearch's are not** — both
 * endpoints refuse an unauthenticated caller, so their payloads are modelled
 * from published documentation rather than captured from the wire.
 *
 * That is worth stating rather than hiding, because it changes what these tests
 * prove. They prove the adapters do the right thing with the shape they expect,
 * and — the part that actually earns its keep — that they *degrade* rather than
 * crash when the shape is wrong. The drift test below is the one that will
 * matter if JSearch has renamed a field since its docs were written.
 *
 * A note on the target titles used throughout: they all end in "Engineer"
 * because `titleAllowed` is a real gate inside this loop, not a formality.
 * Single-letter placeholders tokenize to nothing and would silently reject every
 * fixture job — and a suite that passes because everything was filtered out
 * proves nothing at all.
 */

import { describe, expect, it } from 'vitest';
import { collect, context, query, routedFetch } from '../harness.fixtures.js';
import type { FetchLike } from '../http.js';
import { adzunaAdapter, createAdzunaProvider, type AdzunaJob } from './adzuna.js';
import {
  createKeyedProvider,
  MAX_KEYWORDS,
  MAX_PAGES_PER_KEYWORD,
  MAX_REQUESTS,
  type KeyedAdapter,
  type KeyedPage,
} from './base.js';
import { createJoobleProvider, joobleAdapter, type JoobleJob } from './jooble.js';
import { createJSearchProvider, jsearchAdapter, type JSearchJob } from './jsearch.js';

const NOW = Date.parse('2026-09-05T12:00:00Z');
const HOUR_AGO = new Date(NOW - 3_600_000).toISOString();

/** Every target shares the "engineer" token, so one fixture title fits them all. */
const TITLES = [
  'Backend Engineer',
  'Platform Engineer',
  'Data Engineer',
  'Mobile Engineer',
  'Security Engineer',
  'Payments Engineer',
];

/* -------------------------------------------------------------------------- */
/* The loop                                                                   */
/* -------------------------------------------------------------------------- */

/** Records every call, so fan-out, dedupe and the request budget are all visible. */
function fakeAdapter(
  overrides: Partial<KeyedAdapter<string>> = {},
): KeyedAdapter<string> & { requests: { keyword: string; page: number }[] } {
  const requests: { keyword: string; page: number }[] = [];
  return {
    requests,
    id: 'adzuna',
    label: 'Fake',
    requiredCredentials: ['FAKE_KEY'],
    async fetchPage(request): Promise<KeyedPage<string>> {
      requests.push({ keyword: request.keyword, page: request.page });
      return { items: [`${request.keyword}#${request.page}`], hasMore: true };
    },
    toRawJob: (item) => ({
      source: 'adzuna',
      sourceJobId: item,
      title: 'Backend Engineer',
      companyName: 'Acme',
      hasFullDescription: true,
      postedAt: HOUR_AGO,
      sourceUrl: `https://adzuna.com/${item}`,
    }),
    ...overrides,
  };
}

const KEYED = { credentials: { FAKE_KEY: 'x' }, now: () => NOW };
const NO_ROUTES = routedFetch({}).impl;

describe('createKeyedProvider', () => {
  it('is unavailable, with a reason naming the variable, when the key is missing', async () => {
    const provider = createKeyedProvider(fakeAdapter(), { credentials: {} });

    expect(provider.unavailableReason).toBe('Fake needs an API key. Set FAKE_KEY to enable it.');
    // Unavailable means silent, not throwing: the orchestrator runs every
    // provider, and a missing key is a configuration state, not a failure.
    expect(await collect(provider.search(query(), context(NO_ROUTES)))).toEqual([]);
  });

  it('names every missing variable when a board needs more than one', () => {
    const adapter = fakeAdapter({ requiredCredentials: ['A_ID', 'A_KEY'] });

    const provider = createKeyedProvider(adapter, { credentials: {} });

    expect(provider.unavailableReason).toBe(
      'Fake needs API keys. Set A_ID and A_KEY to enable it.',
    );
  });

  it('treats a blank key as no key at all', () => {
    const provider = createKeyedProvider(fakeAdapter(), { credentials: { FAKE_KEY: '   ' } });

    expect(provider.unavailableReason).toContain('Set FAKE_KEY');
  });

  it('never puts a credential value in the reason', () => {
    // The reason is rendered verbatim on the settings screen.
    const secret = 'sk-live-9f3a2b';
    const adapter = fakeAdapter({ requiredCredentials: ['FAKE_KEY', 'OTHER_KEY'] });

    const provider = createKeyedProvider(adapter, { credentials: { FAKE_KEY: secret } });

    expect(provider.unavailableReason).not.toContain(secret);
    expect(provider.unavailableReason).toContain('OTHER_KEY');
  });

  it('searches each target title separately rather than as one merged query', async () => {
    const adapter = fakeAdapter();
    const provider = createKeyedProvider(adapter, KEYED);

    await collect(
      provider.search(
        query({ titles: ['Backend Engineer', 'Platform Engineer'], maxResults: 4 }),
        context(NO_ROUTES),
      ),
    );

    // Two searches, not one for "Backend Engineer Platform Engineer" — a text
    // search on the concatenation matches almost nothing.
    const keywords = adapter.requests.map((request) => request.keyword);
    expect(keywords).toContain('Backend Engineer');
    expect(keywords).toContain('Platform Engineer');
  });

  it('searches unrestricted when the user has named no titles', async () => {
    const adapter = fakeAdapter();
    const provider = createKeyedProvider(adapter, KEYED);

    await collect(provider.search(query({ maxResults: 1 }), context(NO_ROUTES)));

    // An empty preference is "no opinion", not "nothing".
    expect(adapter.requests[0]?.keyword).toBe('');
  });

  it('caps the number of titles and says which it dropped', async () => {
    const adapter = fakeAdapter();
    const provider = createKeyedProvider(adapter, KEYED);
    const ctx = context(NO_ROUTES);

    await collect(provider.search(query({ titles: TITLES, maxResults: 500 }), ctx));

    const notice = ctx.events.find((event) => event.message.includes('target titles'));
    expect(notice?.level).toBe('info');
    expect(notice?.message).toContain(`first ${MAX_KEYWORDS} of 6`);
    // The dropped ones are named. "Some titles were skipped" would leave the
    // user unable to tell which of their searches actually ran.
    expect(notice?.message).toContain('Security Engineer, Payments Engineer');
    expect(new Set(adapter.requests.map((request) => request.keyword)).size).toBe(MAX_KEYWORDS);
  });

  it('stops at the request budget and says that is why', async () => {
    const adapter = fakeAdapter();
    const provider = createKeyedProvider(adapter, KEYED);
    const ctx = context(NO_ROUTES);

    // Four titles × three pages would be twelve requests; the budget is ten.
    await collect(provider.search(query({ titles: TITLES.slice(0, 4), maxResults: 500 }), ctx));

    expect(adapter.requests).toHaveLength(MAX_REQUESTS);
    const capped = ctx.events.find((event) => event.message.includes('budget'));
    expect(capped?.level).toBe('info');
    // The distinction the user needs: we ran out of budget, not out of jobs.
    expect(capped?.message).toContain('not the end');
  });

  it('walks no deeper than the per-keyword page limit', async () => {
    const adapter = fakeAdapter();
    const provider = createKeyedProvider(adapter, KEYED);

    await collect(
      provider.search(query({ titles: ['Backend Engineer'], maxResults: 500 }), context(NO_ROUTES)),
    );

    // Breadth over depth: page 4 of a text search is thin.
    expect(adapter.requests).toHaveLength(MAX_PAGES_PER_KEYWORD);
    expect(adapter.requests.map((request) => request.page)).toEqual([1, 2, 3]);
  });

  it('stops walking a keyword when the board says there is no more', async () => {
    const adapter = fakeAdapter({
      async fetchPage(request) {
        return { items: [`${request.keyword}#${request.page}`], hasMore: false };
      },
    });
    const provider = createKeyedProvider(adapter, KEYED);

    const jobs = await collect(
      provider.search(
        query({ titles: ['Backend Engineer', 'Platform Engineer'], maxResults: 500 }),
        context(NO_ROUTES),
      ),
    );

    expect(jobs.map((job) => job.sourceJobId).sort()).toEqual([
      'Backend Engineer#1',
      'Platform Engineer#1',
    ]);
  });

  it('yields a posting once even when several searches return it', async () => {
    // Every search returns the same job — which is exactly what overlapping
    // titles do on a board that matches on text.
    const adapter = fakeAdapter({
      async fetchPage() {
        return { items: ['shared-job'], hasMore: false };
      },
    });
    const provider = createKeyedProvider(adapter, KEYED);

    const jobs = await collect(
      provider.search(query({ titles: TITLES.slice(0, 3), maxResults: 500 }), context(NO_ROUTES)),
    );

    expect(jobs).toHaveLength(1);
  });

  it('keeps going to the next title when one search fails', async () => {
    const adapter = fakeAdapter({
      async fetchPage(request) {
        if (request.keyword === 'Backend Engineer') throw new Error('rate limited');
        return { items: [`${request.keyword}#${request.page}`], hasMore: false };
      },
    });
    const provider = createKeyedProvider(adapter, KEYED);
    const ctx = context(NO_ROUTES);

    const jobs = await collect(
      provider.search(query({ titles: ['Backend Engineer', 'Platform Engineer'] }), ctx),
    );

    // One dead search must not cost the user the other one.
    expect(jobs.map((job) => job.sourceJobId)).toEqual(['Platform Engineer#1']);
    const warning = ctx.events.find((event) => event.level === 'warn');
    expect(warning?.message).toContain('"Backend Engineer" page 1');
    expect(warning?.message).toContain('rate limited');
  });

  it('drops one unreadable posting and keeps the rest of the page', async () => {
    const adapter = fakeAdapter({
      async fetchPage() {
        return { items: ['good-1', 'poison', 'good-2'], hasMore: false };
      },
      toRawJob(item) {
        if (item === 'poison') throw new TypeError('cannot read properties of null');
        return {
          source: 'adzuna',
          sourceJobId: item,
          title: 'Backend Engineer',
          companyName: 'Acme',
          hasFullDescription: true,
          postedAt: HOUR_AGO,
          sourceUrl: `https://adzuna.com/${item}`,
        };
      },
    });
    const provider = createKeyedProvider(adapter, KEYED);
    const ctx = context(NO_ROUTES);

    const jobs = await collect(provider.search(query({ titles: ['Backend Engineer'] }), ctx));

    expect(jobs.map((job) => job.sourceJobId).sort()).toEqual(['good-1', 'good-2']);
    expect(ctx.events.some((event) => event.message.includes('unreadable'))).toBe(true);
  });

  it('ends quietly when the run is cancelled', async () => {
    const controller = new AbortController();
    let pages = 0;
    const adapter = fakeAdapter({
      async fetchPage(request) {
        pages += 1;
        controller.abort();
        return { items: [`${request.keyword}#${request.page}`], hasMore: true };
      },
    });
    const provider = createKeyedProvider(adapter, KEYED);
    const ctx = { ...context(NO_ROUTES), signal: controller.signal };

    const jobs = await collect(
      provider.search(query({ titles: ['Backend Engineer', 'Platform Engineer'] }), ctx),
    );

    // The page already fetched is still handed over — it was paid for. What
    // must not happen is a second request after the cancel.
    expect(jobs).toHaveLength(1);
    expect(pages).toBe(1);
  });

  it('never yields more than maxResults', async () => {
    const adapter = fakeAdapter({
      async fetchPage(request) {
        return {
          items: [1, 2, 3, 4, 5].map((n) => `${request.keyword}#${request.page}#${n}`),
          hasMore: true,
        };
      },
    });
    const provider = createKeyedProvider(adapter, KEYED);

    const jobs = await collect(
      provider.search(
        query({ titles: ['Backend Engineer', 'Platform Engineer'], maxResults: 7 }),
        context(NO_ROUTES),
      ),
    );

    expect(jobs).toHaveLength(7);
  });

  it('sends no location when the search is remote-only', async () => {
    let seen: string | undefined = 'unset';
    const adapter = fakeAdapter({
      async fetchPage(request) {
        seen = request.location;
        return { items: [], hasMore: false };
      },
    });
    const provider = createKeyedProvider(adapter, KEYED);

    await collect(
      provider.search(
        query({ titles: ['Backend Engineer'], locations: ['Bangalore'], remoteOnly: true }),
        context(NO_ROUTES),
      ),
    );

    // Asking a board for "remote jobs in Bangalore" is how a remote search
    // comes back empty.
    expect(seen).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Adzuna                                                                     */
/* -------------------------------------------------------------------------- */

/** Trimmed from the `Job` model in Adzuna's own Swagger document. */
const ADZUNA_JOB: AdzunaJob = {
  id: '5310442891',
  title: 'Senior Backend Engineer',
  description: 'We are looking for a Senior Backend Engineer to join our platform team. You will…',
  full_description:
    'We are looking for a Senior Backend Engineer to join our platform team.\n\n' +
    'Requirements:\n- 6+ years with Python and Django\n- PostgreSQL at scale\n- AWS',
  created: '2026-09-04T09:12:33Z',
  redirect_url: 'https://www.adzuna.in/land/ad/5310442891',
  company: { display_name: 'Razorpay', canonical_name: 'razorpay' },
  location: { display_name: 'Bengaluru, Karnataka', area: ['India', 'Karnataka', 'Bengaluru'] },
  category: { label: 'IT Jobs', tag: 'it-jobs' },
  salary_min: 2_400_000,
  salary_max: 3_600_000,
  salary_is_predicted: '0',
  contract_time: 'full_time',
};

const ADZUNA_CREDS = {
  credentials: { ADZUNA_APP_ID: 'app-id', ADZUNA_APP_KEY: 'app-key' },
  now: () => NOW,
};

describe('adzuna', () => {
  it('prefers the full description and marks it as full', () => {
    const job = adzunaAdapter.toRawJob(ADZUNA_JOB, NOW);

    expect(job?.description).toContain('6+ years with Python');
    expect(job?.hasFullDescription).toBe(true);
  });

  it('falls back to the snippet and marks the listing thin', () => {
    const job = adzunaAdapter.toRawJob({ ...ADZUNA_JOB, full_description: undefined }, NOW);

    expect(job?.description).toContain('join our platform team');
    // The flag that caps this lead at 80% — below the 85% default — because
    // nobody has actually read the posting.
    expect(job?.hasFullDescription).toBe(false);
  });

  it('maps the fields the leads table renders', () => {
    const job = adzunaAdapter.toRawJob(ADZUNA_JOB, NOW);

    expect(job).toMatchObject({
      source: 'adzuna',
      sourceJobId: '5310442891',
      title: 'Senior Backend Engineer',
      companyName: 'Razorpay',
      location: 'Bengaluru, Karnataka',
      employmentType: 'fulltime',
      postedAt: '2026-09-04T09:12:33.000Z',
      applyUrl: 'https://www.adzuna.in/land/ad/5310442891',
    });
  });

  it('keeps a salary the employer stated', () => {
    const job = adzunaAdapter.toRawJob(ADZUNA_JOB, NOW);

    expect(job).toMatchObject({
      salaryMin: 2_400_000,
      salaryMax: 3_600_000,
      salaryCurrency: 'INR',
      salaryPeriod: 'year',
    });
  });

  it('discards a salary Adzuna modelled rather than read', () => {
    // The whole reason that branch exists. Adzuna publishes its own estimate in
    // the same fields as a real figure; showing it as the employer's package
    // would put an invented number next to a named company.
    const job = adzunaAdapter.toRawJob({ ...ADZUNA_JOB, salary_is_predicted: '1' }, NOW);

    expect(job?.salaryMin).toBeUndefined();
    expect(job?.salaryMax).toBeUndefined();
    expect(job?.salaryCurrency).toBeUndefined();
  });

  it('reads the predicted flag in each spelling Adzuna has used', () => {
    for (const flag of [true, 1, '1', 'true'] as const) {
      expect(
        adzunaAdapter.toRawJob({ ...ADZUNA_JOB, salary_is_predicted: flag }, NOW)?.salaryMin,
      ).toBeUndefined();
    }
    for (const flag of [false, 0, '0', 'false', ''] as const) {
      expect(
        adzunaAdapter.toRawJob({ ...ADZUNA_JOB, salary_is_predicted: flag }, NOW)?.salaryMin,
      ).toBe(2_400_000);
    }
  });

  it('falls back to adref when there is no id', () => {
    const job = adzunaAdapter.toRawJob({ ...ADZUNA_JOB, id: undefined, adref: 'eyJhbGciOi' }, NOW);

    expect(job?.sourceJobId).toBe('eyJhbGciOi');
  });

  it('returns null without a title or a link', () => {
    expect(adzunaAdapter.toRawJob({ ...ADZUNA_JOB, title: undefined }, NOW)).toBeNull();
    expect(adzunaAdapter.toRawJob({ ...ADZUNA_JOB, redirect_url: undefined }, NOW)).toBeNull();
  });

  it('pushes the search window to the API instead of filtering afterwards', async () => {
    const { impl, calls } = routedFetch({
      'api.adzuna.com': { count: 1, results: [ADZUNA_JOB], mean: 2_900_000 },
    });
    const provider = createAdzunaProvider(ADZUNA_CREDS);

    const jobs = await collect(
      provider.search(
        query({
          titles: ['Backend Engineer'],
          locations: ['Bengaluru'],
          postedWithinDays: 7,
          maxResults: 5,
        }),
        context(impl),
      ),
    );

    expect(jobs).toHaveLength(1);
    const url = calls[0] ?? '';
    expect(url).toContain('/jobs/in/search/1');
    // On a metered endpoint, filtering locally means paying for rows that were
    // never eligible in the first place.
    expect(url).toContain('max_days_old=7');
    expect(url).toContain('what=Backend+Engineer');
    expect(url).toContain('where=Bengaluru');
    expect(url).toContain('sort_by=date');
  });

  it('sends exclusions as what_exclude so they are never billed for', async () => {
    const { impl, calls } = routedFetch({ 'api.adzuna.com': { count: 0, results: [] } });
    const provider = createAdzunaProvider(ADZUNA_CREDS);

    await collect(
      provider.search(
        query({ titles: ['Backend Engineer'], excludeKeywords: ['sales', 'intern'] }),
        context(impl),
      ),
    );

    expect(calls[0]).toContain('what_exclude=sales+intern');
  });

  it('stops when the reported total is exhausted rather than probing further', async () => {
    const { impl, calls } = routedFetch({ 'api.adzuna.com': { count: 1, results: [ADZUNA_JOB] } });
    const provider = createAdzunaProvider(ADZUNA_CREDS);

    await collect(
      provider.search(query({ titles: ['Backend Engineer'], maxResults: 100 }), context(impl)),
    );

    // count=1 is less than one page, so page 2 would be a wasted metered call.
    expect(calls).toHaveLength(1);
  });

  it('surfaces an auth failure in Adzuna’s own words', async () => {
    const { impl } = routedFetch({
      'api.adzuna.com': {
        exception: 'AUTH_FAIL',
        display: 'Authorisation failed',
        doc: 'https://developer.adzuna.com/',
      },
    });
    const provider = createAdzunaProvider(ADZUNA_CREDS);
    const ctx = context(impl);

    // Adzuna reports this as a 200 with an `exception` key, so without the
    // explicit check it would read as a board with no jobs.
    const jobs = await collect(provider.search(query({ titles: ['Backend Engineer'] }), ctx));

    expect(jobs).toEqual([]);
    expect(ctx.events.find((event) => event.level === 'warn')?.message).toContain(
      'Authorisation failed',
    );
  });

  it('never puts the app key in a log line', async () => {
    const { impl } = routedFetch({ 'api.adzuna.com': { exception: 'AUTH_FAIL', display: 'Nope' } });
    const provider = createAdzunaProvider({
      credentials: { ADZUNA_APP_ID: 'id-1', ADZUNA_APP_KEY: 'super-secret' },
      now: () => NOW,
    });
    const ctx = context(impl);

    await collect(provider.search(query({ titles: ['Backend Engineer'] }), ctx));

    expect(ctx.events.map((event) => event.message).join(' ')).not.toContain('super-secret');
  });
});

/* -------------------------------------------------------------------------- */
/* JSearch                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Modelled from JSearch's published documentation, not captured from the wire —
 * its endpoint refuses an unsubscribed caller, so no real payload was available.
 */
const JSEARCH_JOB: JSearchJob = {
  job_id: 'k7Hs2Lm9QpX',
  job_title: 'Senior Software Engineer, Backend',
  employer_name: 'Swiggy',
  employer_website: 'https://www.swiggy.com',
  job_publisher: 'LinkedIn',
  job_employment_type: 'FULLTIME',
  job_is_remote: false,
  job_apply_link: 'https://www.linkedin.com/jobs/view/4021',
  job_apply_is_direct: false,
  apply_options: [
    {
      publisher: 'LinkedIn',
      apply_link: 'https://www.linkedin.com/jobs/view/4021',
      is_direct: false,
    },
    { publisher: 'Swiggy', apply_link: 'https://careers.swiggy.com/jobs/4021', is_direct: true },
  ],
  job_description:
    'Swiggy is hiring a Senior Software Engineer for the backend platform team.\n\n' +
    'What you will do:\n- Design and operate distributed services in Java and Go\n' +
    '- Own reliability for high-throughput order pipelines\n\n' +
    'What we are looking for:\n- 5+ years of backend experience\n- Strong Kafka and PostgreSQL',
  job_city: 'Bengaluru',
  job_state: 'Karnataka',
  job_country: 'IN',
  job_posted_at_datetime_utc: '2026-09-03T06:30:00.000Z',
  job_posted_at_timestamp: Math.floor(Date.parse('2026-09-03T06:30:00.000Z') / 1000),
  job_min_salary: 3_000_000,
  job_max_salary: 4_500_000,
  job_salary_currency: 'INR',
  job_salary_period: 'YEAR',
};

const JSEARCH_CREDS = { credentials: { RAPIDAPI_KEY: 'rapid-key' }, now: () => NOW };

describe('jsearch', () => {
  it('records which board the posting actually came from', () => {
    const job = jsearchAdapter.toRawJob(JSEARCH_JOB, NOW);

    // The user asked for LinkedIn and Indeed. This is how a lead says it came
    // from one, without the app pretending it crawled the site itself.
    expect(job?.sourcePublisher).toBe('LinkedIn');
    expect(job?.source).toBe('jsearch');
  });

  it('prefers the employer’s own apply link over the aggregator’s', () => {
    const job = jsearchAdapter.toRawJob(JSEARCH_JOB, NOW);

    // A direct link outlives a board redirect and lands on the real ATS.
    expect(job?.applyUrl).toBe('https://careers.swiggy.com/jobs/4021');
  });

  it('falls back to the listed link when none is direct', () => {
    const job = jsearchAdapter.toRawJob(
      {
        ...JSEARCH_JOB,
        apply_options: [{ apply_link: 'https://indeed.com/v/9', is_direct: false }],
      },
      NOW,
    );

    expect(job?.applyUrl).toBe('https://www.linkedin.com/jobs/view/4021');
  });

  it('returns null when there is no link at all', () => {
    const job = jsearchAdapter.toRawJob(
      { ...JSEARCH_JOB, job_apply_link: undefined, apply_options: undefined },
      NOW,
    );

    // A lead the user cannot open is not a lead.
    expect(job).toBeNull();
  });

  it('maps the rest of the leads-table fields', () => {
    const job = jsearchAdapter.toRawJob(JSEARCH_JOB, NOW);

    expect(job).toMatchObject({
      sourceJobId: 'k7Hs2Lm9QpX',
      title: 'Senior Software Engineer, Backend',
      companyName: 'Swiggy',
      companyWebsite: 'https://www.swiggy.com',
      location: 'Bengaluru, Karnataka, IN',
      employmentType: 'fulltime',
      salaryMin: 3_000_000,
      salaryMax: 4_500_000,
      salaryCurrency: 'INR',
      salaryPeriod: 'year',
      hasFullDescription: true,
    });
  });

  it('reads a pre-joined location from the newer payload shape', () => {
    const job = jsearchAdapter.toRawJob(
      {
        ...JSEARCH_JOB,
        job_city: undefined,
        job_state: undefined,
        job_country: undefined,
        job_location: 'Bengaluru, India',
      },
      NOW,
    );

    expect(job?.location).toBe('Bengaluru, India');
  });

  it('reads a nested salary from the newer payload shape', () => {
    const job = jsearchAdapter.toRawJob(
      {
        ...JSEARCH_JOB,
        job_min_salary: undefined,
        job_max_salary: undefined,
        job_salary_currency: undefined,
        job_salary_period: undefined,
        job_salary: { min: 1_800_000, max: 2_200_000, currency: 'inr', period: 'YEAR' },
      },
      NOW,
    );

    expect(job).toMatchObject({
      salaryMin: 1_800_000,
      salaryMax: 2_200_000,
      salaryCurrency: 'INR',
    });
  });

  it('marks a short description as not a full one', () => {
    const job = jsearchAdapter.toRawJob(
      { ...JSEARCH_JOB, job_description: 'Backend engineer wanted. Apply within.' },
      NOW,
    );

    expect(job?.hasFullDescription).toBe(false);
  });

  it('falls back to the epoch timestamp when the ISO field is absent', () => {
    const job = jsearchAdapter.toRawJob(
      { ...JSEARCH_JOB, job_posted_at_datetime_utc: undefined },
      NOW,
    );

    expect(job?.postedAt).toBe('2026-09-03T06:30:00.000Z');
  });

  it('leaves the date unset rather than inventing one from "3 days ago"', () => {
    const job = jsearchAdapter.toRawJob(
      {
        ...JSEARCH_JOB,
        job_posted_at_datetime_utc: undefined,
        job_posted_at_timestamp: undefined,
        job_posted_at: '3 days ago',
      },
      NOW,
    );

    // Converting that would mean choosing an hour at random, and the recency
    // dimension would then score a freshness nobody reported.
    expect(job?.postedAt).toBeUndefined();
  });

  it('sends the RapidAPI headers and one page per request', async () => {
    const calls: string[] = [];
    const headers: Record<string, string> = {};
    const impl: FetchLike = async (url, init) => {
      calls.push(url);
      Object.assign(headers, init.headers as Record<string, string>);
      return new Response(JSON.stringify({ status: 'OK', data: [JSEARCH_JOB] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await collect(
      createJSearchProvider(JSEARCH_CREDS).search(
        query({
          titles: ['Backend Engineer'],
          locations: ['Bengaluru'],
          postedWithinDays: 7,
          maxResults: 1,
        }),
        context(impl),
      ),
    );

    expect(headers['x-rapidapi-key']).toBe('rapid-key');
    expect(headers['x-rapidapi-host']).toBe('jsearch.p.rapidapi.com');
    expect(calls[0]).toContain('query=Backend+Engineer+in+Bengaluru');
    // num_pages > 1 makes JSearch fan out internally and bill for each one.
    expect(calls[0]).toContain('num_pages=1');
    expect(calls[0]).toContain('date_posted=week');
  });

  it('maps the search window onto the narrowest bucket that still contains it', async () => {
    const windows: [number, string][] = [
      [1, 'today'],
      [3, '3days'],
      [7, 'week'],
      [30, 'month'],
      [90, 'month'],
    ];

    for (const [days, expected] of windows) {
      const { impl, calls } = routedFetch({ 'jsearch.p.rapidapi.com': { status: 'OK', data: [] } });

      await collect(
        createJSearchProvider(JSEARCH_CREDS).search(
          query({ titles: ['Backend Engineer'], postedWithinDays: days }),
          context(impl),
        ),
      );

      expect(calls[0]).toContain(`date_posted=${expected}`);
    }
  });

  it('drops the employment filter when a requested type has no equivalent', async () => {
    const { impl, calls } = routedFetch({ 'jsearch.p.rapidapi.com': { status: 'OK', data: [] } });

    await collect(
      createJSearchProvider(JSEARCH_CREDS).search(
        // JSearch has no "temporary". Sending a partial list would ask the API
        // to exclude jobs the user explicitly asked for.
        query({ titles: ['Backend Engineer'], employmentTypes: ['fulltime', 'temporary'] }),
        context(impl),
      ),
    );

    expect(calls[0]).not.toContain('employment_types');
  });

  it('sends the employment filter when every requested type maps', async () => {
    const { impl, calls } = routedFetch({ 'jsearch.p.rapidapi.com': { status: 'OK', data: [] } });

    await collect(
      createJSearchProvider(JSEARCH_CREDS).search(
        query({ titles: ['Backend Engineer'], employmentTypes: ['fulltime', 'contract'] }),
        context(impl),
      ),
    );

    expect(calls[0]).toContain('employment_types=FULLTIME%2CCONTRACTOR');
  });

  it('reports a subscription problem in RapidAPI’s own words', async () => {
    const { impl } = routedFetch({
      'jsearch.p.rapidapi.com': { message: 'You are not subscribed to this API.' },
    });
    const ctx = context(impl);

    const jobs = await collect(
      createJSearchProvider(JSEARCH_CREDS).search(query({ titles: ['Backend Engineer'] }), ctx),
    );

    expect(jobs).toEqual([]);
    expect(ctx.events.find((event) => event.level === 'warn')?.message).toContain('not subscribed');
  });

  it('announces a schema change instead of looking like an empty board', async () => {
    // The test that earns its keep. These field names could not be verified
    // against a reachable source, so the failure mode that matters is a rename
    // — which returns results that map to nothing and would otherwise be
    // indistinguishable from a board with no matching jobs.
    const { impl } = routedFetch({
      'jsearch.p.rapidapi.com': {
        status: 'OK',
        data: [{ jobId: 'abc', jobTitle: 'Backend Engineer', employerName: 'Acme' }],
      },
    });
    const ctx = context(impl);

    const jobs = await collect(
      createJSearchProvider(JSEARCH_CREDS).search(query({ titles: ['Backend Engineer'] }), ctx),
    );

    expect(jobs).toEqual([]);
    const drift = ctx.events.find((event) => event.message.includes('schema'));
    expect(drift?.level).toBe('warn');
    // Naming the keys it did see turns a silent failure into a five-minute fix.
    expect(drift?.message).toContain('jobId, jobTitle, employerName');
  });

  it('does not cry drift when only some postings are unmappable', async () => {
    const { impl } = routedFetch({
      'jsearch.p.rapidapi.com': { status: 'OK', data: [{ junk: true }, JSEARCH_JOB] },
    });
    const ctx = context(impl);

    const jobs = await collect(
      createJSearchProvider(JSEARCH_CREDS).search(query({ titles: ['Backend Engineer'] }), ctx),
    );

    expect(jobs).toHaveLength(1);
    expect(ctx.events.some((event) => event.message.includes('schema'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Jooble                                                                     */
/* -------------------------------------------------------------------------- */

/** Modelled from Jooble's documentation; its host refused an unauthenticated probe. */
const JOOBLE_JOB: JoobleJob = {
  id: 8_812_004_119,
  title: 'Backend Engineer (Python)',
  company: 'Zeta Suite',
  location: 'Bengaluru',
  snippet: 'Looking for a <b>Backend Engineer</b> with Python and PostgreSQL experience...',
  salary: '₹18,00,000 - ₹26,00,000 per year',
  type: 'Full-time',
  source: 'naukri.com',
  link: 'https://in.jooble.org/jdp/8812004119',
  updated: '2026-09-04T11:00:00Z',
};

const JOOBLE_CREDS = { credentials: { JOOBLE_API_KEY: 'jooble-key' }, now: () => NOW };

describe('jooble', () => {
  it('always reports a thin listing, because a snippet is all there is', () => {
    const job = joobleAdapter.toRawJob(JOOBLE_JOB, NOW);

    // This caps every Jooble lead at 80%, below the 85% default — correctly.
    // Jooble's job is discovery, not matching.
    expect(job?.hasFullDescription).toBe(false);
  });

  it('routes the snippet through the HTML path so the highlight tags come out', () => {
    const job = joobleAdapter.toRawJob(JOOBLE_JOB, NOW);

    expect(job?.descriptionIsHtml).toBe(true);
    expect(job?.description).toContain('<b>');
  });

  it('keeps the salary as text for the shared parser rather than parsing it here', () => {
    const job = joobleAdapter.toRawJob(JOOBLE_JOB, NOW);

    // `normalizeSalary` already handles lakh notation; a second parser here is
    // how the two would drift apart.
    expect(job?.salaryRaw).toBe('₹18,00,000 - ₹26,00,000 per year');
    expect(job?.salaryMin).toBeUndefined();
  });

  it('records the board Jooble indexed', () => {
    expect(joobleAdapter.toRawJob(JOOBLE_JOB, NOW)?.sourcePublisher).toBe('naukri.com');
  });

  it('maps the remaining fields and coerces a numeric id', () => {
    expect(joobleAdapter.toRawJob(JOOBLE_JOB, NOW)).toMatchObject({
      source: 'jooble',
      sourceJobId: '8812004119',
      title: 'Backend Engineer (Python)',
      companyName: 'Zeta Suite',
      location: 'Bengaluru',
      employmentType: 'fulltime',
      postedAt: '2026-09-04T11:00:00.000Z',
      applyUrl: 'https://in.jooble.org/jdp/8812004119',
    });
  });

  it('returns null without an id, title or link', () => {
    expect(joobleAdapter.toRawJob({ ...JOOBLE_JOB, id: undefined }, NOW)).toBeNull();
    expect(joobleAdapter.toRawJob({ ...JOOBLE_JOB, title: undefined }, NOW)).toBeNull();
    expect(joobleAdapter.toRawJob({ ...JOOBLE_JOB, link: undefined }, NOW)).toBeNull();
  });

  it('posts the key in the path and the query in the body', async () => {
    let seenUrl = '';
    let body: unknown;
    const impl: FetchLike = async (url, init) => {
      seenUrl = url;
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ totalCount: 1, jobs: [JOOBLE_JOB] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    await collect(
      createJoobleProvider(JOOBLE_CREDS).search(
        query({
          titles: ['Backend Engineer'],
          locations: ['Bengaluru'],
          postedWithinDays: 7,
          maxResults: 1,
        }),
        context(impl),
      ),
    );

    expect(seenUrl).toBe('https://jooble.org/api/jooble-key');
    expect(body).toEqual({
      keywords: 'Backend Engineer',
      page: '1',
      location: 'Bengaluru',
      // Seven days before the injected clock, as a date rather than a count.
      datecreatedfrom: '2026-08-29',
    });
  });

  it('explains a bot check instead of failing on unparseable HTML', async () => {
    const { impl } = routedFetch({
      'jooble.org': () =>
        new Response('<!DOCTYPE html><title>Just a moment...</title>', {
          status: 403,
          headers: { 'content-type': 'text/html' },
        }),
    });
    const ctx = context(impl);

    const jobs = await collect(
      createJoobleProvider(JOOBLE_CREDS).search(query({ titles: ['Backend Engineer'] }), ctx),
    );

    expect(jobs).toEqual([]);
    const warning = ctx.events.find((event) => event.level === 'warn');
    // Without this the user would see a JSON parse error and go looking for a
    // bug in the app rather than a door closed by the host.
    expect(warning?.message).toContain('bot check');
    expect(warning?.message).toContain('valid one');
  });

  it('says plainly when the key was rejected', async () => {
    const { impl } = routedFetch({
      'jooble.org': () => new Response('{"error":"unauthorized"}', { status: 401 }),
    });
    const ctx = context(impl);

    await collect(
      createJoobleProvider(JOOBLE_CREDS).search(query({ titles: ['Backend Engineer'] }), ctx),
    );

    expect(ctx.events.find((event) => event.level === 'warn')?.message).toContain('JOOBLE_API_KEY');
  });

  it('never puts the key in a log line, even though it travels in the URL', async () => {
    const { impl } = routedFetch({ 'jooble.org': () => new Response('nope', { status: 500 }) });
    const ctx = context(impl);

    await collect(
      createJoobleProvider({
        credentials: { JOOBLE_API_KEY: 'secret-jooble-key' },
        now: () => NOW,
      }).search(query({ titles: ['Backend Engineer'] }), ctx),
    );

    expect(ctx.events.map((event) => event.message).join(' ')).not.toContain('secret-jooble-key');
  });

  it('stops paging once the reported total is covered', async () => {
    const { impl, calls } = routedFetch({ 'jooble.org': { totalCount: 2, jobs: [JOOBLE_JOB] } });

    await collect(
      createJoobleProvider(JOOBLE_CREDS).search(
        query({ titles: ['Backend Engineer'], maxResults: 100 }),
        context(impl),
      ),
    );

    expect(calls).toHaveLength(1);
  });
});
