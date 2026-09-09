/**
 * JSearch, via RapidAPI.
 *
 * This is the app's only lawful route to LinkedIn, Indeed and Glassdoor
 * postings. JSearch indexes Google for Jobs, which those boards feed
 * deliberately, so their listings arrive through a licensed aggregator instead
 * of through a scraper pointed at a site whose terms forbid it. Each result
 * names the board it came from, and that name is carried through to the leads
 * table as `sourcePublisher` — a lead reads "JSearch · via LinkedIn", which is
 * both more useful and more honest than implying the app crawled LinkedIn.
 *
 * **A caveat that belongs in the code rather than in a commit message: the field
 * names below could not be verified against a reachable source.** Adzuna serves
 * a live Swagger document and the three remote feeds were probed directly, so
 * those adapters are written against observed payloads. JSearch's schema is
 * published only on its RapidAPI listing, which renders client-side and returns
 * nothing to a fetch, and its endpoint answers `403 {"message":"You are not
 * subscribed to this API."}` without a paid key. So this maps the documented
 * names, tolerates the two known naming eras, and — importantly — *reports its
 * own drift*: a page that returns items but maps none of them logs a warning
 * naming the keys it actually saw. If the schema has moved, the first real run
 * says so in the run log instead of looking like a board with no jobs.
 *
 * Nothing here throws on an unexpected shape. A missing field yields a null
 * lead, not an exception, because one renamed key should cost one posting
 * rather than the whole source.
 */

import type { RawJob } from '@job-radar/shared';
import { employmentTypeFrom, periodFrom } from '../normalize.js';
import type { JobProvider } from '../types.js';
import {
  createKeyedProvider,
  type KeyedAdapter,
  type KeyedPage,
  type KeyedPageRequest,
  type KeyedProviderOptions,
} from './base.js';

const ENDPOINT = 'https://jsearch.p.rapidapi.com/search';
const HOST = 'jsearch.p.rapidapi.com';

/** Two-letter market. Google for Jobs partitions its index by country. */
const DEFAULT_COUNTRY = 'in';

interface JSearchResponse {
  status?: string;
  request_id?: string;
  data?: JSearchJob[];
  /** Present on the RapidAPI error path, where `data` is absent. */
  message?: string;
  error?: { message?: string };
}

/**
 * Every field optional, because none of them are guaranteed by a schema this
 * code has seen. The pairs are the two naming eras: the original flat fields and
 * the shorter names introduced later.
 */
interface JSearchJob {
  job_id?: string;
  job_title?: string;
  employer_name?: string;
  employer_website?: string;
  employer_logo?: string;

  /** The board this originally appeared on: "LinkedIn", "Indeed", "Glassdoor". */
  job_publisher?: string;

  job_description?: string;
  job_apply_link?: string;
  /** True when `job_apply_link` reaches the employer rather than a board. */
  job_apply_is_direct?: boolean;
  apply_options?: { publisher?: string; apply_link?: string; is_direct?: boolean }[];
  job_google_link?: string;

  job_employment_type?: string;
  job_employment_types?: string[];
  job_is_remote?: boolean;

  /** Older payloads split the location; newer ones send it pre-joined. */
  job_city?: string;
  job_state?: string;
  job_country?: string;
  job_location?: string;

  job_posted_at_datetime_utc?: string;
  job_posted_at_timestamp?: number;
  /** Newer, and relative: "3 days ago". Only used when nothing absolute exists. */
  job_posted_at?: string;

  job_min_salary?: number;
  job_max_salary?: number;
  job_salary_currency?: string;
  job_salary_period?: string;
  /** Newer payloads nest the same numbers. */
  job_salary?: { min?: number; max?: number; currency?: string; period?: string };
}

export interface JSearchOptions extends KeyedProviderOptions {
  /** Two-letter country code. Defaults to India. */
  country?: string;
}

function buildAdapter(country: string): KeyedAdapter<JSearchJob> {
  return {
    id: 'jsearch',
    label: 'JSearch (LinkedIn · Indeed · Glassdoor)',
    requiredCredentials: ['RAPIDAPI_KEY'],

    async fetchPage(request, ctx): Promise<KeyedPage<JSearchJob>> {
      const payload = await ctx.http.getJson<JSearchResponse>(buildUrl(country, request), {
        signal: ctx.signal,
        headers: {
          'x-rapidapi-key': credential(request, 'RAPIDAPI_KEY'),
          'x-rapidapi-host': HOST,
        },
      });

      // RapidAPI reports subscription and quota problems as a plain `message`
      // with no `data`. Surfaced verbatim: "You are not subscribed to this API"
      // is precisely what the user needs to read.
      const message = payload?.message ?? payload?.error?.message;
      if (message && !payload?.data) throw new Error(message);

      const items = Array.isArray(payload?.data) ? payload.data : [];

      // The drift alarm. Items came back, so the request worked and the query
      // matched — but not one of them had a mappable id and title, which is
      // what a renamed field looks like from here.
      if (items.length > 0 && items.every((item) => !isMappable(item))) {
        ctx.log?.({
          level: 'warn',
          source: 'jsearch',
          message:
            `returned ${items.length} results with no recognisable job fields — the response ` +
            `schema has probably changed. Keys seen: ${describeKeys(items[0])}`,
        });
      }

      // JSearch reports no total, and an empty page is the only end-of-results
      // signal it gives.
      return { items, hasMore: items.length > 0 };
    },

    toRawJob(item) {
      if (!isMappable(item)) return null;

      const applyLink = bestApplyLink(item);
      // Without any link there is nothing to send the user to, and a lead they
      // cannot open is not a lead.
      if (!applyLink) return null;

      const description = item.job_description?.trim() || undefined;
      const salary = readSalary(item);

      const job: RawJob = {
        source: 'jsearch',
        sourceJobId: String(item.job_id),
        title: String(item.job_title),
        companyName: item.employer_name?.trim() || 'Unknown',
        location: readLocation(item),
        isRemote: item.job_is_remote === true,
        // JSearch carries the whole posting, not a teaser — the one real
        // advantage it has over Adzuna, and what lets its leads clear 85%.
        hasFullDescription: Boolean(description && description.length > 200),
        postedAt: readPostedAt(item),
        employmentType: employmentTypeFrom(
          item.job_employment_type ?? item.job_employment_types?.[0],
        ),
        applyUrl: applyLink,
        // No stable per-posting page of its own; the apply link is the listing.
        sourceUrl: applyLink,
      };

      if (description) {
        job.description = description;
        // Descriptions arrive as plain text with newlines already in place.
        job.descriptionIsHtml = false;
      }

      const publisher = item.job_publisher?.trim();
      if (publisher) job.sourcePublisher = publisher;

      const website = item.employer_website?.trim();
      if (website) job.companyWebsite = website;

      if (salary) {
        if (salary.min !== undefined) job.salaryMin = salary.min;
        if (salary.max !== undefined) job.salaryMax = salary.max;
        if (salary.currency) job.salaryCurrency = salary.currency;
        job.salaryPeriod = salary.period;
      }

      return job;
    },
  };
}

/** The two fields without which there is no posting, under either naming era. */
function isMappable(item: JSearchJob | undefined): boolean {
  return Boolean(item?.job_id && item.job_title);
}

/**
 * Prefer a link that reaches the employer's own site.
 *
 * `apply_options` lists every route to the same job, flagged for directness. A
 * direct link is worth finding: it survives longer than a board redirect, and
 * applying on the employer's ATS beats applying through an aggregator.
 */
function bestApplyLink(item: JSearchJob): string | undefined {
  const direct = item.apply_options?.find((option) => option.is_direct && option.apply_link);
  if (direct?.apply_link) return direct.apply_link;
  if (item.job_apply_link) return item.job_apply_link;
  return item.apply_options?.find((option) => option.apply_link)?.apply_link;
}

function readLocation(item: JSearchJob): string | undefined {
  const joined = item.job_location?.trim();
  if (joined) return joined;
  const parts = [item.job_city, item.job_state, item.job_country]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(', ') : undefined;
}

/**
 * An absolute timestamp, or nothing.
 *
 * The relative `job_posted_at` ("3 days ago") is deliberately ignored: turning
 * it into a date means inventing an hour, and the recency dimension would then
 * score a fabricated freshness. A null posting date is honest and costs the
 * lead nothing but a neutral recency score.
 */
function readPostedAt(item: JSearchJob): string | undefined {
  const iso = item.job_posted_at_datetime_utc?.trim();
  if (iso) {
    const at = Date.parse(iso);
    if (Number.isFinite(at)) return new Date(at).toISOString();
  }
  const epoch = item.job_posted_at_timestamp;
  if (typeof epoch === 'number' && Number.isFinite(epoch) && epoch > 0) {
    // Seconds, as every observed payload has used. A millisecond value would
    // land in the year 58680, so the guard is worth the two comparisons.
    const ms = epoch < 1e12 ? epoch * 1000 : epoch;
    return new Date(ms).toISOString();
  }
  return undefined;
}

function readSalary(
  item: JSearchJob,
): { min?: number; max?: number; currency?: string; period: RawJob['salaryPeriod'] } | null {
  const nested = item.job_salary;
  const min = positive(item.job_min_salary ?? nested?.min);
  const max = positive(item.job_max_salary ?? nested?.max);
  if (min === undefined && max === undefined) return null;

  const salary: { min?: number; max?: number; currency?: string; period: RawJob['salaryPeriod'] } =
    {
      // JSearch spells periods `YEAR`, `MONTH`, `HOUR`; `periodFrom` lowercases
      // and matches on the stem, and returns null for anything it does not know
      // rather than guessing — which normalizes as annual, the safer reading.
      period: periodFrom(item.job_salary_period ?? nested?.period),
    };
  if (min !== undefined) salary.min = min;
  if (max !== undefined) salary.max = max;
  const currency = (item.job_salary_currency ?? nested?.currency)?.trim().toUpperCase();
  if (currency) salary.currency = currency;
  return salary;
}

function buildUrl(country: string, request: KeyedPageRequest): string {
  // JSearch takes one free-text query rather than separate title and location
  // parameters, so the two are joined the way its examples do.
  const query = [request.keyword || 'software engineer', request.location]
    .filter(Boolean)
    .join(' in ');

  const params = new URLSearchParams({
    query,
    page: String(request.page),
    // One page per request. Asking for more makes JSearch fan out internally
    // and bill accordingly, which defeats the point of the request budget.
    num_pages: '1',
    country,
    date_posted: datePostedFor(request.query.postedWithinDays),
  });

  if (request.query.remoteOnly) params.set('remote_jobs_only', 'true');

  const types = employmentTypesFor(request);
  if (types) params.set('employment_types', types);

  return `${ENDPOINT}?${params.toString()}`;
}

/**
 * JSearch offers four fixed windows, not a day count. Each maps to the
 * narrowest window that still contains the user's, so the filter never hides a
 * job inside the range they asked for — anything extra is trimmed locally.
 */
function datePostedFor(days: number): string {
  if (days <= 1) return 'today';
  if (days <= 3) return '3days';
  if (days <= 7) return 'week';
  return 'month';
}

/** JSearch's own vocabulary, which differs from the app's five canonical types. */
const EMPLOYMENT_TYPE_NAMES: Record<string, string> = {
  fulltime: 'FULLTIME',
  parttime: 'PARTTIME',
  contract: 'CONTRACTOR',
  internship: 'INTERN',
  // No temporary equivalent — omitted rather than mapped to something adjacent,
  // since a wrong filter silently removes real jobs.
};

function employmentTypesFor(request: KeyedPageRequest): string | undefined {
  const names = request.query.employmentTypes
    .map((type) => EMPLOYMENT_TYPE_NAMES[type])
    .filter((name): name is string => Boolean(name));
  // All-or-nothing: if any requested type has no equivalent, the filter is
  // dropped and the local one does the work. Sending a partial list would ask
  // the API to exclude jobs the user wanted.
  if (names.length === 0 || names.length !== request.query.employmentTypes.length) return undefined;
  return names.join(',');
}

function credential(request: KeyedPageRequest, name: string): string {
  const value = request.credentials[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** The keys of an unmappable result, so a schema change names itself in the log. */
function describeKeys(item: JSearchJob | undefined): string {
  if (!item || typeof item !== 'object') return 'none';
  return Object.keys(item).slice(0, 12).join(', ') || 'none';
}

export function createJSearchProvider(options: JSearchOptions = {}): JobProvider {
  return createKeyedProvider(buildAdapter(options.country ?? DEFAULT_COUNTRY), options);
}

/** Exported for the fixture tests, which exercise mapping without the network. */
export const jsearchAdapter: KeyedAdapter<JSearchJob> = buildAdapter(DEFAULT_COUNTRY);
export type { JSearchJob, JSearchResponse };
