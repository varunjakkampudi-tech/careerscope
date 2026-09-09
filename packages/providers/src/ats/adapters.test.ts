/**
 * Mapping tests for the six ATS adapters.
 *
 * The fixtures are trimmed copies of payloads captured from the live APIs, so
 * a field name that drifts here is a field name that drifted in reality. What
 * these assert is the part that is easy to get quietly wrong: which URL is the
 * apply link, which fields make up the description, what the pay period means,
 * and whether a posting that cannot be read is dropped rather than half-mapped.
 */

import { describe, expect, it } from 'vitest';
import type { FetchLike } from '../http.js';
import type { BoardRef } from '../boards.js';
import { ashbyAdapter } from './ashby.js';
import { greenhouseAdapter } from './greenhouse.js';
import { leverAdapter } from './lever.js';
import { recruiteeAdapter } from './recruitee.js';
import { smartRecruitersAdapter } from './smartrecruiters.js';
import { createWorkableAdapter } from './workable.js';
import { context, query, routedFetch } from '../harness.fixtures.js';

const ref = (source: BoardRef['source'], slug: string, company: string): BoardRef => ({
  source,
  slug,
  company,
});

/* -------------------------------------------------------------------------- */
/* Greenhouse                                                                 */
/* -------------------------------------------------------------------------- */

describe('greenhouse', () => {
  const board = ref('greenhouse', 'stripe', 'Stripe');
  const posting = {
    id: 6963861,
    title: 'Software Engineer, Payments',
    absolute_url: 'https://job-boards.greenhouse.io/stripe/jobs/6963861',
    location: { name: 'Bengaluru, India' },
    updated_at: '2026-08-20T10:00:00-04:00',
    first_published: '2026-08-01T10:00:00-04:00',
    company_name: 'Stripe',
  };

  it('maps a listing, and marks it as not yet having a description', () => {
    const job = greenhouseAdapter.toRawJob(posting, board)!;
    expect(job).toMatchObject({
      source: 'greenhouse',
      sourceJobId: 'stripe:6963861',
      title: 'Software Engineer, Payments',
      companyName: 'Stripe',
      location: 'Bengaluru, India',
      hasFullDescription: false,
      atsType: 'greenhouse',
      applyUrl: 'https://job-boards.greenhouse.io/stripe/jobs/6963861',
      companyCareersUrl: 'https://job-boards.greenhouse.io/stripe',
    });
  });

  it('prefers first_published over updated_at — an edit is not a repost', () => {
    expect(greenhouseAdapter.toRawJob(posting, board)?.postedAt).toBe('2026-08-01T10:00:00-04:00');
    const noPublish = { ...posting, first_published: undefined };
    expect(greenhouseAdapter.toRawJob(noPublish, board)?.postedAt).toBe(
      '2026-08-20T10:00:00-04:00',
    );
  });

  it('falls back to the curated name only when the board does not give one', () => {
    expect(greenhouseAdapter.toRawJob({ ...posting, company_name: '  ' }, board)?.companyName).toBe(
      'Stripe',
    );
    expect(
      greenhouseAdapter.toRawJob({ ...posting, company_name: 'Stripe Inc.' }, board)?.companyName,
    ).toBe('Stripe Inc.');
  });

  it('drops a posting with no title rather than emitting a blank lead', () => {
    expect(greenhouseAdapter.toRawJob({ ...posting, title: undefined }, board)).toBeNull();
  });

  it('unescapes the detail description, which arrives HTML-escaped', async () => {
    const { impl } = routedFetch({
      '/jobs/6963861': {
        id: 6963861,
        content: '&lt;p&gt;Build &amp;amp; ship payments.&lt;/p&gt;',
      },
    });
    const listed = greenhouseAdapter.toRawJob(posting, board)!;
    const full = await greenhouseAdapter.fetchDetail!(listed, context(impl));
    expect(full.description).toBe('<p>Build &amp; ship payments.</p>');
    expect(full.hasFullDescription).toBe(true);
    expect(full.descriptionIsHtml).toBe(true);
  });

  it('leaves the job untouched when the detail endpoint has nothing to add', async () => {
    const { impl } = routedFetch({ '/jobs/': { id: 1, content: '   ' } });
    const listed = greenhouseAdapter.toRawJob(posting, board)!;
    expect(await greenhouseAdapter.fetchDetail!(listed, context(impl))).toEqual(listed);
  });

  it('lists a board', async () => {
    const { impl, calls } = routedFetch({ '/boards/stripe/jobs': { jobs: [posting] } });
    const items = await greenhouseAdapter.listBoard(board, context(impl), query());
    expect(items).toHaveLength(1);
    // Explicitly *not* ?content=true: the full-content variant is 12× larger.
    expect(calls[0]).not.toContain('content=true');
  });
});

/* -------------------------------------------------------------------------- */
/* Lever                                                                      */
/* -------------------------------------------------------------------------- */

describe('lever', () => {
  const board = ref('lever', 'matchgroup', 'Match Group');
  const posting = {
    id: 'a1b2c3',
    text: 'Senior Backend Engineer',
    hostedUrl: 'https://jobs.lever.co/matchgroup/a1b2c3',
    applyUrl: 'https://jobs.lever.co/matchgroup/a1b2c3/apply',
    createdAt: 1_756_000_000_000,
    workplaceType: 'remote',
    country: 'US',
    categories: { commitment: 'Full-time', location: 'New York, New York', team: 'Core' },
    salaryRange: { interval: 'per-year-salary', currency: 'USD', min: 150000, max: 180000 },
    description: '<p>About the role</p>',
    lists: [{ text: 'What you will do', content: '<li>Ship services</li>' }],
    additional: '<p>Equal opportunity</p>',
  };

  it('joins the split description, because the intro alone is a company blurb', () => {
    const job = leverAdapter.toRawJob(posting, board)!;
    expect(job.description).toBe(
      '<p>About the role</p>\n<h3>What you will do</h3><li>Ship services</li>\n<p>Equal opportunity</p>',
    );
    expect(job.hasFullDescription).toBe(true);
  });

  it('reads the salary range and its period', () => {
    expect(leverAdapter.toRawJob(posting, board)).toMatchObject({
      salaryMin: 150000,
      salaryMax: 180000,
      salaryCurrency: 'USD',
      salaryPeriod: 'year',
    });
  });

  it('omits salary fields entirely when the board states no range', () => {
    const job = leverAdapter.toRawJob({ ...posting, salaryRange: undefined }, board)!;
    expect(job.salaryMin).toBeUndefined();
    expect(job.salaryMax).toBeUndefined();
  });

  it('converts the epoch timestamp Lever uses for createdAt', () => {
    expect(leverAdapter.toRawJob(posting, board)?.postedAt).toBe(
      new Date(1_756_000_000_000).toISOString(),
    );
  });

  it('marks remote only when the board says remote, not hybrid or on-site', () => {
    expect(leverAdapter.toRawJob(posting, board)?.isRemote).toBe(true);
    expect(
      leverAdapter.toRawJob({ ...posting, workplaceType: 'hybrid' }, board)?.isRemote,
    ).toBeUndefined();
  });

  it('pages on skip, which is the parameter that actually advances', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ ...posting, id: `p${i}` }));
    let call = 0;
    const impl: FetchLike = async (url) => {
      call += 1;
      const body = call === 1 ? page : [{ ...posting, id: 'last' }];
      expect(url).toContain(call === 1 ? 'skip=0' : 'skip=100');
      expect(url).not.toContain('offset=');
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const items = await leverAdapter.listBoard(board, context(impl), query());
    expect(items).toHaveLength(101);
  });
});

/* -------------------------------------------------------------------------- */
/* Ashby                                                                      */
/* -------------------------------------------------------------------------- */

describe('ashby', () => {
  const board = ref('ashby', 'openai', 'OpenAI');
  const posting = {
    id: 'f47ac10b',
    title: 'Member of Technical Staff',
    location: 'San Francisco',
    secondaryLocations: [{ location: 'Remote' }],
    isRemote: false,
    isListed: true,
    employmentType: 'FullTime',
    publishedAt: '2026-08-15T00:00:00Z',
    jobUrl: 'https://jobs.ashbyhq.com/openai/f47ac10b',
    applyUrl: 'https://jobs.ashbyhq.com/openai/f47ac10b/application',
    descriptionHtml: '<p>Do research.</p>',
    descriptionPlain: 'Do research.',
    compensation: {
      compensationTierSummary: '$211.4K – $290.6K • Offers Equity',
      scrapeableCompensationSalarySummary: '$211.4K - $290.6K',
      summaryComponents: [
        {
          compensationType: 'Salary',
          interval: '1 YEAR',
          currencyCode: 'USD',
          minValue: 211400,
          maxValue: 290600,
        },
        {
          compensationType: 'EquityPercentage',
          interval: 'NONE',
          currencyCode: null,
          minValue: 0.1,
          maxValue: 0.2,
        },
      ],
    },
  };

  it('takes the salary component and ignores the equity one', () => {
    expect(ashbyAdapter.toRawJob(posting, board)).toMatchObject({
      salaryMin: 211400,
      salaryMax: 290600,
      salaryCurrency: 'USD',
      salaryPeriod: 'year',
    });
  });

  it('keeps the human summary, which says things the two numbers cannot', () => {
    expect(ashbyAdapter.toRawJob(posting, board)?.salaryRaw).toBe(
      '$211.4K – $290.6K • Offers Equity',
    );
  });

  it('prefers HTML over the plain-text duplicate', () => {
    const job = ashbyAdapter.toRawJob(posting, board)!;
    expect(job.description).toBe('<p>Do research.</p>');
    expect(job.descriptionIsHtml).toBe(true);
  });

  it('falls back to plain text and says it is not HTML', () => {
    const job = ashbyAdapter.toRawJob({ ...posting, descriptionHtml: undefined }, board)!;
    expect(job.description).toBe('Do research.');
    expect(job.descriptionIsHtml).toBe(false);
  });

  it('normalises the CamelCase employment type', () => {
    expect(ashbyAdapter.toRawJob(posting, board)?.employmentType).toBe('fulltime');
  });

  it('drops postings the company has unlisted', async () => {
    const { impl } = routedFetch({
      '/job-board/openai': { jobs: [posting, { ...posting, id: 'hidden', isListed: false }] },
    });
    const items = await ashbyAdapter.listBoard(board, context(impl), query());
    expect(items.map((item) => item.id)).toEqual(['f47ac10b']);
  });

  it('asks for compensation, which is off by default', async () => {
    const { impl, calls } = routedFetch({ '/job-board/openai': { jobs: [] } });
    await ashbyAdapter.listBoard(board, context(impl), query());
    expect(calls[0]).toContain('includeCompensation=true');
  });
});

/* -------------------------------------------------------------------------- */
/* Workable                                                                   */
/* -------------------------------------------------------------------------- */

describe('workable', () => {
  const board = ref('workable', 'apna', 'Apna');
  const listed = {
    shortcode: 'A1B2C3D4E5',
    title: 'Backend Engineer',
    location: { city: 'Bengaluru', country: 'India' },
  };

  it('builds the apply URL from the shortcode', () => {
    const job = createWorkableAdapter().toRawJob(listed, board)!;
    expect(job.sourceJobId).toBe('apna:A1B2C3D4E5');
    expect(job.applyUrl).toBe('https://apply.workable.com/apna/j/A1B2C3D4E5/');
    expect(job.hasFullDescription).toBe(false);
  });

  it('reads a location from either shape the endpoint answers with', () => {
    const adapter = createWorkableAdapter();
    expect(adapter.toRawJob(listed, board)?.location).toBe('Bengaluru, India');
    expect(adapter.toRawJob({ ...listed, location: 'Pune, India' }, board)?.location).toBe(
      'Pune, India',
    );
    expect(adapter.toRawJob({ ...listed, location: {} }, board)?.location).toBeUndefined();
  });

  it('joins description, requirements and benefits — requirements is where skills live', async () => {
    const { impl } = routedFetch({
      '/jobs/A1B2C3D4E5': {
        description: '<p>The role</p>',
        requirements: '<p>5 years of Node.js</p>',
        benefits: '<p>Health cover</p>',
      },
    });
    const adapter = createWorkableAdapter();
    const job = adapter.toRawJob(listed, board)!;
    const full = await adapter.fetchDetail!(job, context(impl));
    expect(full.description).toBe(
      '<p>The role</p>\n<p>5 years of Node.js</p>\n<p>Health cover</p>',
    );
    expect(full.hasFullDescription).toBe(true);
  });

  it('discovers that the page token travels in the query string, then reuses that', async () => {
    const pages: Record<string, unknown> = {
      first: { results: [{ shortcode: 'p1', title: 'A' }], nextPage: 'tok1' },
      second: { results: [{ shortcode: 'p2', title: 'B' }], nextPage: null },
    };
    const seen: string[] = [];
    const impl: FetchLike = async (url) => {
      seen.push(url);
      const body = url.includes('token=tok1') ? pages.second : pages.first;
      return new Response(JSON.stringify(body), { status: 200 });
    };
    const items = await createWorkableAdapter().listBoard(board, context(impl), query());
    expect(items.map((item) => item.shortcode)).toEqual(['p1', 'p2']);
    expect(seen.some((url) => url.includes('token=tok1'))).toBe(true);
  });

  it('falls back to the body form when the query form is ignored', async () => {
    const bodies: string[] = [];
    const impl: FetchLike = async (url, init) => {
      const body = String(init?.body ?? '');
      bodies.push(body);
      const advanced = body.includes('"token":"tok1"');
      return new Response(
        JSON.stringify(
          advanced
            ? { results: [{ shortcode: 'p2' }], nextPage: null }
            : { results: [{ shortcode: 'p1' }], nextPage: 'tok1' },
        ),
        { status: 200 },
      );
    };
    const ctx = context(impl);
    const items = await createWorkableAdapter().listBoard(board, ctx, query());
    expect(items.map((item) => item.shortcode)).toEqual(['p1', 'p2']);
    expect(ctx.events.some((event) => event.message.includes('travels in the body'))).toBe(true);
  });

  it('stops instead of looping when the token is ignored in both forms', async () => {
    let calls = 0;
    const impl: FetchLike = async () => {
      calls += 1;
      // Always page one: exactly what an ignored token produces.
      return new Response(JSON.stringify({ results: [{ shortcode: 'p1' }], nextPage: 'tok1' }), {
        status: 200,
      });
    };
    const ctx = context(impl);
    const items = await createWorkableAdapter().listBoard(board, ctx, query());
    expect(items.map((item) => item.shortcode)).toEqual(['p1']);
    expect(calls).toBe(3); // first page + one attempt per token form
    expect(ctx.events.some((event) => event.message.includes('first pages only'))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* SmartRecruiters                                                            */
/* -------------------------------------------------------------------------- */

describe('smartrecruiters', () => {
  const board = ref('smartrecruiters', 'swiggy', 'Swiggy');
  const listed = {
    id: '744000012345678',
    name: 'SDE II - Backend',
    company: { identifier: 'swiggy', name: 'Swiggy' },
    location: { city: 'Bengaluru', region: 'Karnataka', country: 'in', remote: false },
    releasedDate: '2026-08-11T06:00:00.000Z',
    typeOfEmployment: { label: 'Full-time' },
  };

  it('maps a listing with no description yet', () => {
    expect(smartRecruitersAdapter.toRawJob(listed, board)).toMatchObject({
      sourceJobId: 'swiggy:744000012345678',
      title: 'SDE II - Backend',
      companyName: 'Swiggy',
      location: 'Bengaluru, Karnataka, in',
      employmentType: 'fulltime',
      hasFullDescription: false,
      postedAt: '2026-08-11T06:00:00.000Z',
    });
  });

  it('prefers fullLocation when the board supplies one', () => {
    const job = smartRecruitersAdapter.toRawJob(
      { ...listed, location: { ...listed.location, fullLocation: 'Bengaluru, Karnataka, India' } },
      board,
    );
    expect(job?.location).toBe('Bengaluru, Karnataka, India');
  });

  it('orders the description so the skills-bearing sections come first', async () => {
    const { impl } = routedFetch({
      '/postings/744000012345678': {
        ...listed,
        applyUrl: 'https://jobs.smartrecruiters.com/swiggy/744000012345678/apply',
        location: { ...listed.location, remote: true },
        jobAd: {
          sections: {
            companyDescription: { title: 'About Swiggy', text: '<p>We deliver food.</p>' },
            jobDescription: { title: 'The Role', text: '<p>Build APIs.</p>' },
            qualifications: { title: 'Qualifications', text: '<p>Go, Kafka.</p>' },
            additionalInformation: { title: 'More', text: '<p>Hybrid.</p>' },
          },
        },
      },
    });
    const job = smartRecruitersAdapter.toRawJob(listed, board)!;
    const full = await smartRecruitersAdapter.fetchDetail!(job, context(impl));
    const text = full.description ?? '';

    expect(text.indexOf('Build APIs')).toBeLessThan(text.indexOf('Go, Kafka'));
    expect(text.indexOf('Go, Kafka')).toBeLessThan(text.indexOf('We deliver food'));
    expect(text).toContain('<h3>Qualifications</h3>');
    expect(full.hasFullDescription).toBe(true);
    expect(full.isRemote).toBe(true);
    expect(full.applyUrl).toBe('https://jobs.smartrecruiters.com/swiggy/744000012345678/apply');
  });

  it('keeps the listing as-is when the detail payload has no job ad', async () => {
    const { impl } = routedFetch({ '/postings/': { ...listed, jobAd: undefined } });
    const job = smartRecruitersAdapter.toRawJob(listed, board)!;
    expect(await smartRecruitersAdapter.fetchDetail!(job, context(impl))).toEqual(job);
  });

  it('stops paging once the reported total is covered', async () => {
    let calls = 0;
    const impl: FetchLike = async () => {
      calls += 1;
      return new Response(
        JSON.stringify({ totalFound: 2, content: [listed, { ...listed, id: '2' }] }),
        { status: 200 },
      );
    };
    const items = await smartRecruitersAdapter.listBoard(board, context(impl), query());
    expect(items).toHaveLength(2);
    expect(calls).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Recruitee                                                                  */
/* -------------------------------------------------------------------------- */

describe('recruitee', () => {
  const board = ref('recruitee', 'jobs', 'Tellent');
  const offer = {
    id: 123456,
    slug: 'senior-backend-engineer',
    title: 'Senior Backend Engineer',
    description: '<p>Build the platform.</p>',
    requirements: '<p>Elixir, Postgres.</p>',
    careers_url: 'https://jobs.recruitee.com/o/senior-backend-engineer',
    careers_apply_url: 'https://jobs.recruitee.com/o/senior-backend-engineer/c/new',
    location: 'Amsterdam, NL',
    city: 'Amsterdam',
    country_code: 'NL',
    remote: false,
    employment_type_code: 'fulltime',
    salary: { min: 70000, max: 90000, period: 'yearly', currency: 'EUR' },
    created_at: '2026-07-01T00:00:00Z',
    published_at: '2026-07-02T00:00:00Z',
    company_name: 'Tellent',
    mailbox_email: 'careers@tellent.com',
  };

  it('maps a full offer, description and salary included', () => {
    expect(recruiteeAdapter.toRawJob(offer, board)).toMatchObject({
      source: 'recruitee',
      sourceJobId: '123456',
      companyName: 'Tellent',
      location: 'Amsterdam, NL',
      description: '<p>Build the platform.</p>\n<p>Elixir, Postgres.</p>',
      hasFullDescription: true,
      salaryMin: 70000,
      salaryMax: 90000,
      salaryCurrency: 'EUR',
      salaryPeriod: 'year',
      postedAt: '2026-07-02T00:00:00Z',
      applyUrl: 'https://jobs.recruitee.com/o/senior-backend-engineer/c/new',
    });
  });

  it('accepts a salary the board wrote as a string', () => {
    const job = recruiteeAdapter.toRawJob(
      { ...offer, salary: { min: '70,000', max: '90000', period: 'monthly', currency: 'INR' } },
      board,
    )!;
    expect(job.salaryMin).toBe(70000);
    expect(job.salaryMax).toBe(90000);
    expect(job.salaryPeriod).toBe('month');
  });

  it('keeps a recruiting mailbox, because the employer published it themselves', () => {
    expect(recruiteeAdapter.toRawJob(offer, board)?.companyCareersEmail).toBe(
      'careers@tellent.com',
    );
    expect(
      recruiteeAdapter.toRawJob({ ...offer, mailbox_email: 'jobs@x.io' }, board)
        ?.companyCareersEmail,
    ).toBe('jobs@x.io');
  });

  it("drops a named recruiter's personal inbox — the user asked for a careers contact", () => {
    for (const email of ['priya.sharma@tellent.com', 'ceo@tellent.com', 'not-an-email', '']) {
      expect(
        recruiteeAdapter.toRawJob({ ...offer, mailbox_email: email }, board)?.companyCareersEmail,
        email,
      ).toBeUndefined();
    }
  });

  it('falls back to city and country when the board omits a location string', () => {
    expect(recruiteeAdapter.toRawJob({ ...offer, location: undefined }, board)?.location).toBe(
      'Amsterdam, NL',
    );
  });

  it('refuses a slug that could redirect the request to another host', async () => {
    const { impl, calls } = routedFetch({ '.recruitee.com': { offers: [offer] } });
    const ctx = context(impl);
    const items = await recruiteeAdapter.listBoard(
      ref('recruitee', 'evil.com/x', 'Evil'),
      ctx,
      query(),
    );
    expect(items).toEqual([]);
    expect(calls).toEqual([]);
    expect(ctx.events.some((event) => event.level === 'warn')).toBe(true);
  });

  it('reads a board from its own subdomain', async () => {
    const { impl, calls } = routedFetch({ 'jobs.recruitee.com/api/offers': { offers: [offer] } });
    const items = await recruiteeAdapter.listBoard(board, context(impl), query());
    expect(items).toHaveLength(1);
    expect(calls[0]).toBe('https://jobs.recruitee.com/api/offers/');
  });
});
