/**
 * LinkedIn, through the endpoints it serves to logged-out visitors.
 *
 * LinkedIn renders job search for people who are not signed in, and the markup
 * it hands them comes from two endpoints that answer a plain HTTP client with no
 * key, no cookie and no browser:
 *
 * - `/jobs-guest/jobs/api/seeMoreJobPostings/search` — an HTML fragment of ten
 *   `<li>` cards per page, offset by `start`, each carrying the posting id in
 *   `data-entity-urn`.
 * - `/jobs-guest/jobs/api/jobPosting/<id>` — one posting's public detail, with
 *   the full description inside `show-more-less-html__markup` and a criteria
 *   list giving seniority and employment type.
 *
 * Both were verified live while this was written: the search fragment returned
 * 10 cards in 28 KB, the detail endpoint 2,475 characters of real description in
 * 62 KB, and `start=0` versus `start=10` returned disjoint id sets, so
 * pagination is a plain offset rather than a cursor.
 *
 * Two consequences worth stating, because they shaped the rest of the tier:
 *
 * **This source needs no browser.** It runs on the same {@link HttpClient} as the
 * ATS boards, which means it inherits retry with `Retry-After`, per-host pacing,
 * response caching and in-flight de-duplication, and it can be tested against
 * saved fixtures instead of a live site. It also means enabling LinkedIn does not
 * pull in Playwright.
 *
 * **Its leads are not confidence-capped.** Because the detail endpoint returns
 * the real description, a LinkedIn posting can legitimately clear the 85%
 * threshold — unlike a snippet-only source, which `LOW_CONFIDENCE_SCORE_CEILING`
 * holds at 80% by construction.
 *
 * Nothing here impersonates a signed-in member. The requests carry the app's own
 * user agent, are paced by the shared client, and read only what LinkedIn
 * publishes to anonymous visitors. When LinkedIn refuses — an auth wall, a 403,
 * a 429 that outlives its retries — the walk stops and reports being blocked
 * rather than reporting an empty market.
 */

import type { ProviderQuery, RawJob } from '@job-radar/shared';
import { htmlToText, tidyText } from '../html.js';
import { HttpError } from '../http.js';
import { employmentTypeFrom } from '../normalize.js';
import type { ScrapeAdapter, ScrapeContext, ScrapePage } from './base.js';
import { detectBlock } from './block.js';

const SEARCH_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';
const DETAIL_URL = 'https://www.linkedin.com/jobs-guest/jobs/api/jobPosting';
const VIEW_URL = 'https://www.linkedin.com/jobs/view';

/** Cards per response. LinkedIn's page size, not ours — `start` moves in tens. */
const PAGE_SIZE = 10;

/**
 * How deep to walk one keyword/location pair before moving to the next.
 *
 * Four pages is 40 postings, which is past the point where LinkedIn's relevance
 * ordering has stopped being about the query. Breadth across the user's other
 * target titles is worth more than depth into one of them.
 */
const MAX_PAGES_PER_QUERY = 4;

/**
 * Ceilings on the query fan-out. A profile with six target titles and four
 * preferred locations is 24 combinations, and at four pages each that is 96
 * requests for one source — far past courteous, and mostly duplicates of each
 * other. Titles are ordered by the user's own preference, so taking the first
 * few takes the ones they care about.
 */
const MAX_TITLES = 3;
const MAX_LOCATIONS = 2;

/** A parsed search card, before it becomes a `RawJob`. */
export interface LinkedInCard {
  id: string;
  title: string;
  company: string;
  companyUrl: string | null;
  location: string | null;
  postedAt: string | null;
  applyUrl: string | null;
}

export const linkedinAdapter: ScrapeAdapter<LinkedInCard> = {
  id: 'linkedin',
  label: 'LinkedIn',
  needsBrowser: false,

  async *pages(ctx: ScrapeContext, query: ProviderQuery): AsyncIterable<ScrapePage<LinkedInCard>> {
    // One posting can surface under several of the user's titles. Skipping the
    // repeat here matters more than it would elsewhere, because each survivor
    // costs a detail request downstream.
    const seen = new Set<string>();

    for (const url of searchUrls(query)) {
      for (let page = 0; page < MAX_PAGES_PER_QUERY; page += 1) {
        if (ctx.signal?.aborted) return;

        const target = `${url}&start=${page * PAGE_SIZE}`;

        let html: string;
        try {
          const response = await ctx.http.get(target, {
            ...(ctx.signal ? { signal: ctx.signal } : {}),
            headers: { accept: 'text/html' },
            // 403 and 451 are answers, not faults: retrying them wastes the
            // budget and the backoff. Read them so the block can be named.
            acceptStatuses: [403, 451],
          });

          const block = detectBlock('linkedin', {
            status: response.status,
            body: response.body,
            url: response.url,
          });
          if (block) {
            yield { items: [], block };
            return;
          }

          html = response.body;
        } catch (error) {
          // A 429 that survived the client's `Retry-After` backoff is LinkedIn
          // telling us to stop, which is a block rather than a bug.
          const block =
            error instanceof HttpError
              ? detectBlock('linkedin', { status: error.status ?? null, body: error.body ?? null })
              : null;
          if (block) {
            yield { items: [], block };
            return;
          }
          throw error;
        }

        const cards = parseCards(html).filter((card) => !seen.has(card.id));
        for (const card of cards) seen.add(card.id);

        yield { items: cards };

        // A short page is the end of the result set — LinkedIn pads to ten
        // whenever there is more.
        if (countCards(html) < PAGE_SIZE) break;
      }
    }
  },

  toRawJob(card: LinkedInCard): RawJob | null {
    if (!card.title || !card.company) return null;

    return {
      source: 'linkedin',
      sourceJobId: card.id,
      title: card.title,
      companyName: card.company,
      ...(card.location ? { location: card.location } : {}),
      isRemote: /\bremote\b/i.test(card.location ?? ''),
      // The card carries no description at all. Until `fetchDetail` runs, this
      // posting is capped at 80% — which is the correct claim to make about it.
      hasFullDescription: false,
      ...(card.postedAt ? { postedAt: card.postedAt } : {}),
      ...(card.applyUrl ? { applyUrl: card.applyUrl } : {}),
      sourceUrl: `${VIEW_URL}/${card.id}`,
      ...(card.companyUrl ? { companyLinkedinUrl: card.companyUrl } : {}),
    };
  },

  async fetchDetail(job: RawJob, ctx: ScrapeContext): Promise<RawJob> {
    const response = await ctx.http.get(`${DETAIL_URL}/${job.sourceJobId}`, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      headers: { accept: 'text/html' },
      acceptStatuses: [403, 404, 451],
    });

    // A refused or missing detail page leaves the card as it was. The lead is
    // still usable — title, company, apply link — it just stays low-confidence.
    if (response.status !== 200) return job;

    const description = extractDescription(response.body);
    if (!description) return job;

    const criteria = extractCriteria(response.body);

    return {
      ...job,
      description,
      descriptionIsHtml: false,
      hasFullDescription: true,
      // LinkedIn's label is prose ("Full-time", "Contract"). The hard gate
      // compares against a fixed union, so it goes through the same normaliser
      // every other source uses rather than being trusted as-is.
      ...(criteria.employmentType
        ? { employmentType: employmentTypeFrom(criteria.employmentType) }
        : {}),
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Query construction                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every keyword/location pair to walk, most important first.
 *
 * The endpoint takes one keyword string and one location, so a profile with
 * several target titles becomes several searches. Locations come second in the
 * nesting so that the first title is tried everywhere before the second title is
 * tried at all — the budget is far likelier to run out mid-walk than to survive
 * it, and running out having covered the user's primary title is the better
 * failure.
 */
function searchUrls(query: ProviderQuery): string[] {
  const titles = query.titles.slice(0, MAX_TITLES);
  const locations = query.remoteOnly ? ['India'] : query.locations.slice(0, MAX_LOCATIONS);

  const urls: string[] = [];
  for (const title of titles.length > 0 ? titles : ['']) {
    for (const location of locations.length > 0 ? locations : ['India']) {
      const params = new URLSearchParams({ keywords: title, location });

      // LinkedIn's own recency filter, in seconds. Filtering server-side is the
      // difference between reading four pages of matches and reading four pages
      // to find one — the local recency gate would discard the rest anyway.
      if (query.postedWithinDays > 0) {
        params.set('f_TPR', `r${query.postedWithinDays * 86_400}`);
      }
      // 2 = "Remote" in LinkedIn's workplace-type facet.
      if (query.remoteOnly) params.set('f_WT', '2');

      urls.push(`${SEARCH_URL}?${params.toString()}`);
    }
  }
  return urls;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The posting id is the anchor for everything else.
 *
 * Splitting on the urn rather than on `<li>` is deliberate: the urn is a
 * contract — it is what LinkedIn's own client reads to identify a posting — while
 * the surrounding element names are presentation and have changed before. A card
 * with no urn is not a card.
 */
const CARD_SPLIT = /data-entity-urn="urn:li:jobPosting:(\d+)"/g;

function countCards(html: string): number {
  return html.match(/data-entity-urn="urn:li:jobPosting:\d+"/g)?.length ?? 0;
}

export function parseCards(html: string): LinkedInCard[] {
  const cards: LinkedInCard[] = [];

  // Each card's markup runs from its urn to the next one — or to the end for the
  // last. Matching per-field inside that slice keeps one malformed card from
  // stealing the next card's title.
  const matches = [...html.matchAll(CARD_SPLIT)];
  for (const [index, match] of matches.entries()) {
    const id = match[1];
    if (!id) continue;

    const start = match.index;
    const end = matches[index + 1]?.index ?? html.length;
    const slice = html.slice(start, end);

    const title = text(slice, /class="[^"]*base-search-card__title[^"]*"[^>]*>([\s\S]*?)</);
    const company =
      text(slice, /class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)<\/a>/) ||
      text(slice, /class="[^"]*base-search-card__subtitle[^"]*"[^>]*>([\s\S]*?)</);
    const location = text(slice, /class="[^"]*job-search-card__location[^"]*"[^>]*>([\s\S]*?)</);

    if (!title || !company) continue;

    cards.push({
      id,
      title,
      company,
      companyUrl: stripTracking(
        attr(slice, /class="[^"]*hidden-nested-link[^"]*"[^>]*href="([^"]+)"/),
      ),
      location: location || null,
      postedAt: attr(slice, /<time[^>]*datetime="([^"]+)"/),
      applyUrl: stripTracking(
        attr(slice, /class="[^"]*base-card__full-link[^"]*"[^>]*href="([^"]+)"/),
      ),
    });
  }

  return cards;
}

/** The description block LinkedIn shows anonymous visitors, as plain text. */
export function extractDescription(html: string): string | null {
  const open = /<div[^>]*class="[^"]*show-more-less-html__markup[^"]*"[^>]*>/.exec(html);
  if (!open) return null;

  const inner = sliceBalanced(html, open.index + open[0].length);
  if (!inner) return null;

  // `htmlToText` rather than a tag strip: it keeps block boundaries as newlines
  // and `<li>` as "- ", which is exactly what the demand extractor reads to tell
  // a requirements list from a paragraph about the company.
  const text_ = htmlToText(inner);
  return text_.length > 0 ? text_ : null;
}

/**
 * Everything up to the `</div>` that closes the one already open at `from`.
 *
 * A non-greedy match to the first `</div>` is the obvious implementation and is
 * wrong for exactly the postings that matter most: a JD laid out with nested
 * markup gets silently truncated at its first inner block, and a half-read
 * description still sets `hasFullDescription: true` — so a job we only partly
 * understood would be free to claim a 90% match. Counting the nesting is a dozen
 * lines and removes that whole class of quiet wrongness.
 */
function sliceBalanced(html: string, from: number): string | null {
  const tags = /<div\b|<\/div>/g;
  tags.lastIndex = from;

  let depth = 1;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[0] === '</div>' ? -1 : 1;
    if (depth === 0) return html.slice(from, match.index);
  }
  // Unclosed. Take what is there rather than dropping a real description over a
  // missing tag — LinkedIn's fragments are machine-generated, but not promised.
  return html.slice(from) || null;
}

/**
 * Seniority and employment type from the criteria list under the description.
 *
 * Seniority is read but not returned: the matching engine derives its own from
 * the title and the description, and LinkedIn's four-rung scale ("Mid-Senior
 * level") does not map cleanly onto it. Employment type does map, so it is
 * passed through to the hard gate.
 */
export function extractCriteria(html: string): { employmentType: string | null } {
  const items = [
    ...html.matchAll(
      /description__job-criteria-subheader[^"]*"[^>]*>([\s\S]*?)<\/h3>[\s\S]*?description__job-criteria-text[^"]*"[^>]*>([\s\S]*?)<\//g,
    ),
  ];

  let employmentType: string | null = null;
  for (const [, rawLabel, rawValue] of items) {
    const label = tidyText(htmlToText(rawLabel ?? '')).toLowerCase();
    const value = tidyText(htmlToText(rawValue ?? ''));
    if (label.includes('employment type') && value) employmentType = value;
  }

  return { employmentType };
}

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

function text(html: string, pattern: RegExp): string {
  const match = pattern.exec(html);
  return match?.[1] ? tidyText(htmlToText(match[1])) : '';
}

function attr(html: string, pattern: RegExp): string | null {
  const match = pattern.exec(html);
  return match?.[1] ? match[1].trim() : null;
}

/**
 * Drop the query string from an apply link.
 *
 * LinkedIn appends `refId`, `trackingId` and a search position to every card
 * link. None of it is needed to open the posting, all of it makes two links to
 * the same job look different, and it is a per-session identifier we have no
 * reason to store in a database or write into an export.
 */
function stripTracking(url: string | null): string | null {
  if (!url) return null;
  const cut = url.indexOf('?');
  return cut === -1 ? url : url.slice(0, cut);
}
