/**
 * Naukri, through the JSON API its own search page calls.
 *
 * Naukri renders results client-side: the HTML that arrives is a shell, and the
 * postings come from `jobapi/v3/search`, which answers with the same payload the
 * site's own JavaScript consumes. That payload is far better than the rendered
 * markup — 20 postings per page with skills, experience bands, structured
 * salary and an epoch timestamp, none of which has to be scraped back out of a
 * layout that changes whenever their designers feel like it.
 *
 * Everything below was established by probing the live site rather than assumed,
 * and three findings shaped the design:
 *
 * **The API is gated on a per-session `nkparam` header.** A request without it is
 * refused with 406. The token is computed by the page's own JavaScript, so the
 * only honest way to hold one is to load a real search page and let it be issued
 * — which is what {@link bootstrap} does, once. The token then serves *every*
 * later query: different keyword, different location, different page all answer
 * 200 with it. So one navigation buys the whole walk, and pagination costs a
 * plain JSON request through the browser's own request context.
 *
 * **The list payload's description is truncated.** Measured against the detail
 * endpoint: 54 characters became 1,591, and 342 became 2,797, while a posting
 * that was already 2,587 characters was complete. A source that stopped at the
 * list would therefore hand the matching engine a two-line teaser, fail its
 * 400-character floor, and cap a genuinely strong match at 80% — the posting
 * would look mediocre because we only read its first sentence. So short
 * descriptions are completed from `jobapi/v4/job/<id>`, and only those: a
 * posting whose list description already clears the floor is left alone.
 *
 * **The detail token is bound to the posting.** Unlike the search token, one
 * job's `nkparam` will not fetch another's — every cross-job replay returned
 * 406, with and without a matching referer. The page computes it per posting.
 * Reimplementing that computation is exactly the evasion work this tier does not
 * do, so the detail fetch is a real navigation to the public job page, and the
 * response the page loads for itself is read as it arrives. It is the expensive
 * call, which is why `base.ts` spends it only on postings that already survived
 * the filter and fit inside the result budget.
 *
 * Nothing here signs in. Naukri publishes these pages to anonymous visitors, the
 * requests are paced, and the browser is a real one. Where Naukri refuses, the
 * walk stops and says it was refused rather than reporting an empty market.
 */

import { MIN_FULL_DESCRIPTION_CHARS } from '@job-radar/matching';
import type { ProviderQuery, RawJob } from '@job-radar/shared';
import { htmlToText, tidyText } from '../html.js';
import { employmentTypeFrom } from '../normalize.js';
import type { ScrapeAdapter, ScrapeContext, ScrapePage } from './base.js';
import { detectBlock, type BlockDetection } from './block.js';

const ORIGIN = 'https://www.naukri.com';
const SEARCH_API = `${ORIGIN}/jobapi/v3/search`;

/** Naukri's own page size. `noOfResults` above 20 is ignored. */
const PAGE_SIZE = 20;

/**
 * How deep to walk one keyword/location pair.
 *
 * Three pages is 60 postings. Past that the ordering has visibly stopped being
 * about the query — a probe of page 4 came back entirely "30+ Days Ago" — so the
 * next page costs a request and returns staleness. Breadth across the user's
 * other titles is worth more.
 */
const MAX_PAGES_PER_QUERY = 3;

const MAX_TITLES = 3;
const MAX_LOCATIONS = 2;

/**
 * Courtesy gap between API calls.
 *
 * These requests go through the browser's request context, which means they
 * bypass the shared {@link HttpClient} and its per-host pacing. Pacing them here
 * keeps the promise the tier makes elsewhere rather than leaving this one path
 * unthrottled because it happens to take a different route out.
 */
const PACE_MS = 900;

/** A hung detail page must not hold the run open. */
const DETAIL_TIMEOUT_MS = 25_000;

/** Headers the search API needs, minus the ones the browser fills in itself. */
type SessionHeaders = Record<string, string>;

/** One entry of `jobDetails[]`, narrowed to the fields this adapter reads. */
export interface NaukriJob {
  jobId?: string;
  title?: string;
  companyName?: string;
  jobDescription?: string;
  jdURL?: string;
  createdDate?: number;
  tagsAndSkills?: string;
  placeholders?: Array<{ type?: string; label?: string }>;
  salaryDetail?: {
    minimumSalary?: number;
    maximumSalary?: number;
    currency?: string;
    hideSalary?: boolean;
  };
}

export const naukriAdapter: ScrapeAdapter<NaukriJob> = {
  id: 'naukri',
  label: 'Naukri',
  needsBrowser: true,

  async *pages(ctx: ScrapeContext, query: ProviderQuery): AsyncIterable<ScrapePage<NaukriJob>> {
    const session = ctx.session;
    if (!session) throw new Error('naukri needs a browser session');

    const boot = await bootstrap(session, ctx, query);
    if (boot.block) {
      yield { items: [], block: boot.block };
      return;
    }
    let headers = boot.headers;

    // One posting surfaces under several of the user's titles, and each repeat
    // would otherwise cost a detail navigation downstream.
    const seen = new Set<string>();

    for (const params of searchQueries(query)) {
      for (let pageNo = 1; pageNo <= MAX_PAGES_PER_QUERY; pageNo += 1) {
        if (ctx.signal?.aborted) return;

        const url = `${SEARCH_API}?${new URLSearchParams({ ...params, pageNo: String(pageNo) })}`;

        let response = await session.context.request.get(url, { headers });

        // 406 mid-walk means the token aged out rather than that we are blocked.
        // Re-bootstrapping once is cheap and turns a dead run into a live one.
        if (response.status() === 406) {
          const refreshed = await bootstrap(session, ctx, query);
          if (refreshed.block) {
            yield { items: [], block: refreshed.block };
            return;
          }
          headers = refreshed.headers;
          response = await session.context.request.get(url, { headers });
        }

        if (response.status() !== 200) {
          const block = detectBlock('naukri', {
            status: response.status(),
            body: await response.text().catch(() => null),
            url,
          });
          // A refusal we cannot name is still a refusal — never a quiet zero.
          yield {
            items: [],
            block: block ?? {
              kind: 'forbidden',
              message: `naukri answered its search API with HTTP ${response.status()}. The search did not run — this is a refusal, not an empty result.`,
            },
          };
          return;
        }

        const payload = (await response.json()) as {
          jobDetails?: NaukriJob[];
          noOfJobs?: number;
        };
        const batch = payload.jobDetails ?? [];

        const fresh: NaukriJob[] = [];
        for (const job of batch) {
          if (!job.jobId || seen.has(job.jobId)) continue;
          seen.add(job.jobId);
          fresh.push(job);
        }

        yield { items: fresh };

        // A short page is the end of this query's results.
        if (batch.length < PAGE_SIZE) break;
        if (typeof payload.noOfJobs === 'number' && pageNo * PAGE_SIZE >= payload.noOfJobs) break;

        await pace(ctx);
      }
    }
  },

  toRawJob(item: NaukriJob): RawJob | null {
    const title = tidyText(item.title ?? '');
    const companyName = tidyText(item.companyName ?? '');
    const jobId = item.jobId;
    if (!title || !companyName || !jobId) return null;

    const description = item.jobDescription ?? '';
    const location = placeholder(item, 'location');
    const url = item.jdURL ? absolute(item.jdURL) : `${ORIGIN}/job-listings-${jobId}`;

    return {
      source: 'naukri',
      sourceJobId: jobId,
      title,
      companyName,
      ...(location ? { location } : {}),
      isRemote: /\bremote\b|work from home|\bwfh\b/i.test(`${title} ${location ?? ''}`),
      ...(description ? { description, descriptionIsHtml: true } : {}),
      // Whether this holds is re-decided after `fetchDetail` — the list payload
      // truncates, so claiming a full description here would inflate confidence
      // on exactly the postings that were cut short.
      hasFullDescription: isReadable(description),
      ...salaryOf(item),
      ...(postedAt(item.createdDate) ? { postedAt: postedAt(item.createdDate)! } : {}),
      applyUrl: url,
      sourceUrl: url,
    };
  },

  /**
   * Complete a truncated description from the posting's own page.
   *
   * Skipped when the list already gave us something the engine can score
   * against: the detail payload's extra fields — industry, education, a curated
   * skill list — are nice, but none of them is worth a three-second navigation
   * when the description they accompany is one we already have in full.
   */
  async fetchDetail(job: RawJob, ctx: ScrapeContext): Promise<RawJob> {
    if (job.hasFullDescription) return job;

    const session = ctx.session;
    if (!session || ctx.signal?.aborted) return job;

    const { page } = session;

    // Armed before navigating: the page issues this call during load, and a
    // listener attached afterwards would miss it.
    const pending = page.waitForResponse(
      (response) =>
        response.url().includes(`/jobapi/v4/job/${job.sourceJobId}`) && response.status() === 200,
      { timeout: DETAIL_TIMEOUT_MS },
    );

    // `commit` rather than `load`: we want the XHR, not the trailing assets, and
    // waiting for a fully quiet page on a job board is waiting for a while.
    await page.goto(job.sourceUrl, { waitUntil: 'commit' });
    const payload = (await (await pending).json()) as { jobDetails?: NaukriDetail };

    const detail = payload.jobDetails;
    if (!detail) {
      // Both of these returns are the quiet half of a detail fetch: the request
      // succeeded, so `withDetail` never sees an error and never logs one, and
      // the lead simply arrives capped at 80% with no reason attached. Naming
      // them is the difference between "Naukri could not read this posting" and
      // an unexplained low score.
      ctx.log?.({
        level: 'debug',
        source: 'naukri',
        message: `"${job.title}" — naukri answered without a job detail payload, so it keeps the list summary`,
      });
      return job;
    }

    const description = detail.description ?? '';
    if (!isReadable(description)) {
      ctx.log?.({
        level: 'debug',
        source: 'naukri',
        message: `"${job.title}" — naukri's detail payload carried ${description.length} characters, too few to score against`,
      });
      return job;
    }

    // Naukri's own tags, appended so the demand extractor reads them from the
    // one place it already looks.
    const skills = keySkills(detail);
    const website = detail.companyDetail?.websiteUrl?.trim();

    return {
      ...job,
      description: skills ? `${description}\n\n${skills}` : description,
      descriptionIsHtml: true,
      hasFullDescription: true,
      ...(detail.employmentType
        ? { employmentType: employmentTypeFrom(detail.employmentType) }
        : {}),
      // `wfhType` is Naukri's own work-from-home flag; "0" means on-site. Only
      // ever used to turn the flag on, so a posting the list already read as
      // remote is not un-flagged by a field that is often simply unset.
      ...(detail.wfhType && detail.wfhType !== '0' ? { isRemote: true } : {}),
      ...(website ? { companyWebsite: website } : {}),
    };
  },
};

/** The detail payload, narrowed to what is read above. */
interface NaukriDetail {
  description?: string;
  employmentType?: string;
  wfhType?: string;
  companyDetail?: { websiteUrl?: string };
  keySkills?: {
    preferred?: Array<{ label?: string }>;
    other?: Array<{ label?: string }>;
  };
}

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Load one real search page and keep the headers it used.
 *
 * The search API refuses a request without the `nkparam` its page JavaScript
 * mints, so the token has to be observed rather than constructed. Watching the
 * request the page makes for itself is the whole mechanism — nothing is signed,
 * replayed from another session, or reverse-engineered.
 *
 * If the navigation is refused, or no search call is ever made, that is reported
 * as a block: it is the case where Naukri turned us away, and it must not reach
 * the user as "no jobs found".
 */
async function bootstrap(
  session: NonNullable<ScrapeContext['session']>,
  ctx: ScrapeContext,
  query: ProviderQuery,
): Promise<{ headers: SessionHeaders; block?: undefined } | { block: BlockDetection }> {
  const { page } = session;

  let captured: SessionHeaders | null = null;
  const listener = (request: { url(): string; headers(): Record<string, string> }): void => {
    if (captured === null && request.url().startsWith(SEARCH_API)) {
      captured = usableHeaders(request.headers());
    }
  };
  page.on('request', listener);

  try {
    const response = await page.goto(seoSearchUrl(query), { waitUntil: 'domcontentloaded' });

    const block = detectBlock('naukri', {
      status: response?.status() ?? null,
      body: await page.content().catch(() => null),
      url: page.url(),
    });
    if (block) return { block };

    // The page issues its search call shortly after DOM ready. Poll rather than
    // sleep a fixed interval so a fast response is not paid for at the slow rate.
    const deadline = Date.now() + 15_000;
    while (captured === null && Date.now() < deadline) {
      if (ctx.signal?.aborted) break;
      await delay(250);
    }

    if (captured === null) {
      return {
        block: {
          kind: 'challenge',
          message:
            'naukri loaded a page that never ran its own job search, so no results could be read. The search did not run — this is not an empty market.',
        },
      };
    }

    return { headers: captured };
  } finally {
    page.off('request', listener);
  }
}

/**
 * The subset of a captured request's headers worth resending.
 *
 * HTTP/2 pseudo-headers and the `sec-*` family are set by the client and are
 * rejected or ignored if passed explicitly; cookies come from the shared jar on
 * the context, so resending them would only risk contradicting it.
 */
function usableHeaders(headers: Record<string, string>): SessionHeaders {
  const out: SessionHeaders = {};
  for (const [key, value] of Object.entries(headers)) {
    if (/^(?::|sec-|host$|cookie$|content-length$|accept-encoding$)/.test(key)) continue;
    out[key] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Query construction                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Every keyword/location pair to walk, most important first.
 *
 * Locations nest inside titles so the user's primary title is tried everywhere
 * before the second title is tried at all — the result budget is far likelier to
 * run out mid-walk than to survive it, and running out having covered the title
 * they care about is the better failure.
 */
function searchQueries(query: ProviderQuery): Array<Record<string, string>> {
  const titles = query.titles.slice(0, MAX_TITLES);
  const locations = query.remoteOnly ? ['India'] : query.locations.slice(0, MAX_LOCATIONS);

  const out: Array<Record<string, string>> = [];
  for (const title of titles.length > 0 ? titles : ['']) {
    for (const location of locations.length > 0 ? locations : ['India']) {
      const params: Record<string, string> = {
        noOfResults: String(PAGE_SIZE),
        urlType: 'search_by_key_loc',
        searchType: 'adv',
        src: 'directSearch',
        latLong: '',
        keyword: title,
        location: location.toLowerCase(),
      };

      // Naukri's own recency filter, in days. Filtering server-side is the
      // difference between reading three pages of fresh postings and reading
      // three pages to find one: on a probe it took a 15,151-result query down
      // to 1,759, all of them inside the window the local gate would have kept.
      if (query.postedWithinDays > 0) params.jobAge = String(query.postedWithinDays);
      // 2 = "work from home" in Naukri's own facet.
      if (query.remoteOnly) params.wfhType = '2';

      out.push(params);
    }
  }
  return out;
}

/**
 * The human search page to bootstrap from.
 *
 * Naukri's SEO URLs are `<role-slug>-jobs-in-<city>`, and an unrecognised slug
 * still renders a search page rather than a 404 — it just searches for the words
 * in it, which is precisely what we want anyway.
 *
 * The default belongs to the title, not to {@link slug}: a location that
 * slugifies to nothing has to stay *absent*, or the fallback leaks across and
 * builds `software-developer-jobs-in-software-developer` — a real page, and a
 * search for the wrong thing.
 */
export function seoSearchUrl(query: ProviderQuery): string {
  const title = slug(query.titles[0] ?? '') || 'software-developer';
  const location = query.remoteOnly ? '' : slug(query.locations[0] ?? '');
  const path = location ? `${title}-jobs-in-${location}` : `${title}-jobs`;
  return `${ORIGIN}/${path}`;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/* -------------------------------------------------------------------------- */
/* Field mapping                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Salary, when Naukri discloses one.
 *
 * `minimumSalary` and `maximumSalary` are absolute annual rupees — confirmed
 * against twelve disclosed postings, where 200000 rendered as "2-3.5 Lacs PA"
 * and 3000000 as "20-30 Lacs PA" — so they need no unit guessing. The label goes
 * along as `salaryRaw` because it is what the user recognises, and because it is
 * what the normaliser falls back to if the numbers ever stop making sense.
 *
 * `hideSalary` postings return zeros. Those are left absent rather than recorded
 * as ₹0, which the engine treats as undisclosed and therefore neutral.
 */
function salaryOf(item: NaukriJob): Partial<RawJob> {
  const detail = item.salaryDetail;
  const label = placeholder(item, 'salary');
  const undisclosed = !detail || detail.hideSalary === true;

  if (undisclosed || !(detail.minimumSalary || detail.maximumSalary)) return {};

  return {
    ...(detail.minimumSalary ? { salaryMin: detail.minimumSalary } : {}),
    ...(detail.maximumSalary ? { salaryMax: detail.maximumSalary } : {}),
    salaryCurrency: detail.currency || 'INR',
    salaryPeriod: 'year',
    ...(label && !/not disclosed/i.test(label) ? { salaryRaw: label } : {}),
  };
}

/** One of the `placeholders` chips under a card, by kind. */
function placeholder(item: NaukriJob, type: string): string | null {
  const found = item.placeholders?.find((entry) => entry.type === type);
  const label = tidyText(found?.label ?? '');
  return label || null;
}

/**
 * The skills Naukri tagged, appended to the description.
 *
 * The demand extractor reads skills out of description text, and Naukri's tags
 * are a curated list an employer chose — often naming a framework the prose only
 * alludes to. Appending them puts that signal where the extractor already looks
 * instead of adding a parallel path that only one source would use.
 */
function keySkills(detail: NaukriDetail): string | null {
  const labels = [...(detail.keySkills?.preferred ?? []), ...(detail.keySkills?.other ?? [])]
    .map((entry) => tidyText(entry.label ?? ''))
    .filter(Boolean);
  return labels.length > 0 ? `Key skills: ${labels.join(', ')}` : null;
}

/** `createdDate` is epoch milliseconds. Anything else is left absent. */
function postedAt(createdDate: number | undefined): string | null {
  if (typeof createdDate !== 'number' || !Number.isFinite(createdDate)) return null;
  const date = new Date(createdDate);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function absolute(path: string): string {
  return path.startsWith('http') ? path : `${ORIGIN}${path.startsWith('/') ? '' : '/'}${path}`;
}

/**
 * Is there enough description to have scored against?
 *
 * Deliberately the engine's own threshold rather than a number chosen here: this
 * is the test that decides whether a detail navigation is worth making, and it
 * should ask exactly the question the scorer will ask later. Measured on the
 * text, not the markup, because a paragraph of `<div>` wrappers is not content.
 */
function isReadable(html: string): boolean {
  return htmlToText(html).trim().length >= MIN_FULL_DESCRIPTION_CHARS;
}

/* -------------------------------------------------------------------------- */
/* Pacing                                                                     */
/* -------------------------------------------------------------------------- */

async function pace(ctx: ScrapeContext): Promise<void> {
  if (ctx.signal?.aborted) return;
  await delay(PACE_MS);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
