/**
 * Adzuna.
 *
 * The best-documented of the three keyed aggregators and the only one whose
 * schema could be read directly: `https://api.adzuna.com/v1/api-docs/adzuna`
 * serves a live Swagger 1.2 spec, and the field names below are taken from it
 * rather than from prose. Two things in that spec matter more than the rest.
 *
 * **There is a `full_description`, whatever the prose says.** The human-facing
 * documentation states twice that "we currently only provide a snippet of the
 * job description", but the `Job` model declares both `description` and
 * `full_description`. So this asks for the long one, takes the snippet when it
 * is all that arrives, and sets `hasFullDescription` from *which one it got*.
 * That flag is what caps a lead at 80% in the matching engine, so getting it
 * right is the difference between an honest 78% and a fictional 91%.
 *
 * **`salary_is_predicted` means Adzuna guessed.** Adzuna runs a salary model
 * over ads that do not state pay, and publishes the output in the same
 * `salary_min` / `salary_max` fields as a real one. Rendering that as the
 * employer's package would be inventing a number and putting a company's name
 * next to it, so a predicted salary is dropped. The user sees "Not disclosed",
 * which is the truth.
 *
 * `max_days_old` is a real server-side filter, so the search window is pushed to
 * the API rather than applied after the fact — on a metered endpoint, filtering
 * locally means paying for results that were never eligible.
 *
 * Country is a path segment. `in` is India, and the profile's home market is
 * where the user's leads are, so that is the default.
 */

import type { RawJob } from '@job-radar/shared';
import { employmentTypeFrom } from '../normalize.js';
import type { JobProvider } from '../types.js';
import {
  createKeyedProvider,
  type KeyedAdapter,
  type KeyedPage,
  type KeyedPageRequest,
  type KeyedProviderOptions,
} from './base.js';

const BASE = 'https://api.adzuna.com/v1/api/jobs';

/** The spec sets a minimum of 1 and no maximum. Fewer, larger pages is fewer
 * metered calls, and 50 has been the working ceiling in practice. */
const PAGE_SIZE = 50;

/** ISO country code in the path. Adzuna partitions its index by country. */
const DEFAULT_COUNTRY = 'in';

interface AdzunaSearchResults {
  /** Total matches, so `hasMore` is arithmetic rather than a guess. */
  count?: number;
  results?: AdzunaJob[];
  /** Present on the error path instead of results. */
  exception?: string;
  display?: string;
}

interface AdzunaJob {
  id?: string;
  adref?: string;
  title?: string;
  /** A truncated snippet, ending mid-sentence. */
  description?: string;
  /** The whole posting, when Adzuna has it. Declared in the schema. */
  full_description?: string;
  /** ISO 8601 with a Z. */
  created?: string;
  redirect_url?: string;
  company?: { display_name?: string; canonical_name?: string };
  location?: { display_name?: string; area?: string[] };
  category?: { label?: string; tag?: string };
  salary_min?: number;
  salary_max?: number;
  /** True when the figures came from Adzuna's model, not the employer. */
  salary_is_predicted?: boolean | string | number;
  /** "full_time" | "part_time". */
  contract_time?: string;
  /** "permanent" | "contract". */
  contract_type?: string;
}

export interface AdzunaOptions extends KeyedProviderOptions {
  /** ISO country code. Defaults to India. */
  country?: string;
}

function buildAdapter(country: string): KeyedAdapter<AdzunaJob> {
  return {
    id: 'adzuna',
    label: 'Adzuna',
    requiredCredentials: ['ADZUNA_APP_ID', 'ADZUNA_APP_KEY'],

    async fetchPage(request, ctx): Promise<KeyedPage<AdzunaJob>> {
      const url = buildUrl(country, request);
      const payload = await ctx.http.getJson<AdzunaSearchResults>(url, { signal: ctx.signal });

      // Adzuna answers errors with 200-shaped JSON carrying an `exception`, so
      // a failure here would otherwise look like an empty result set.
      if (payload?.exception) {
        throw new Error(payload.display?.trim() || payload.exception);
      }

      const items = payload?.results ?? [];
      const total = payload?.count;
      const hasMore =
        typeof total === 'number' ? request.page * PAGE_SIZE < total : items.length === PAGE_SIZE;

      return { items, hasMore };
    },

    toRawJob(item) {
      const id = item.id ?? item.adref;
      if (!id || !item.title || !item.redirect_url) return null;

      const full = item.full_description?.trim();
      const description = full || item.description?.trim() || undefined;

      const job: RawJob = {
        source: 'adzuna',
        sourceJobId: String(id),
        title: item.title,
        companyName: item.company?.display_name?.trim() || 'Unknown',
        location: item.location?.display_name?.trim() || undefined,
        // Only the snippet counts as a read description. Anything less keeps the
        // lead below the 85% line, which is the point of the flag.
        hasFullDescription: Boolean(full),
        postedAt: isoOrUndefined(item.created),
        employmentType: employmentTypeFrom(item.contract_time ?? item.contract_type),
        // Adzuna's link is a redirect through their domain, not the employer's
        // page. It is still the only working way in, and the terms expect it.
        applyUrl: item.redirect_url,
        sourceUrl: item.redirect_url,
      };

      if (description) {
        job.description = description;
        // Adzuna's descriptions come through as plain text, entities and all.
        job.descriptionIsHtml = false;
      }

      // A modelled salary is not the employer's number and must not be shown as
      // one. Dropping it costs a filled column; keeping it would be a fabrication.
      if (!isPredicted(item.salary_is_predicted)) {
        const min = positive(item.salary_min);
        const max = positive(item.salary_max);
        if (min !== undefined || max !== undefined) {
          if (min !== undefined) job.salaryMin = min;
          if (max !== undefined) job.salaryMax = max;
          job.salaryCurrency = currencyFor(country);
          job.salaryPeriod = 'year';
        }
      }

      return job;
    },
  };
}

/**
 * Adzuna's boolean-ish fields arrive as `true`, `"1"`, or `1` depending on the
 * endpoint and the era. Anything that is not plainly false counts as predicted:
 * the safe default here is to withhold a salary, not to publish one.
 */
function isPredicted(value: boolean | string | number | undefined): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const normalized = value.trim().toLowerCase();
  return normalized !== '' && normalized !== '0' && normalized !== 'false';
}

function buildUrl(country: string, request: KeyedPageRequest): string {
  const params = new URLSearchParams({
    app_id: credential(request, 'ADZUNA_APP_ID'),
    app_key: credential(request, 'ADZUNA_APP_KEY'),
    results_per_page: String(PAGE_SIZE),
    'content-type': 'application/json',
    // Newest first: a stale ad the user has already seen is worth less than a
    // fresh one, and the recency dimension scores it that way anyway.
    sort_by: 'date',
    // A real server-side filter, so the window is not paid for and then discarded.
    max_days_old: String(Math.max(1, Math.round(request.query.postedWithinDays))),
  });

  if (request.keyword) params.set('what', request.keyword);
  if (request.location) params.set('where', request.location);
  // Adzuna searches the description as well as the title, so an exclusion here
  // removes the ad before it is billed for, not after.
  const excluded = request.query.excludeKeywords.filter(Boolean).join(' ');
  if (excluded) params.set('what_exclude', excluded);

  return `${BASE}/${country}/search/${request.page}?${params.toString()}`;
}

/**
 * Credentials travel on the request rather than being closed over, so the same
 * adapter object works for any key set and nothing is captured in a module.
 */
function credential(request: KeyedPageRequest, name: string): string {
  const value = request.credentials[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Adzuna reports pay in the country's own currency, which the path selects. */
function currencyFor(country: string): string {
  const byCountry: Record<string, string> = {
    in: 'INR',
    gb: 'GBP',
    us: 'USD',
    ca: 'CAD',
    au: 'AUD',
    de: 'EUR',
    fr: 'EUR',
    nl: 'EUR',
    at: 'EUR',
    it: 'EUR',
    es: 'EUR',
    pl: 'PLN',
    sg: 'SGD',
    za: 'ZAR',
    nz: 'NZD',
    br: 'BRL',
    mx: 'MXN',
    ru: 'RUB',
    ch: 'CHF',
    be: 'EUR',
  };
  return byCountry[country] ?? 'USD';
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

export function createAdzunaProvider(options: AdzunaOptions = {}): JobProvider {
  return createKeyedProvider(buildAdapter(options.country ?? DEFAULT_COUNTRY), options);
}

/** Exported for the fixture tests, which exercise mapping without the network. */
export const adzunaAdapter: KeyedAdapter<AdzunaJob> = buildAdapter(DEFAULT_COUNTRY);
export type { AdzunaJob, AdzunaSearchResults };
