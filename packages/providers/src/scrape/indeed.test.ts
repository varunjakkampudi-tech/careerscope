/**
 * Indeed, and the line its robots.txt draws.
 *
 * Two things are pinned here that are not ordinary parser coverage, because both
 * are promises rather than mechanics:
 *
 *  - **There is no `fetchDetail`.** `Disallow: /viewjob?` is an unambiguous,
 *    machine-readable instruction, and the way a decision like that erodes is
 *    that someone later adds the method to "improve match quality". A test that
 *    asserts its absence turns that into a failing build.
 *  - **`hasFullDescription` is false on every card, always.** It is what caps
 *    these leads at 80%, and it is the reason {@link INDEED_CEILING_NOTE} exists.
 *    A card that claimed otherwise could clear 85% on a 150-character snippet.
 *
 * The rest is the mosaic blob: a JSON object embedded in a `<script>` with more
 * JavaScript after it and no delimiter to match on, so it has to be found by
 * counting braces while tracking string state. The tests below feed it the two
 * inputs that break a naive brace counter — a `}` inside a value, and an escaped
 * quote before one — because both truncate the results *silently*, dropping every
 * card after the offending one while still returning a plausible array.
 */

import type { ProviderQuery } from '@job-radar/shared';
import { describe as suite, expect, it, vi } from 'vitest';
import { query } from '../harness.fixtures.js';
import type { ScrapeContext, ScrapePage } from './base.js';
import { fakeSession, fixture, scrapeContext } from './harness.fixtures.js';
import {
  describe,
  extractCards,
  INDEED_CEILING_NOTE,
  type IndeedCard,
  indeedAdapter,
} from './indeed.js';

const searchHtml = fixture('indeed-search.html');
const cards = extractCards(searchHtml) ?? [];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** A results page shaped like Indeed's, with more script after the blob. */
function mosaic(results: unknown[]): string {
  const blob = JSON.stringify({ metaData: { mosaicProviderJobCardsModel: { results } } });
  return `<html><body><script>
window.mosaic.providerData["mosaic-provider-jobcards"]=${blob};
window.mosaic.providerData["mosaic-provider-other"]={"unrelated":{"nested":true}};
</script></body></html>`;
}

/** `count` minimal cards, ids `job-0`, `job-1`, … */
function stubs(count: number, offset = 0): IndeedCard[] {
  return Array.from({ length: count }, (_, index) => ({
    jobkey: `job-${offset + index}`,
    title: `Role ${offset + index}`,
    company: 'Acme',
    formattedLocation: 'Bengaluru, Karnataka',
  }));
}

/** Replies in order, repeating the last. */
function serve(...bodies: readonly string[]): () => { body: string } {
  let index = 0;
  return () => {
    const body = bodies[Math.min(index, bodies.length - 1)] ?? '';
    index += 1;
    return { body };
  };
}

async function drain(ctx: ScrapeContext, q: ProviderQuery): Promise<Array<ScrapePage<IndeedCard>>> {
  const pages: Array<ScrapePage<IndeedCard>> = [];
  for await (const page of indeedAdapter.pages(ctx, q, 0)) pages.push(page);
  return pages;
}

/* -------------------------------------------------------------------------- */
/* The promise                                                                */
/* -------------------------------------------------------------------------- */

suite('the robots.txt commitment', () => {
  it('has no way to fetch a job detail page', () => {
    // `Disallow: /viewjob?`. Not "we could not work out how" — we are asked not
    // to. This assertion is what makes adding the method later a failing build
    // rather than a quiet quality improvement.
    expect(indeedAdapter.fetchDetail).toBeUndefined();
  });

  it('links to the posting without ever fetching it', () => {
    const job = indeedAdapter.toRawJob(cards[0]!, 0);

    // Linking is a different act from crawling: the user opens this in their own
    // browser, as a person, which robots.txt has nothing to say about.
    expect(job?.sourceUrl).toBe('https://in.indeed.com/viewjob?jk=ee8f6bc9773de524');
  });

  it('never claims to have read a posting', () => {
    // The single field that keeps this source honest. Every card, no exceptions:
    // `LOW_CONFIDENCE_SCORE_CEILING` holds these at 80% because of it.
    expect(cards.map((card) => indeedAdapter.toRawJob(card, 0)?.hasFullDescription)).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('says so out loud, in words a user can act on', () => {
    expect(indeedAdapter.note).toBe(INDEED_CEILING_NOTE);
    // The consequence, not the cause. A note that only said "robots.txt
    // disallows detail pages" would leave the user staring at an empty Indeed
    // column with no idea that the threshold slider is the fix.
    expect(INDEED_CEILING_NOTE).toContain('80%');
    expect(INDEED_CEILING_NOTE).toContain('Lower the threshold');
  });

  it('warns that this source is the one most likely to be turned away', () => {
    // Added after a live run, and the reason is the gap between two true
    // sentences. "Leads cap at 80%" explains an Indeed column full of
    // low-confidence rows; it explains nothing about an Indeed column that is
    // empty because Cloudflare served a security check instead of a results
    // page — which is what a headed browser actually got, on this adapter's own
    // URL, minutes after a near-identical URL returned 2,000 postings.
    //
    // The run log already names a challenge when one fires. This note is the
    // other half: a user choosing sources learns *before* the run that Indeed
    // is the flaky one, rather than inferring it from a result they cannot
    // distinguish from a quiet market.
    expect(INDEED_CEILING_NOTE).toContain('security check');
    expect(INDEED_CEILING_NOTE).toContain('reports the challenge rather than reporting no jobs');
  });
});

/* -------------------------------------------------------------------------- */
/* The mosaic blob                                                            */
/* -------------------------------------------------------------------------- */

suite('extractCards', () => {
  it('reads every card off a real results page', () => {
    expect(cards).toHaveLength(3);
    expect(cards.map((card) => card.jobkey)).toEqual([
      'ee8f6bc9773de524',
      '1f25abbab86d2edf',
      '2bfe358436a48a4b',
    ]);
  });

  it('separates "we could not see the results" from "there were none"', () => {
    // The distinction the whole module turns on. `null` becomes a reported
    // challenge; `[]` becomes an honest empty page. Collapsing them is how a
    // broken parser starts reporting a quiet job market.
    expect(extractCards('<html><body>Cloudflare</body></html>')).toBeNull();
    expect(extractCards(mosaic([]))).toEqual([]);
  });

  it('reports nothing rather than guessing when the blob is unusable', () => {
    const noBrace = '<script>window.mosaic.providerData["mosaic-provider-jobcards"]=</script>';
    const truncated = `<script>window.mosaic.providerData["mosaic-provider-jobcards"]={"metaData":{`;
    const notJson =
      '<script>window.mosaic.providerData["mosaic-provider-jobcards"]={oops};</script>';
    const noResults =
      '<script>window.mosaic.providerData["mosaic-provider-jobcards"]={"a":1};</script>';

    for (const html of [noBrace, truncated, notJson, noResults]) {
      expect(extractCards(html)).toBeNull();
    }
  });

  it('does not end the object on a brace inside a description', () => {
    // The silent-truncation case. A depth counter that ignored string state
    // would close the object at this `}` and return one card instead of three —
    // a plausible-looking result set missing two thirds of the market.
    const html = mosaic([
      { jobkey: 'a', title: 'Dev', company: 'Acme', snippet: 'Template literals: ${name} }' },
      ...stubs(2, 1),
    ]);

    expect(extractCards(html)).toHaveLength(3);
  });

  it('does not leave a string on an escaped quote', () => {
    // The same failure one level subtler: `\"` ends the string for a parser that
    // does not track escaping, and the `}` that follows then reads as structural.
    const html = mosaic([
      { jobkey: 'a', title: 'Dev', company: 'Acme', snippet: 'They said "ship it" } now' },
      ...stubs(2, 1),
    ]);

    expect(extractCards(html)).toHaveLength(3);
  });

  it('stops at the end of its own object, not the end of the script', () => {
    const parsed = extractCards(mosaic(stubs(1)));

    // There is more JavaScript after the blob and no delimiter between them, so
    // over-reading is as easy as under-reading and fails in exactly the same way.
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]?.jobkey).toBe('job-0');
  });
});

/* -------------------------------------------------------------------------- */
/* Turning Indeed's own tags into demands                                     */
/* -------------------------------------------------------------------------- */

suite('describe', () => {
  it('writes preferred skills under the heading the engine already parses', () => {
    // Card 1's five tags are all `strictness: "preferred"`. Indeed has done the
    // extraction; re-deriving it from a 300-character snippet would be strictly
    // worse evidence, so the labels are written back out where `extract.ts`
    // reads them — and weighted 0.5, not 1.0.
    const text = describe(cards[0]!);

    expect(text).toContain('Preferred: Angular, Java, HTML, CSS, JavaScript.');
    expect(text).not.toContain('Requirements:');
    // The snippet still leads — it is the only prose on the card.
    expect(text.startsWith('- 1-3 years of experience in full-stack development.')).toBe(true);
  });

  it('weights a required tag at full strength', () => {
    const text = describe({
      snippet: 'Own the platform.',
      jobCardRequirementsModel: {
        jobOnlyRequirements: [
          { label: 'TypeScript', strictness: 'required' },
          { label: 'Kubernetes' },
          { label: 'Figma', strictness: 'preferred' },
        ],
      },
    });

    // Anything not explicitly `preferred` counts as required — a missing
    // strictness is Indeed being terse, not Indeed saying "optional".
    expect(text).toContain('Requirements: TypeScript, Kubernetes.');
    expect(text).toContain('Preferred: Figma.');
  });

  it('falls back to the match summary only when there are no structured tags', () => {
    // Card 2 has an empty `jobOnlyRequirements`, so its 42 skills come from the
    // flatter summary model. That list has no strictness, so it lands as
    // required — the conservative reading, since treating an unknown demand as
    // optional would inflate the score.
    const text = describe(cards[1]!);

    expect(cards[1]?.jobCardRequirementsModel?.jobOnlyRequirements ?? []).toEqual([]);
    expect(text).toContain('Requirements: .NET, APIs, AWS,');
    expect(text).toContain('Vue.js, WordPress, iOS.');
  });

  it('never duplicates the structured tags with the summary', () => {
    const text = describe({
      jobCardRequirementsModel: { jobOnlyRequirements: [{ label: 'Go', strictness: 'preferred' }] },
      jobSeekerMatchSummaryModel: { sortedMatchingEntityDisplayText: ['Go', 'Rust'] },
    });

    // The two models overlap heavily. Emitting both would double-count Go and
    // promote it from preferred to required in the same breath.
    expect(text).toBe('Preferred: Go.');
  });

  it('deduplicates, and says nothing when there is nothing to say', () => {
    expect(
      describe({
        jobCardRequirementsModel: {
          jobOnlyRequirements: [{ label: 'React' }, { label: 'React' }, { label: '  ' }],
        },
      }),
    ).toBe('Requirements: React.');

    // No snippet, no tags, no summary. An empty string rather than a stray
    // heading, because this becomes the `description` field verbatim.
    expect(describe({})).toBe('');
    expect(describe({ jobCardRequirementsModel: { jobOnlyRequirements: [] } })).toBe('');
  });

  it('keeps the list markers in the snippet, because the extractor reads them', () => {
    // `htmlToText` turns `<li>` into "- " and block boundaries into newlines.
    // That is not cosmetic: it is how `extract.ts` tells a requirements list
    // from a paragraph about the company culture.
    const text = describe(cards[2]!);

    expect(text).toContain('- 5+ years of full stack application development experience.');
    expect(text.split('\n\n').length).toBeGreaterThan(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Mapping                                                                    */
/* -------------------------------------------------------------------------- */

suite('toRawJob', () => {
  it('maps a real card whole', () => {
    expect(indeedAdapter.toRawJob(cards[0]!, 0)).toMatchObject({
      source: 'indeed',
      sourceJobId: 'ee8f6bc9773de524',
      title: 'Junior Full Stack Developer',
      companyName: 'Protos',
      location: 'Bangalore City, Bengaluru, Karnataka',
      isRemote: false,
      hasFullDescription: false,
      salaryMin: 400_000,
      salaryMax: 600_000,
      salaryCurrency: 'INR',
      salaryPeriod: 'year',
      salaryRaw: '₹4,00,000 - ₹6,00,000 a year',
      postedAt: '2026-08-14T05:00:00.000Z',
    });
  });

  it('keeps a monthly figure monthly', () => {
    // Twelve times wrong, in the direction that makes the job look worse. The
    // period is carried rather than normalised because the salary schema has a
    // slot for it and the matching engine does the conversion once, centrally.
    expect(indeedAdapter.toRawJob(cards[1]!, 0)).toMatchObject({
      salaryMin: 25_000,
      salaryMax: 30_000,
      salaryPeriod: 'month',
      salaryRaw: '₹25,000 - ₹30,000 a month',
    });
  });

  it('drops a period it does not recognise instead of assuming one', () => {
    const job = indeedAdapter.toRawJob(
      {
        jobkey: 'x',
        title: 'Dev',
        company: 'Acme',
        extractedSalary: { min: 1_000, max: 2_000, type: 'FORTNIGHTLY' },
        salarySnippet: { currency: 'INR', text: '₹1,000 - ₹2,000 a fortnight' },
      },
      0,
    );

    // The raw text survives so the user still sees the number; the structured
    // fields stay empty so nothing downstream computes with a unit we guessed.
    expect(job).toMatchObject({ salaryRaw: '₹1,000 - ₹2,000 a fortnight' });
    expect(job?.salaryMin).toBeUndefined();
    expect(job?.salaryPeriod).toBeUndefined();
  });

  it('says nothing about pay when Indeed extracted nothing', () => {
    const job = indeedAdapter.toRawJob(cards[2]!, 0);

    // Card 3 is a real posting with no salary anywhere. Undisclosed scores 0.6 —
    // neutral — so inventing a zero here would actively penalise it.
    expect(job?.salaryMin).toBeUndefined();
    expect(job?.salaryRaw).toBeUndefined();
    expect(job?.salaryCurrency).toBeUndefined();
  });

  it('prefers the employer apply link and falls back to the posting', () => {
    expect(indeedAdapter.toRawJob(cards[0]!, 0)?.applyUrl).toContain('/applystart?jk=');

    const bare = indeedAdapter.toRawJob({ jobkey: 'x', title: 'Dev', company: 'Acme' }, 0);
    expect(bare?.applyUrl).toBe('https://in.indeed.com/viewjob?jk=x');
  });

  it('prefers the publication date over the crawl date', () => {
    const job = indeedAdapter.toRawJob(
      {
        jobkey: 'x',
        title: 'Dev',
        company: 'Acme',
        pubDate: Date.parse('2026-08-14T05:00:00.000Z'),
        createDate: Date.parse('2026-08-20T09:30:00.000Z'),
      },
      0,
    );

    // `createDate` is when Indeed indexed it, which can trail the employer's own
    // posting date by days — and recency is a scored dimension.
    expect(job?.postedAt).toBe('2026-08-14T05:00:00.000Z');
  });

  it('reads remote from the flag as well as the text', () => {
    const flagged = indeedAdapter.toRawJob(
      {
        jobkey: 'x',
        title: 'Dev',
        company: 'Acme',
        remoteLocation: true,
        formattedLocation: 'Pune',
      },
      0,
    );
    const worded = indeedAdapter.toRawJob(
      { jobkey: 'y', title: 'Dev', company: 'Acme', formattedLocation: 'Remote in India' },
      0,
    );

    // `remoteOnly` is a hard gate, so a false negative here does not lower a
    // score — it deletes the lead.
    expect(flagged?.isRemote).toBe(true);
    expect(worded?.isRemote).toBe(true);
  });

  it('normalises the employment type when Indeed gives one', () => {
    expect(
      indeedAdapter.toRawJob(
        { jobkey: 'x', title: 'Dev', company: 'Acme', jobTypes: ['Full-time'] },
        0,
      )?.employmentType,
    ).toBe('fulltime');

    // Empty on all three fixture cards, and on all 15 of the live page this was
    // written against — so the common path is to say nothing and let the shared
    // normaliser infer it from the text.
    expect(indeedAdapter.toRawJob(cards[0]!, 0)?.employmentType).toBeUndefined();
  });

  it('refuses a card missing any of the three fields that make it a lead', () => {
    expect(indeedAdapter.toRawJob({ title: 'Dev', company: 'Acme' }, 0)).toBeNull();
    expect(indeedAdapter.toRawJob({ jobkey: 'x', company: 'Acme' }, 0)).toBeNull();
    expect(indeedAdapter.toRawJob({ jobkey: 'x', title: 'Dev' }, 0)).toBeNull();
  });

  it('takes the display title when the plain one is absent', () => {
    const job = indeedAdapter.toRawJob(
      { jobkey: 'x', displayTitle: 'Senior <b>Engineer</b>', company: 'Acme' },
      0,
    );

    // Indeed bolds the matched query terms in `displayTitle`, which is markup we
    // must not carry into a spreadsheet cell.
    expect(job?.title).toBe('Senior Engineer');
  });
});

/* -------------------------------------------------------------------------- */
/* The walk                                                                   */
/* -------------------------------------------------------------------------- */

suite('pages', () => {
  it('will not run without a browser', async () => {
    // A plain HTTP client gets a Cloudflare interstitial here. Failing loudly is
    // better than a suite that quietly proves nothing about the real path.
    await expect(drain(scrapeContext(), query({ titles: ['Dev'] }))).rejects.toThrow(
      'indeed needs a browser session',
    );
  });

  it('asks Indeed to do the recency and remote filtering', async () => {
    const session = fakeSession({ navigate: { '/jobs?': { body: mosaic(stubs(1)) } } });

    await drain(
      scrapeContext(session),
      query({
        titles: ['Full Stack'],
        locations: ['Bengaluru'],
        postedWithinDays: 3,
        remoteOnly: true,
      }),
    );

    const url = new URL(session.navigations[0] ?? '');
    expect(url.searchParams.get('q')).toBe('Full Stack');
    // Remote search, so the city is dropped for the country — an office filter
    // on a work-from-anywhere posting is a contradiction that returns nothing.
    expect(url.searchParams.get('l')).toBe('India');
    expect(url.searchParams.get('fromage')).toBe('3');
    // Indeed's remote facet, by its own attribute id.
    expect(url.searchParams.get('sc')).toBe('0kf:attr(DSQF7);');
  });

  it('walks a real results page', async () => {
    const session = fakeSession({ navigate: { '/jobs?': { body: searchHtml } } });

    const pages = await drain(scrapeContext(session), query({ titles: ['Full Stack'] }));

    // Three cards is a short page, so the query ends after one navigation
    // rather than paying 1.5 s and a browser round trip to be told nothing.
    expect(session.navigations).toHaveLength(1);
    expect(pages.map((page) => page.items.length)).toEqual([3]);
  });

  it('pages while the pages stay full, then stops', async () => {
    vi.useFakeTimers();
    try {
      const session = fakeSession({
        navigate: {
          '/jobs?': serve(mosaic(stubs(10)), mosaic(stubs(10, 10)), mosaic(stubs(3, 20))),
        },
      });

      const walking = drain(scrapeContext(session), query({ titles: ['Full Stack'] }));
      // Fake timers so the courtesy pace between navigations is honoured in the
      // adapter and free in the suite.
      await vi.advanceTimersByTimeAsync(10_000);
      const pages = await walking;

      expect(session.navigations.map((url) => new URL(url).searchParams.get('start'))).toEqual([
        '0',
        '10',
        '20',
      ]);
      expect(pages.map((page) => page.items.length)).toEqual([10, 10, 3]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('yields a posting once, however many searches surface it', async () => {
    const session = fakeSession({ navigate: { '/jobs?': { body: mosaic(stubs(2)) } } });

    const pages = await drain(
      scrapeContext(session),
      query({ titles: ['Full Stack', 'Backend'], locations: ['Bengaluru'] }),
    );

    expect(session.navigations).toHaveLength(2);
    expect(pages.flatMap((page) => page.items.map((card) => card.jobkey))).toEqual([
      'job-0',
      'job-1',
    ]);
  });

  it('calls an unreadable page a failure, not an empty market', async () => {
    const session = fakeSession({
      navigate: { '/jobs?': { body: '<html><body>Results are here somewhere</body></html>' } },
    });

    const pages = await drain(scrapeContext(session), query({ titles: ['A', 'B'] }));

    // The ambiguous case: a 200 with no blob in it is either a layout change or
    // something served in place of the results, and this code cannot tell which.
    // What it can say — and does — is that the search did not run.
    expect(pages).toHaveLength(1);
    expect(pages[0]?.block?.kind).toBe('challenge');
    expect(pages[0]?.block?.message).toContain('this is not an empty market');
    expect(session.navigations).toHaveLength(1);
  });

  it('reports a wall as a wall and stops walking', async () => {
    const session = fakeSession({
      navigate: {
        '/jobs?': { status: 403, body: '<html><title>Just a moment...</title></html>' },
      },
    });

    const pages = await drain(scrapeContext(session), query({ titles: ['A', 'B', 'C'] }));

    expect(pages[0]?.block?.kind).toBe('challenge');
    // Three titles, three pages each. Continuing to knock after being turned
    // away is both futile and rude.
    expect(session.navigations).toHaveLength(1);
  });

  it('stops when the run is cancelled', async () => {
    const controller = new AbortController();
    const session = fakeSession({ navigate: { '/jobs?': { body: mosaic(stubs(1)) } } });
    const ctx = { ...scrapeContext(session), signal: controller.signal };

    controller.abort();
    const pages = await drain(ctx, query({ titles: ['A'] }));

    // Checked before the navigation, not after: the point of cancelling is to
    // not spend the next request.
    expect(pages).toEqual([]);
    expect(session.navigations).toEqual([]);
  });
});
