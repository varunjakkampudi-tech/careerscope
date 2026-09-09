/**
 * LinkedIn's logged-out guest endpoints.
 *
 * Everything here runs against two pages captured from the live site, because
 * the failure this adapter is most exposed to is not a crash — it is LinkedIn
 * renaming a CSS class and the parser quietly returning fewer cards, or half a
 * description, for as long as nobody counts. So the fixture assertions are
 * exact: ten cards, a named first card, a description of a known length. A
 * layout change then fails a test instead of shrinking a result set.
 *
 * The other half of the suite is about refusal. This source is the one that
 * runs on plain HTTP, which means a 403 or a 429 arrives as an ordinary
 * response or an ordinary throw — and both have to come out as a *block*, not
 * as an empty page and not as a crash.
 */

import type { ProviderQuery } from '@job-radar/shared';
import { describe, expect, it } from 'vitest';
import { context, query, routedFetch } from '../harness.fixtures.js';
import type { ScrapeContext, ScrapePage } from './base.js';
import { fixture } from './harness.fixtures.js';
import {
  extractCriteria,
  extractDescription,
  type LinkedInCard,
  linkedinAdapter,
  parseCards,
} from './linkedin.js';

const SEARCH = 'seeMoreJobPostings/search';
const DETAIL = 'jobs-guest/jobs/api/jobPosting';

const searchHtml = fixture('linkedin-search.html');
const detailHtml = fixture('linkedin-detail.html');

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** A search fragment with `ids.length` cards, shaped like the real one. */
function fragment(ids: readonly string[]): string {
  return ids
    .map(
      (id) => `<li><div class="base-card" data-entity-urn="urn:li:jobPosting:${id}">
  <a class="base-card__full-link" href="https://in.linkedin.com/jobs/view/role-${id}?refId=abc&amp;trackingId=xyz"></a>
  <h3 class="base-search-card__title">Role ${id}</h3>
  <h4 class="base-search-card__subtitle"><a class="hidden-nested-link" href="https://in.linkedin.com/company/c${id}?trk=guest">Company ${id}</a></h4>
  <span class="job-search-card__location">Bengaluru, Karnataka, India</span>
  <time datetime="2026-09-01"></time>
</div></li>`,
    )
    .join('\n');
}

/** Replies in order, repeating the last — a paginated endpoint in three lines. */
function serve(...bodies: readonly string[]): () => Response {
  let index = 0;
  return () => {
    const body = bodies[Math.min(index, bodies.length - 1)] ?? '';
    index += 1;
    return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
  };
}

function ctxWith(routes: Record<string, unknown>): {
  ctx: ScrapeContext & { events: ReturnType<typeof context>['events'] };
  calls: string[];
} {
  const { impl, calls } = routedFetch(routes);
  return { ctx: context(impl), calls };
}

async function walk(
  ctx: ScrapeContext,
  q: ProviderQuery,
): Promise<Array<ScrapePage<LinkedInCard>>> {
  const pages: Array<ScrapePage<LinkedInCard>> = [];
  for await (const page of linkedinAdapter.pages(ctx, q, 0)) pages.push(page);
  return pages;
}

/* -------------------------------------------------------------------------- */
/* Parsing the captured page                                                  */
/* -------------------------------------------------------------------------- */

describe('parseCards', () => {
  const cards = parseCards(searchHtml);

  it('reads every card on a real results fragment', () => {
    // Ten is LinkedIn's page size, and the count is what pagination keys off —
    // a parser that silently dropped one would also stop the walk a page early.
    expect(cards).toHaveLength(10);
  });

  it('reads one card completely, field for field', () => {
    // Asserted whole rather than field-by-field: a rename that moves the
    // company into the location slot passes every individual `toBeTruthy`.
    expect(cards[0]).toEqual({
      id: '4306118459',
      title: 'Fullstack Developer',
      company: 'Quantulum Ventures',
      companyUrl: 'https://in.linkedin.com/company/quantulum',
      location: 'Bengaluru, Karnataka, India',
      postedAt: '2025-09-30',
      applyUrl:
        'https://in.linkedin.com/jobs/view/fullstack-developer-at-quantulum-ventures-4306118459',
    });
  });

  it('drops the per-session tracking from every link', () => {
    // `refId` and `trackingId` identify this search session. They are not needed
    // to open the posting, they make two links to the same job look different,
    // and they would otherwise be written into the database and the XLSX export.
    for (const card of cards) {
      expect(card.applyUrl).not.toContain('?');
      expect(card.companyUrl ?? '').not.toContain('?');
    }
  });

  it('returns nothing for markup with no postings in it', () => {
    // The empty-results fragment, and also every error page LinkedIn might
    // serve with a 200. Both should produce no cards and no exception.
    expect(parseCards('<ul class="jobs-search__results-list"></ul>')).toEqual([]);
    expect(parseCards('')).toEqual([]);
  });

  it('skips a card that has an id but no title', () => {
    const broken = `<li data-entity-urn="urn:li:jobPosting:1"><span>???</span></li>${fragment(['2'])}`;

    // A posting with no title is not a lead — it is a row with a link in it.
    // Skipping it here is what keeps `toRawJob` from having to guess later.
    expect(parseCards(broken).map((card) => card.id)).toEqual(['2']);
  });

  it('keeps each card inside its own slice', () => {
    // The reason cards are split on the urn and parsed within the slice: with a
    // single document-wide regex, card 1's missing title would be filled from
    // card 2's markup and every field after it would shift by one.
    const parsed = parseCards(fragment(['11', '22']));

    expect(parsed.map((card) => [card.id, card.title, card.company])).toEqual([
      ['11', 'Role 11', 'Company 11'],
      ['22', 'Role 22', 'Company 22'],
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* The detail page                                                            */
/* -------------------------------------------------------------------------- */

describe('extractDescription', () => {
  it('reads the whole description off a real posting', () => {
    const description = extractDescription(detailHtml);

    expect(description).toContain('Location: JP Nagar, Bangalore');
    // Well past `MIN_FULL_DESCRIPTION_CHARS`, which is the point: this is the
    // source that is allowed to clear 85%, and it earns that by actually being
    // read in full rather than by being trusted.
    expect(description?.length).toBe(2396);
  });

  it('counts nesting rather than stopping at the first closing tag', () => {
    const html = `<div class="show-more-less-html__markup">
        <p>About the role</p>
        <div><ul><li>React</li><li>Node</li></ul></div>
        <p>Apply by Friday</p>
      </div>
      <div class="footer">Not part of the description</div>`;

    const description = extractDescription(html) ?? '';

    // The quiet-wrongness case. A non-greedy match to the first `</div>` would
    // cut the JD at the requirements list, and the truncated text would still
    // set `hasFullDescription: true` — so a posting we half-read would be free
    // to claim a 90% match.
    expect(description).toContain('Apply by Friday');
    expect(description).not.toContain('Not part of the description');
    // `<li>` survives as a list marker, because that is how the demand
    // extractor tells a requirements list from a paragraph about the company.
    expect(description).toContain('- React');
  });

  it('reports nothing rather than empty when the block is absent', () => {
    // `null` is what `fetchDetail` branches on to keep the card as it was. An
    // empty string would read as "the posting has no description".
    expect(extractDescription('<html><body>signed out</body></html>')).toBeNull();
    expect(extractDescription('<div class="show-more-less-html__markup">  </div>')).toBeNull();
  });
});

describe('extractCriteria', () => {
  it('reads the employment type off a real posting', () => {
    expect(extractCriteria(detailHtml)).toEqual({ employmentType: 'Full-time' });
  });

  it('says nothing when the criteria list is missing', () => {
    expect(extractCriteria('<html></html>')).toEqual({ employmentType: null });
  });
});

/* -------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* -------------------------------------------------------------------------- */

describe('toRawJob', () => {
  const card = parseCards(searchHtml)[0]!;

  it('maps a card without claiming to have read the posting', () => {
    const job = linkedinAdapter.toRawJob(card, 0);

    expect(job).toMatchObject({
      source: 'linkedin',
      sourceJobId: '4306118459',
      title: 'Fullstack Developer',
      companyName: 'Quantulum Ventures',
      location: 'Bengaluru, Karnataka, India',
      isRemote: false,
      sourceUrl: 'https://www.linkedin.com/jobs/view/4306118459',
      companyLinkedinUrl: 'https://in.linkedin.com/company/quantulum',
    });
    // The card carries no description at all, so this posting is capped at 80%
    // until `fetchDetail` runs. Claiming otherwise here is how a title-only
    // match would be free to score 90%.
    expect(job?.hasFullDescription).toBe(false);
    expect(job?.description).toBeUndefined();
  });

  it('reads remote off the location, since the card says nothing else', () => {
    const remote = linkedinAdapter.toRawJob({ ...card, location: 'Remote, India' }, 0);

    expect(remote?.isRemote).toBe(true);
  });

  it('refuses a card with no company', () => {
    expect(linkedinAdapter.toRawJob({ ...card, company: '' }, 0)).toBeNull();
    expect(linkedinAdapter.toRawJob({ ...card, title: '' }, 0)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The walk                                                                   */
/* -------------------------------------------------------------------------- */

describe('pages', () => {
  it('asks LinkedIn to do the recency filtering', async () => {
    const { ctx, calls } = ctxWith({ [SEARCH]: serve(fragment(['1'])) });

    await walk(
      ctx,
      query({ titles: ['Full Stack Engineer'], locations: ['Bengaluru'], postedWithinDays: 7 }),
    );

    const url = new URL(calls[0] ?? '');
    expect(url.searchParams.get('keywords')).toBe('Full Stack Engineer');
    expect(url.searchParams.get('location')).toBe('Bengaluru');
    // Seconds, in LinkedIn's own vocabulary. Filtering server-side is the
    // difference between reading four pages of matches and reading four pages
    // to find one — the local recency gate would discard the rest anyway.
    expect(url.searchParams.get('f_TPR')).toBe('r604800');
    expect(url.searchParams.get('f_WT')).toBeNull();
  });

  it('searches all of India, remotely, when the user wants remote', async () => {
    const { ctx, calls } = ctxWith({ [SEARCH]: serve(fragment(['1'])) });

    await walk(ctx, query({ titles: ['Backend'], locations: ['Pune'], remoteOnly: true }));

    const url = new URL(calls[0] ?? '');
    // A city filter on a remote search is a contradiction that returns almost
    // nothing — the posting is remote, so its office is not the point.
    expect(url.searchParams.get('location')).toBe('India');
    expect(url.searchParams.get('f_WT')).toBe('2');
  });

  it('stops a query as soon as a page comes back short', async () => {
    const { ctx, calls } = ctxWith({ [SEARCH]: serve(fragment(['1', '2', '3'])) });

    const pages = await walk(ctx, query({ titles: ['Full Stack'], locations: ['Bengaluru'] }));

    // LinkedIn pads to ten whenever there is more, so three means the end. One
    // request, not four.
    expect(calls).toHaveLength(1);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.items).toHaveLength(3);
  });

  it('pages while the pages stay full', async () => {
    const ten = fragment(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    const { ctx, calls } = ctxWith({ [SEARCH]: serve(ten, ten, ten, fragment(['11'])) });

    await walk(ctx, query({ titles: ['Full Stack'], locations: ['Bengaluru'] }));

    // Four is the ceiling per keyword/location pair — past that LinkedIn's
    // ordering has stopped being about the query.
    expect(calls).toHaveLength(4);
    expect(calls.map((call) => new URL(call).searchParams.get('start'))).toEqual([
      '0',
      '10',
      '20',
      '30',
    ]);
  });

  it('counts the page LinkedIn sent, not the cards it kept', async () => {
    const ten = fragment(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10']);
    const { ctx, calls } = ctxWith({ [SEARCH]: serve(ten) });

    const pages = await walk(ctx, query({ titles: ['Full Stack'], locations: ['Bengaluru'] }));

    // The subtle one. Every card after page 1 is a duplicate, so the *kept*
    // count is zero — and a break driven by that would stop the walk the moment
    // one page overlapped the last, on a query where page 3 was still new.
    expect(calls).toHaveLength(4);
    expect(pages.map((page) => page.items.length)).toEqual([10, 0, 0, 0]);
  });

  it('never yields the same posting twice across queries', async () => {
    const { ctx } = ctxWith({ [SEARCH]: serve(fragment(['1', '2'])) });

    const pages = await walk(
      ctx,
      query({ titles: ['Full Stack', 'Backend'], locations: ['Bengaluru'] }),
    );

    // Two searches, the same two postings. The duplicate costs a detail request
    // downstream, which is why it is dropped here rather than at the database.
    const ids = pages.flatMap((page) => page.items.map((card) => card.id));
    expect(ids).toEqual(['1', '2']);
  });
});

/* -------------------------------------------------------------------------- */
/* Refusal                                                                    */
/* -------------------------------------------------------------------------- */

describe('pages — when LinkedIn says no', () => {
  it('names a challenge served with a 403 instead of retrying it', async () => {
    const { ctx, calls } = ctxWith({
      [SEARCH]: () =>
        new Response('<html><head><title>Just a moment...</title></head></html>', { status: 403 }),
    });

    const pages = await walk(ctx, query({ titles: ['Full Stack'], locations: ['Bengaluru'] }));

    expect(pages).toHaveLength(1);
    expect(pages[0]?.items).toEqual([]);
    expect(pages[0]?.block?.kind).toBe('challenge');
    // Read rather than retried: 403 is an answer, and retrying it spends the
    // budget and the backoff to be told the same thing three more times.
    expect(calls).toHaveLength(1);
  });

  it('turns a rate limit that outlived its retries into a block', async () => {
    const { ctx } = ctxWith({
      [SEARCH]: () => new Response('slow down', { status: 429 }),
    });

    const pages = await walk(ctx, query({ titles: ['Full Stack'], locations: ['Bengaluru'] }));

    // 429 is not in `acceptStatuses`, so it arrives as a thrown `HttpError`.
    // That has to come out as "LinkedIn asked us to stop", not as a crash and
    // not as zero jobs.
    expect(pages[0]?.block?.kind).toBe('rate-limited');
  });

  it('stops the whole walk at the first wall', async () => {
    const { ctx, calls } = ctxWith({
      [SEARCH]: () => new Response('<div class="g-recaptcha"></div>', { status: 200 }),
    });

    await walk(ctx, query({ titles: ['A', 'B', 'C'], locations: ['Bengaluru', 'Pune'] }));

    // Six keyword/location pairs, four pages each. Continuing to hammer a
    // source that has just turned us away is both futile and rude.
    expect(calls).toHaveLength(1);
  });

  it('lets a genuine fault through rather than calling it a block', async () => {
    const { ctx } = ctxWith({
      [SEARCH]: () => new Response('boom', { status: 500 }),
    });

    // A 500 is our problem or theirs, but it is not a refusal — and dressing it
    // up as one would tell the user to lower their threshold when what they
    // actually need is to try again later. `base.ts` logs it as a warning.
    await expect(
      walk(ctx, query({ titles: ['Full Stack'], locations: ['Bengaluru'] })),
    ).rejects.toThrow('HTTP 500');
  });
});

/* -------------------------------------------------------------------------- */
/* Detail                                                                     */
/* -------------------------------------------------------------------------- */

describe('fetchDetail', () => {
  const card = parseCards(searchHtml)[0]!;

  it('promotes a card to a fully-read posting', async () => {
    const { ctx } = ctxWith({
      [DETAIL]: () => new Response(detailHtml, { status: 200 }),
    });
    const job = linkedinAdapter.toRawJob(card, 0)!;

    const detailed = await linkedinAdapter.fetchDetail!(job, ctx);

    expect(detailed.description).toContain('Location: JP Nagar, Bangalore');
    expect(detailed.descriptionIsHtml).toBe(false);
    // The claim that lets this lead clear 85%. It is made here, after the
    // description was actually read, and nowhere earlier.
    expect(detailed.hasFullDescription).toBe(true);
    // LinkedIn's label is prose ("Full-time"); the hard gate compares against a
    // fixed union, so it goes through the normaliser rather than being trusted.
    expect(detailed.employmentType).toBe('fulltime');
  });

  it('keeps the lead when the detail page is refused', async () => {
    const { ctx } = ctxWith({
      [DETAIL]: () => new Response('<html>authwall</html>', { status: 403 }),
    });
    const job = linkedinAdapter.toRawJob(card, 0)!;

    const detailed = await linkedinAdapter.fetchDetail!(job, ctx);

    // Title, company and an apply link is still a usable lead. It just stays
    // low-confidence, which is the honest description of what we know.
    expect(detailed).toEqual(job);
    expect(detailed.hasFullDescription).toBe(false);
  });

  it('keeps the lead when the page loads but has no description in it', async () => {
    const { ctx } = ctxWith({
      [DETAIL]: () =>
        new Response('<html><body>Sign in to see this job</body></html>', { status: 200 }),
    });
    const job = linkedinAdapter.toRawJob(card, 0)!;

    // The failure mode a 200-only check would miss entirely.
    expect(await linkedinAdapter.fetchDetail!(job, ctx)).toEqual(job);
  });
});
