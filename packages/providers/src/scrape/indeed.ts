/**
 * Indeed, from the search results page its robots.txt allows — and no further.
 *
 * ## What robots.txt actually permits
 *
 * Checked live, and it decides the whole shape of this adapter. Under
 * `User-agent: *`, Indeed publishes:
 *
 * ```
 * Allow: /
 * Allow: /*&start=0&   …through…   Allow: /*&start=90&
 * Disallow: /viewjob?
 * ```
 *
 * So the results page — `/jobs?q=…&l=…&start=N` — is allowed and paginated
 * offsets are allowed by name, while **the job detail page is disallowed**. The
 * rules are byte-identical on `www.indeed.com` and `in.indeed.com`.
 *
 * That is an unambiguous, machine-readable instruction, so this source has no
 * `fetchDetail`. Not "we could not work out how" — we are asked not to, and the
 * request is honoured. The one consequence that matters to the user is stated
 * plainly in {@link INDEED_CEILING_NOTE} and surfaces in the run log, because a
 * limitation nobody is told about is indistinguishable from a bug.
 *
 * Linking is a different act from crawling: `sourceUrl` is the ordinary
 * `/viewjob?jk=…` address so the user can open the posting in their browser.
 * Nothing here ever fetches it.
 *
 * ## What the allowed page gives us
 *
 * More than expected. Indeed renders its cards from a JSON blob assigned to
 * `window.mosaic.providerData["mosaic-provider-jobcards"]`, and each card carries
 * — verified across a live page of 15 — a structured salary (`{min, max, type}`),
 * an epoch timestamp, a remote flag, and, on every single card, Indeed's own
 * extraction of the skills the posting demands, **tagged required or preferred**
 * (`jobCardRequirementsModel.jobOnlyRequirements[].strictness`). That maps
 * directly onto the matching engine's own required/preferred weighting, so those
 * labels are folded into the description text where the demand extractor already
 * reads — better evidence than parsing the same facts back out of prose.
 *
 * What it does *not* give us is the job description: `snippet` measured 113–161
 * characters across those 15 cards, well under the engine's 400-character floor.
 * So `hasFullDescription` stays false and these leads are honestly capped at 80%.
 *
 * ## Cloudflare, and why this source is the least reliable of the three
 *
 * A real browser is necessary here and — measured, not assumed — **not always
 * sufficient**. On a live run, headed Chrome asking for this adapter's own URL
 * came back HTTP 403 on `/jobs?q=Full+Stack+Developer&l=Bengaluru&fromage=30`,
 * redirected to a `__cf_chl_rt_tk` challenge token, titled "Security Check -
 * Indeed.com", with no mosaic blob in the body. Minutes earlier a slightly
 * different URL for the same query had returned 200 and 2,000 real postings.
 * Disabling this pool's resource blocking changed nothing — the same URL was
 * challenged with every request type allowed through — which rules out the
 * self-inflicted cause that turned out to be behind Naukri's silence.
 *
 * So the wall is Indeed's, it is real, and it is at least partly stochastic.
 * The response to that is to *stop*: the obvious next move is to keep varying
 * the request until one shape gets through, and that is bot-detection evasion
 * however ordinary the parameters look. {@link detectBlock} names the challenge
 * and `base.ts` reports it as a block, so a challenged run says "indeed
 * challenged us" rather than quietly reporting an empty market — which is the
 * whole difference between a source that is down and a city with no jobs in it.
 */

import type { ProviderQuery, RawJob } from '@job-radar/shared';
import { htmlToText, tidyText } from '../html.js';
import { employmentTypeFrom } from '../normalize.js';
import type { ScrapeAdapter, ScrapeContext, ScrapePage } from './base.js';
import { detectBlock } from './block.js';

/**
 * India's Indeed domain. The app is built around an India-based job search — the
 * browser runs `en-IN`/`Asia/Kolkata` for the same reason — and `in.indeed.com`
 * is where those postings are indexed.
 */
const ORIGIN = 'https://in.indeed.com';

/** Indeed's own page size; `start` moves in tens. */
const PAGE_SIZE = 10;

/**
 * How deep to walk one keyword/location pair.
 *
 * robots.txt names offsets up to `start=90`, so ten pages would be within the
 * letter of it. Three is what we take: the tail of an Indeed result set is
 * mostly re-ranked duplicates of the head, and each page here costs a full
 * browser navigation rather than a cheap JSON call.
 */
const MAX_PAGES_PER_QUERY = 3;

const MAX_TITLES = 3;
const MAX_LOCATIONS = 2;

/** Courtesy gap between navigations. */
const PACE_MS = 1_500;

/**
 * Said once per run, in the run log, whenever Indeed returns anything.
 *
 * Without it the failure is silent and completely misleading: Indeed produces
 * leads, every one is capped at 80% because we are not permitted to read the
 * full posting, and at the default 85% threshold they all vanish — leaving a
 * source that looks like it found nothing. That is precisely the "confident
 * empty answer" this tier exists to refuse.
 */
export const INDEED_CEILING_NOTE =
  "indeed's robots.txt disallows its job detail pages, so only the search-results summary is read. Those leads are marked low-confidence and capped at 80%, which means they will not appear above an 85% match threshold. Lower the threshold to see them. Indeed also sits behind Cloudflare and sometimes answers with a security check even for an ordinary browser; when that happens this source reports the challenge rather than reporting no jobs.";

/** One entry of the mosaic results array, narrowed to the fields read here. */
export interface IndeedCard {
  jobkey?: string;
  title?: string;
  displayTitle?: string;
  company?: string;
  formattedLocation?: string;
  snippet?: string;
  pubDate?: number;
  createDate?: number;
  remoteLocation?: boolean;
  jobTypes?: string[];
  thirdPartyApplyUrl?: string;
  extractedSalary?: { min?: number; max?: number; type?: string };
  salarySnippet?: { currency?: string; text?: string };
  jobCardRequirementsModel?: {
    jobOnlyRequirements?: Array<{ label?: string; strictness?: string }>;
  };
  jobSeekerMatchSummaryModel?: {
    sortedMisMatchingEntityDisplayText?: string[];
    sortedMatchingEntityDisplayText?: string[];
  };
}

export const indeedAdapter: ScrapeAdapter<IndeedCard> = {
  id: 'indeed',
  label: 'Indeed',
  needsBrowser: true,
  note: INDEED_CEILING_NOTE,

  async *pages(ctx: ScrapeContext, query: ProviderQuery): AsyncIterable<ScrapePage<IndeedCard>> {
    const session = ctx.session;
    if (!session) throw new Error('indeed needs a browser session');
    const { page } = session;

    // One posting surfaces under several of the user's titles.
    const seen = new Set<string>();

    for (const base of searchUrls(query)) {
      for (let index = 0; index < MAX_PAGES_PER_QUERY; index += 1) {
        if (ctx.signal?.aborted) return;

        const url = `${base}&start=${index * PAGE_SIZE}`;
        const response = await page.goto(url, { waitUntil: 'domcontentloaded' });
        const html = await page.content();

        const block = detectBlock('indeed', {
          status: response?.status() ?? null,
          body: html,
          url: page.url(),
        });
        if (block) {
          yield { items: [], block };
          return;
        }

        const cards = extractCards(html);

        // A results page that parses to nothing is ambiguous — an empty query or
        // a layout we no longer recognise — and the two need different words.
        // Saying which is not possible from here, so say that.
        if (cards === null) {
          yield {
            items: [],
            block: {
              kind: 'challenge',
              message:
                'indeed returned a page this app could not read — its results markup has changed, or something was served in place of the results. Either way the search did not run, so this is not an empty market.',
            },
          };
          return;
        }

        const fresh: IndeedCard[] = [];
        for (const card of cards) {
          if (!card.jobkey || seen.has(card.jobkey)) continue;
          seen.add(card.jobkey);
          fresh.push(card);
        }

        yield { items: fresh };

        // A short page is the end of this query's results.
        if (cards.length < PAGE_SIZE) break;

        await pace(ctx);
      }
    }
  },

  toRawJob(card: IndeedCard): RawJob | null {
    const title = tidyText(htmlToText(card.title ?? card.displayTitle ?? ''));
    const company = tidyText(card.company ?? '');
    const jobkey = card.jobkey;
    if (!title || !company || !jobkey) return null;

    const location = tidyText(card.formattedLocation ?? '');
    const posted = card.pubDate ?? card.createDate;
    const type = employmentType(card);

    return {
      source: 'indeed',
      sourceJobId: jobkey,
      title,
      companyName: company,
      ...(location ? { location } : {}),
      isRemote: card.remoteLocation === true || /\bremote\b/i.test(location),
      ...(type ? { employmentType: type } : {}),
      description: describe(card),
      descriptionIsHtml: false,
      // Never true for this source. The detail page is robots-disallowed, so a
      // posting here is only ever summarised — see INDEED_CEILING_NOTE.
      hasFullDescription: false,
      ...salaryOf(card),
      ...(posted ? { postedAt: new Date(posted).toISOString() } : {}),
      // Linked for the user to open, never fetched by this app.
      applyUrl: card.thirdPartyApplyUrl?.trim() || `${ORIGIN}/viewjob?jk=${jobkey}`,
      sourceUrl: `${ORIGIN}/viewjob?jk=${jobkey}`,
    };
  },

  // No `fetchDetail`, deliberately. `Disallow: /viewjob?` — see the header.
};

/* -------------------------------------------------------------------------- */
/* Query construction                                                         */
/* -------------------------------------------------------------------------- */

function searchUrls(query: ProviderQuery): string[] {
  const titles = query.titles.slice(0, MAX_TITLES);
  const locations = query.remoteOnly ? ['India'] : query.locations.slice(0, MAX_LOCATIONS);

  const urls: string[] = [];
  for (const title of titles.length > 0 ? titles : ['']) {
    for (const location of locations.length > 0 ? locations : ['India']) {
      const params = new URLSearchParams({ q: title, l: location });

      // Indeed's own recency filter, in days. Filtering server-side means three
      // pages of postings inside the window rather than three pages to find one.
      if (query.postedWithinDays > 0) params.set('fromage', String(query.postedWithinDays));
      // Indeed's remote facet, by its own attribute id.
      if (query.remoteOnly) params.set('sc', '0kf:attr(DSQF7);');

      urls.push(`${ORIGIN}/jobs?${params.toString()}`);
    }
  }
  return urls;
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                    */
/* -------------------------------------------------------------------------- */

const MOSAIC_ASSIGNMENT = /window\.mosaic\.providerData\[["']mosaic-provider-jobcards["']\]\s*=\s*/;

/**
 * The cards Indeed's own client renders from.
 *
 * Returns `null` — distinct from `[]` — when the blob is missing or unreadable,
 * because those mean "we could not see the results", while an empty array means
 * "there were none". Collapsing the two is how a broken parser starts reporting
 * a quiet job market.
 */
export function extractCards(html: string): IndeedCard[] | null {
  const marker = MOSAIC_ASSIGNMENT.exec(html);
  if (!marker) return null;

  const start = html.indexOf('{', marker.index + marker[0].length);
  if (start === -1) return null;

  const json = sliceObject(html, start);
  if (json === null) return null;

  try {
    const parsed = JSON.parse(json) as {
      metaData?: { mosaicProviderJobCardsModel?: { results?: IndeedCard[] } };
    };
    return parsed.metaData?.mosaicProviderJobCardsModel?.results ?? null;
  } catch {
    return null;
  }
}

/**
 * The complete JSON object beginning at `start`.
 *
 * The blob is embedded in a `<script>` and followed by more JavaScript, so there
 * is no delimiter to match on — the object has to be found by counting its own
 * braces. String state is tracked because a description containing `}` would
 * otherwise close the object early and truncate every card after it.
 */
function sliceObject(html: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < html.length; index += 1) {
    const char = html[index];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }

  // Unbalanced: the page was truncated mid-blob. Parsing the fragment would
  // throw anyway, and half a result set is worse than a reported failure.
  return null;
}

/* -------------------------------------------------------------------------- */
/* Field mapping                                                              */
/* -------------------------------------------------------------------------- */

/**
 * What this posting asks for, as text the demand extractor can read.
 *
 * Indeed has already done the extraction — every card carries its skill list
 * split into required and preferred — so rather than re-deriving that from a
 * 150-character snippet, the labels are written back out under the headings
 * `extract.ts` already parses (`Requirements:` / `Preferred:`). The engine then
 * weights them 1.0 and 0.5 exactly as it would for a JD that spelled them out.
 *
 * This is a summary, not a description, and it is never presented as one:
 * `hasFullDescription` stays false regardless of how much lands here.
 */
export function describe(card: IndeedCard): string {
  const parts: string[] = [];

  const snippet = tidyText(htmlToText(card.snippet ?? ''));
  if (snippet) parts.push(snippet);

  const required: string[] = [];
  const preferred: string[] = [];
  for (const item of card.jobCardRequirementsModel?.jobOnlyRequirements ?? []) {
    const label = tidyText(item.label ?? '');
    if (!label) continue;
    (item.strictness === 'preferred' ? preferred : required).push(label);
  }

  // The match summary is a flatter list without strictness, so it only fills in
  // when the structured requirements are absent — never duplicating them.
  if (required.length === 0 && preferred.length === 0) {
    const summary = card.jobSeekerMatchSummaryModel;
    const flat = [
      ...(summary?.sortedMatchingEntityDisplayText ?? []),
      ...(summary?.sortedMisMatchingEntityDisplayText ?? []),
    ]
      .map((entry) => tidyText(entry))
      .filter(Boolean);
    if (flat.length > 0) required.push(...flat);
  }

  if (required.length > 0) parts.push(`Requirements: ${unique(required).join(', ')}.`);
  if (preferred.length > 0) parts.push(`Preferred: ${unique(preferred).join(', ')}.`);

  return parts.join('\n\n');
}

/** Indeed's period vocabulary, mapped onto the shared salary schema's. */
const PERIODS: Record<string, NonNullable<RawJob['salaryPeriod']>> = {
  YEARLY: 'year',
  MONTHLY: 'month',
  WEEKLY: 'week',
  DAILY: 'day',
  HOURLY: 'hour',
};

/**
 * Salary, when Indeed extracted one.
 *
 * `extractedSalary` is already structured and already carries its own period, so
 * there is nothing to infer. An unrecognised period is dropped rather than
 * guessed at — a monthly figure annualised as though it were yearly would be
 * wrong by twelve times, in the direction that makes a job look worse.
 */
function salaryOf(card: IndeedCard): Partial<RawJob> {
  const extracted = card.extractedSalary;
  const raw = tidyText(card.salarySnippet?.text ?? '');

  if (!extracted || !(extracted.min || extracted.max)) {
    return raw ? { salaryRaw: raw } : {};
  }

  const period = PERIODS[(extracted.type ?? '').toUpperCase()];
  if (!period) return raw ? { salaryRaw: raw } : {};

  return {
    ...(extracted.min ? { salaryMin: extracted.min } : {}),
    ...(extracted.max ? { salaryMax: extracted.max } : {}),
    salaryCurrency: card.salarySnippet?.currency || 'INR',
    salaryPeriod: period,
    ...(raw ? { salaryRaw: raw } : {}),
  };
}

/**
 * Indeed's `jobTypes` array, when populated.
 *
 * Frequently empty — it was on all 15 cards of the page this was written
 * against — in which case nothing is returned and `normalizeJob` falls back to
 * detecting the type from the posting text, which is the same path every other
 * source uses when a board stays quiet.
 */
function employmentType(card: IndeedCard): RawJob['employmentType'] {
  const first = card.jobTypes?.find((entry) => entry.trim().length > 0);
  return first ? employmentTypeFrom(first) : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function pace(ctx: ScrapeContext): Promise<void> {
  if (ctx.signal?.aborted) return;
  await new Promise((resolve) => {
    setTimeout(resolve, PACE_MS);
  });
}
