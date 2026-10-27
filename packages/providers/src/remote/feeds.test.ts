/**
 * The remote-feed providers: the shared walk and the three adapters on top of it.
 *
 * As with the ATS suites, the fixtures are trimmed copies of payloads captured
 * from the live APIs — including the parts that are wrong at the source, like
 * RemoteOK's zero salaries and its double-encoded descriptions. A field name
 * that drifts here is a field name that drifted in reality.
 */

import { describe, expect, it } from 'vitest';
import { collect, context, query, routedFetch } from '../harness.fixtures.js';
import {
  createFeedProvider,
  epochSecondsToIso,
  withKeywordLine,
  type FeedAdapter,
} from './base.js';
import { createHimalayasProvider, himalayasAdapter, type HimalayasJob } from './himalayas.js';
import { createRemoteOkProvider, remoteOkAdapter, type RemoteOkJob } from './remoteok.js';
import { createRemotiveProvider, remotiveAdapter, type RemotiveJob } from './remotive.js';

/** A fixed instant so recency and expiry assertions do not drift. */
const NOW = Date.parse('2026-09-05T12:00:00Z');
const HOURS_AGO = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const EPOCH_HOURS_AGO = (n: number) => Math.floor((NOW - n * 3_600_000) / 1000);

/* -------------------------------------------------------------------------- */
/* The shared walk                                                            */
/* -------------------------------------------------------------------------- */

/** A feed of arbitrary pages, so the loop can be tested without a board. */
function fakeAdapter(
  pages: number[][],
  overrides: Partial<FeedAdapter<number>> = {},
): FeedAdapter<number> {
  return {
    id: 'remotive',
    label: 'Fake',
    async *pages() {
      for (const page of pages) yield page;
    },
    toRawJob: (n) => ({
      source: 'remotive',
      sourceJobId: String(n),
      title: `Backend Engineer ${n}`,
      companyName: 'Acme',
      isRemote: true,
      hasFullDescription: true,
      postedAt: HOURS_AGO(1),
      sourceUrl: `https://remotive.com/remote-jobs/${n}`,
    }),
    ...overrides,
  };
}

describe('createFeedProvider', () => {
  it('walks every page and yields what matched', async () => {
    const ctx = context(routedFetch({}).impl);
    const provider = createFeedProvider(fakeAdapter([[1, 2], [3]]), { now: () => NOW });

    const jobs = await collect(provider.search(query(), ctx));

    expect(jobs.map((job) => job.sourceJobId)).toEqual(['1', '2', '3']);
    expect(provider.id).toBe('remotive');
    expect(provider.kind).toBe('remote');
    // All three feeds are keyless, so a feed provider is never unavailable.
    expect(provider.unavailableReason).toBeNull();
  });

  it('stops at maxResults without reading further pages', async () => {
    let pagesRead = 0;
    const adapter = fakeAdapter([], {
      async *pages() {
        for (const page of [
          [1, 2],
          [3, 4],
          [5, 6],
        ]) {
          pagesRead += 1;
          yield page;
        }
      },
    });
    const ctx = context(routedFetch({}).impl);
    const provider = createFeedProvider(adapter, { now: () => NOW });

    const jobs = await collect(provider.search(query({ maxResults: 3 }), ctx));

    expect(jobs).toHaveLength(3);
    // The third page is never requested — the budget was full after the second.
    expect(pagesRead).toBe(2);
    // And filling the budget still reports the walk, rather than ending silently.
    expect(ctx.events.at(-1)?.message).toBe('3 of 4 postings matched');
  });

  it('drops one unreadable posting and keeps the rest of the page', async () => {
    const adapter = fakeAdapter([[1, 2, 3]], {
      toRawJob(n) {
        if (n === 2) throw new Error('bad shape');
        return fakeAdapter([]).toRawJob(n, NOW);
      },
    });
    const ctx = context(routedFetch({}).impl);

    const jobs = await collect(
      createFeedProvider(adapter, { now: () => NOW }).search(query(), ctx),
    );

    expect(jobs.map((job) => job.sourceJobId)).toEqual(['1', '3']);
    expect(ctx.events.some((event) => event.message.includes('bad shape'))).toBe(true);
  });

  it('reports a mid-walk failure and keeps what it already yielded', async () => {
    const adapter = fakeAdapter([], {
      async *pages() {
        yield [1, 2];
        throw new Error('feed died');
      },
    });
    const ctx = context(routedFetch({}).impl);

    const jobs = await collect(
      createFeedProvider(adapter, { now: () => NOW }).search(query(), ctx),
    );

    expect(jobs).toHaveLength(2);
    const warning = ctx.events.find((event) => event.level === 'warn');
    expect(warning?.message).toBe('feed died');
  });

  it('ends quietly when the run is cancelled', async () => {
    const controller = new AbortController();
    const adapter = fakeAdapter([[1], [2]], {
      async *pages() {
        yield [1];
        controller.abort();
        yield [2];
      },
    });
    const ctx = { ...context(routedFetch({}).impl), signal: controller.signal };

    const jobs = await collect(
      createFeedProvider(adapter, { now: () => NOW }).search(query(), ctx),
    );

    expect(jobs.map((job) => job.sourceJobId)).toEqual(['1']);
    expect(ctx.events.filter((event) => event.level === 'warn')).toEqual([]);
  });

  it('ranks a page so the closest titles survive the cap', async () => {
    const adapter = fakeAdapter([], {
      async *pages() {
        yield [1, 2];
      },
      toRawJob: (n) => ({
        source: 'remotive',
        sourceJobId: String(n),
        title: n === 1 ? 'Marketing Engineer' : 'Backend Engineer',
        companyName: 'Acme',
        isRemote: true,
        hasFullDescription: true,
        postedAt: HOURS_AGO(1),
        sourceUrl: 'https://remotive.com/x',
      }),
    });
    const ctx = context(routedFetch({}).impl);
    const provider = createFeedProvider(adapter, { now: () => NOW });

    const jobs = await collect(
      provider.search(query({ maxResults: 1, titles: ['Backend Engineer'] }), ctx),
    );

    expect(jobs[0]?.title).toBe('Backend Engineer');
  });

  it('applies the search window against the loop clock, not the wall clock', async () => {
    const adapter = fakeAdapter([], {
      async *pages() {
        yield [1, 2];
      },
      toRawJob: (n) => ({
        source: 'remotive',
        sourceJobId: String(n),
        title: 'Backend Engineer',
        companyName: 'Acme',
        isRemote: true,
        hasFullDescription: true,
        postedAt: n === 1 ? HOURS_AGO(12) : HOURS_AGO(240),
        sourceUrl: 'https://remotive.com/x',
      }),
    });
    const ctx = context(routedFetch({}).impl);
    const provider = createFeedProvider(adapter, { now: () => NOW });

    const jobs = await collect(provider.search(query({ postedWithinDays: 2 }), ctx));

    expect(jobs.map((job) => job.sourceJobId)).toEqual(['1']);
  });
});

describe('epochSecondsToIso', () => {
  it('converts seconds', () => {
    expect(epochSecondsToIso(1_788_559_160)).toBe('2026-09-04T21:59:20.000Z');
  });

  it('rejects a millisecond value rather than dating the job to the far future', () => {
    // The classic mix-up. Converted, this would land in the year 58680.
    expect(epochSecondsToIso(1_788_559_160_000)).toBeUndefined();
  });

  it('rejects zero, null and undefined', () => {
    expect(epochSecondsToIso(0)).toBeUndefined();
    expect(epochSecondsToIso(null)).toBeUndefined();
    expect(epochSecondsToIso(undefined)).toBeUndefined();
    expect(epochSecondsToIso(Number.NaN)).toBeUndefined();
  });
});

describe('withKeywordLine', () => {
  it('appends a labelled paragraph the reader can tell from the prose', () => {
    expect(withKeywordLine('<p>Build things.</p>', ['React', 'Node'])).toBe(
      '<p>Build things.</p>\n<p>Keywords: React, Node</p>',
    );
  });

  it('de-duplicates and drops blanks', () => {
    expect(withKeywordLine('<p>x</p>', ['React', 'React', '  ', null, undefined])).toBe(
      '<p>x</p>\n<p>Keywords: React</p>',
    );
  });

  it('leaves the description alone when there is nothing to add', () => {
    expect(withKeywordLine('<p>x</p>', [])).toBe('<p>x</p>');
    expect(withKeywordLine('<p>x</p>', [null, ''])).toBe('<p>x</p>');
  });
});

/* -------------------------------------------------------------------------- */
/* Remotive                                                                   */
/* -------------------------------------------------------------------------- */

const REMOTIVE_JOB: RemotiveJob = {
  id: 2_091_101,
  url: 'https://remotive.com/remote-jobs/software-dev/senior-backend-engineer-2091101',
  title: 'Senior Backend Engineer',
  company_name: 'Doist',
  company_logo: 'https://remotive.com/logo.png',
  category: 'Software Development',
  tags: ['python', 'django', 'postgres'],
  job_type: 'full_time',
  publication_date: '2026-09-04T19:59:53',
  candidate_required_location: 'Worldwide',
  salary: '$120k - $160k',
  description: '<p>Build and ship the API.</p>',
};

describe('remotive adapter', () => {
  it('maps a posting, keeping the region restriction as the location', () => {
    const job = remotiveAdapter.toRawJob(REMOTIVE_JOB, NOW);

    expect(job).toMatchObject({
      source: 'remotive',
      sourceJobId: '2091101',
      title: 'Senior Backend Engineer',
      companyName: 'Doist',
      // Not flattened to "Remote": this says where the holder may *live*.
      location: 'Worldwide',
      isRemote: true,
      employmentType: 'fulltime',
      hasFullDescription: true,
      salaryRaw: '$120k - $160k',
      descriptionIsHtml: true,
    });
    // Attribution: both links point at Remotive, as the terms require.
    expect(job?.applyUrl).toBe(REMOTIVE_JOB.url);
    expect(job?.sourceUrl).toBe(REMOTIVE_JOB.url);
  });

  it('reads the timezone-less publication date as UTC', () => {
    const job = remotiveAdapter.toRawJob(REMOTIVE_JOB, NOW);

    // Bare, `Date.parse` would read this as local time and shift it by the
    // host's offset — a different answer on a different machine.
    expect(job?.postedAt).toBe('2026-09-04T19:59:53.000Z');
  });

  it('honours a timezone when one is present', () => {
    const job = remotiveAdapter.toRawJob(
      { ...REMOTIVE_JOB, publication_date: '2026-09-04T19:59:53+05:30' },
      NOW,
    );

    expect(job?.postedAt).toBe('2026-09-04T14:29:53.000Z');
  });

  it('folds the category and tags into the description so the matcher sees them', () => {
    const job = remotiveAdapter.toRawJob(REMOTIVE_JOB, NOW);

    expect(job?.description).toBe(
      '<p>Build and ship the API.</p>\n<p>Keywords: Software Development, python, django, postgres</p>',
    );
  });

  it('marks a posting with no description as low confidence', () => {
    const job = remotiveAdapter.toRawJob({ ...REMOTIVE_JOB, description: undefined }, NOW);

    expect(job?.hasFullDescription).toBe(false);
    expect(job?.description).toBeUndefined();
  });

  it('omits salary and location when the feed has none', () => {
    const job = remotiveAdapter.toRawJob(
      { ...REMOTIVE_JOB, salary: '', candidate_required_location: '   ' },
      NOW,
    );

    expect(job?.salaryRaw).toBeUndefined();
    expect(job?.location).toBeUndefined();
  });

  it('skips an item with no title or no url', () => {
    expect(remotiveAdapter.toRawJob({ ...REMOTIVE_JOB, title: undefined }, NOW)).toBeNull();
    expect(remotiveAdapter.toRawJob({ ...REMOTIVE_JOB, url: undefined }, NOW)).toBeNull();
  });

  it('sends no query parameters, because the API ignores them', async () => {
    const { impl, calls } = routedFetch({
      'remotive.com/api/remote-jobs': { jobs: [REMOTIVE_JOB] },
    });
    const ctx = context(impl);

    const jobs = await collect(createRemotiveProvider({ now: () => NOW }).search(query(), ctx));

    expect(jobs).toHaveLength(1);
    expect(calls).toHaveLength(1);
    // Attaching `search`/`limit` would imply a narrowing the endpoint does not do.
    expect(calls[0]).toBe('https://remotive.com/api/remote-jobs');
  });
});

/* -------------------------------------------------------------------------- */
/* RemoteOK                                                                   */
/* -------------------------------------------------------------------------- */

/** Index 0 of the live array. Not a job. */
const REMOTEOK_NOTICE = {
  legal:
    'Using this data feed for commercial purposes is prohibited without a licence. Contact us.',
} as RemoteOkJob;

const REMOTEOK_JOB: RemoteOkJob = {
  slug: 'gitlab-staff-backend-engineer',
  id: '1099821',
  epoch: EPOCH_HOURS_AGO(6),
  date: '2026-09-05T06:00:00+00:00',
  company: 'GitLab',
  company_logo: 'https://remoteok.com/logo.png',
  position: 'Staff Backend Engineer',
  tags: ['golang', 'kubernetes'],
  description: '<p>Own the runner fleet.</p>',
  location: '',
  salary_min: 150_000,
  salary_max: 210_000,
  apply_url: 'https://boards.greenhouse.io/gitlab/jobs/1099821',
  url: 'https://remoteok.com/remote-jobs/1099821-staff-backend-engineer-gitlab',
};

describe('remoteok adapter', () => {
  it('maps a posting and keeps the source link with RemoteOK', () => {
    const job = remoteOkAdapter.toRawJob(REMOTEOK_JOB, NOW);

    expect(job).toMatchObject({
      source: 'remoteok',
      sourceJobId: '1099821',
      title: 'Staff Backend Engineer',
      companyName: 'GitLab',
      isRemote: true,
      hasFullDescription: true,
      salaryMin: 150_000,
      salaryMax: 210_000,
      salaryCurrency: 'USD',
      salaryPeriod: 'year',
    });
    // The employer's link is more useful to apply through...
    expect(job?.applyUrl).toBe('https://boards.greenhouse.io/gitlab/jobs/1099821');
    // ...but the link back to RemoteOK is what the terms require, so it stays.
    expect(job?.sourceUrl).toBe(REMOTEOK_JOB.url);
  });

  it('skips the legal notice that leads the array', () => {
    expect(remoteOkAdapter.toRawJob(REMOTEOK_NOTICE, NOW)).toBeNull();
  });

  it('treats a zero salary as unknown rather than as a salary of nothing', () => {
    const job = remoteOkAdapter.toRawJob({ ...REMOTEOK_JOB, salary_min: 0, salary_max: 0 }, NOW);

    expect(job?.salaryMin).toBeUndefined();
    expect(job?.salaryMax).toBeUndefined();
    expect(job?.salaryCurrency).toBeUndefined();
    expect(job?.salaryPeriod).toBeUndefined();
  });

  it('keeps a one-sided salary', () => {
    const job = remoteOkAdapter.toRawJob({ ...REMOTEOK_JOB, salary_max: 0 }, NOW);

    expect(job?.salaryMin).toBe(150_000);
    expect(job?.salaryMax).toBeUndefined();
    expect(job?.salaryCurrency).toBe('USD');
  });

  it('repairs the double-encoded text the feed actually serves', () => {
    const job = remoteOkAdapter.toRawJob(
      {
        ...REMOTEOK_JOB,
        position: 'Youâll Lead Engineering',
        company: 'CafÃ© Corp',
        description: '<p>Weâre hiring â remotely.</p>',
      },
      NOW,
    );

    expect(job?.title).toBe('You’ll Lead Engineering');
    expect(job?.companyName).toBe('Café Corp');
    expect(job?.description).toContain('We’re hiring — remotely.');
  });

  it('leaves genuinely accented text alone', () => {
    const job = remoteOkAdapter.toRawJob({ ...REMOTEOK_JOB, company: 'Zürich Labs' }, NOW);

    expect(job?.companyName).toBe('Zürich Labs');
  });

  it('drops the empty location string the feed uses for most postings', () => {
    expect(remoteOkAdapter.toRawJob(REMOTEOK_JOB, NOW)?.location).toBeUndefined();
  });

  it('falls back to the ISO date when epoch is missing', () => {
    const job = remoteOkAdapter.toRawJob({ ...REMOTEOK_JOB, epoch: undefined }, NOW);

    expect(job?.postedAt).toBe('2026-09-05T06:00:00.000Z');
  });

  it('builds a source url from the slug when the feed omits one', () => {
    const job = remoteOkAdapter.toRawJob({ ...REMOTEOK_JOB, url: undefined }, NOW);

    expect(job?.sourceUrl).toBe('https://remoteok.com/remote-jobs/gitlab-staff-backend-engineer');
  });

  it('reads the whole board in one request and skips the notice end to end', async () => {
    const { impl, calls } = routedFetch({
      'remoteok.com/api': [REMOTEOK_NOTICE, REMOTEOK_JOB],
    });
    const ctx = context(impl);

    const jobs = await collect(createRemoteOkProvider({ now: () => NOW }).search(query(), ctx));

    expect(jobs.map((job) => job.sourceJobId)).toEqual(['1099821']);
    expect(calls).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Himalayas                                                                  */
/* -------------------------------------------------------------------------- */

const HIMALAYAS_JOB: HimalayasJob = {
  guid: 'https://himalayas.app/companies/vercel/jobs/senior-platform-engineer',
  title: 'Senior Platform Engineer',
  companyName: 'Vercel',
  companySlug: 'vercel',
  companyLogo: 'https://himalayas.app/logo.png',
  excerpt: 'Own the build pipeline.',
  description: '<p>Own the build pipeline end to end.</p>',
  employmentType: 'Full Time',
  minSalary: 180_000,
  maxSalary: 240_000,
  currency: 'usd',
  salaryPeriod: 'annual',
  seniority: ['Senior'],
  locationRestrictions: ['United States', 'Canada'],
  categories: ['DevOps', 'Platform'],
  parentCategories: ['Software Development'],
  pubDate: EPOCH_HOURS_AGO(4),
  expiryDate: Math.floor((NOW + 30 * 86_400_000) / 1000),
  applicationLink: 'https://vercel.com/careers/senior-platform-engineer',
};

const page = (jobs: HimalayasJob[], nextCursor: string | null = null) => ({
  jobs,
  nextCursor,
  totalCount: 103_909,
});

describe('himalayas adapter', () => {
  it('maps a posting, using the guid as both id and source url', () => {
    const job = himalayasAdapter.toRawJob(HIMALAYAS_JOB, NOW);

    expect(job).toMatchObject({
      source: 'himalayas',
      // The feed has no id field at all; the guid is the posting's address.
      sourceJobId: HIMALAYAS_JOB.guid,
      sourceUrl: HIMALAYAS_JOB.guid,
      title: 'Senior Platform Engineer',
      companyName: 'Vercel',
      location: 'United States, Canada',
      isRemote: true,
      employmentType: 'fulltime',
      hasFullDescription: true,
      salaryMin: 180_000,
      salaryMax: 240_000,
      salaryCurrency: 'USD',
      salaryPeriod: 'year',
      applyUrl: 'https://vercel.com/careers/senior-platform-engineer',
      companyCareersUrl: 'https://himalayas.app/companies/vercel',
    });
  });

  it('drops a posting the board has already expired', () => {
    const expired = { ...HIMALAYAS_JOB, expiryDate: Math.floor((NOW - 86_400_000) / 1000) };

    expect(himalayasAdapter.toRawJob(expired, NOW)).toBeNull();
    // ...and is live against an earlier clock, which is why `now` is injected.
    expect(himalayasAdapter.toRawJob(expired, NOW - 5 * 86_400_000)).not.toBeNull();
  });

  it('marks an excerpt-only posting low confidence but still returns it', () => {
    const job = himalayasAdapter.toRawJob({ ...HIMALAYAS_JOB, description: undefined }, NOW);

    // The clamp in the matching engine is what stops a teaser scoring 90%.
    expect(job?.hasFullDescription).toBe(false);
    expect(job?.description).toContain('Own the build pipeline.');
  });

  it('folds both category levels into the description', () => {
    const job = himalayasAdapter.toRawJob(HIMALAYAS_JOB, NOW);

    expect(job?.description).toBe(
      '<p>Own the build pipeline end to end.</p>\n' +
        '<p>Keywords: Software Development, DevOps, Platform</p>',
    );
  });

  it('omits salary when the feed reports none', () => {
    const job = himalayasAdapter.toRawJob({ ...HIMALAYAS_JOB, minSalary: null, maxSalary: 0 }, NOW);

    expect(job?.salaryMin).toBeUndefined();
    expect(job?.salaryMax).toBeUndefined();
    expect(job?.salaryCurrency).toBeUndefined();
  });

  it('falls back to the guid when there is no application link', () => {
    const job = himalayasAdapter.toRawJob({ ...HIMALAYAS_JOB, applicationLink: undefined }, NOW);

    expect(job?.applyUrl).toBe(HIMALAYAS_JOB.guid);
  });

  it('skips an item with no guid or no title', () => {
    expect(himalayasAdapter.toRawJob({ ...HIMALAYAS_JOB, guid: undefined }, NOW)).toBeNull();
    expect(himalayasAdapter.toRawJob({ ...HIMALAYAS_JOB, title: undefined }, NOW)).toBeNull();
  });

  it('pages with the cursor the feed hands back, not with offset', async () => {
    const second = { ...HIMALAYAS_JOB, guid: `${HIMALAYAS_JOB.guid}-2` };
    const { impl, calls } = routedFetch({
      'cursor=CURSOR1': page([second]),
      'jobs/api': page([HIMALAYAS_JOB], 'CURSOR1'),
    });
    const ctx = context(impl);

    const jobs = await collect(
      createHimalayasProvider({ now: () => NOW }).search(query({ maxResults: 10 }), ctx),
    );

    expect(jobs).toHaveLength(2);
    expect(calls[0]).toBe('https://himalayas.app/jobs/api?limit=100');
    expect(calls[1]).toBe('https://himalayas.app/jobs/api?limit=100&cursor=CURSOR1');
    // The feed's own notes deprecate offset paging and warn it repeats jobs.
    expect(calls.join(' ')).not.toContain('offset=');
  });

  it('stops once a page ends older than the search window', async () => {
    const old = {
      ...HIMALAYAS_JOB,
      guid: `${HIMALAYAS_JOB.guid}-old`,
      pubDate: EPOCH_HOURS_AGO(24 * 40),
    };
    const { impl, calls } = routedFetch({
      // Offered, but never requested: the first page already ran past the window.
      'cursor=CURSOR1': page([HIMALAYAS_JOB]),
      'jobs/api': page([HIMALAYAS_JOB, old], 'CURSOR1'),
    });
    const ctx = context(impl);

    const jobs = await collect(
      createHimalayasProvider({ now: () => NOW }).search(query({ postedWithinDays: 7 }), ctx),
    );

    expect(calls).toHaveLength(1);
    // The out-of-window posting is filtered too, not merely used as a stop signal.
    expect(jobs.map((job) => job.sourceJobId)).toEqual([HIMALAYAS_JOB.guid]);
  });

  it('stops at the page ceiling and says so, rather than implying the feed ran dry', async () => {
    // Every page is fresh and offers another cursor, so only the cap can stop it.
    const impl = async (url: string) =>
      new Response(
        JSON.stringify(
          page([{ ...HIMALAYAS_JOB, guid: `${HIMALAYAS_JOB.guid}-${url.length}` }], 'MORE'),
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    const ctx = context(impl);

    await collect(
      createHimalayasProvider({ now: () => NOW }).search(query({ maxResults: 1000 }), ctx),
    );

    const capped = ctx.events.find((event) => event.message.includes('stopped after 20 pages'));
    expect(capped?.level).toBe('info');
    expect(capped).toMatchObject({ limited: true });
    expect(capped?.message).toContain('103909');
    expect(capped?.message).toContain('were not read');
  });
});
