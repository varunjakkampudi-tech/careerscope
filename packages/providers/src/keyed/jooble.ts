/**
 * Jooble.
 *
 * A POST-based aggregator with the simplest interface of the three: the key is
 * a path segment, the query is a small JSON body, and the response is a flat
 * list. It indexes a wide spread of Indian boards, which is why it earns a slot
 * despite giving the thinnest data of the three.
 *
 * **Two limits that shape everything below.**
 *
 * *It returns snippets, not descriptions.* Jooble's `snippet` is a couple of
 * sentences with the search terms bolded, and there is no detail endpoint to
 * fill in the rest. So every Jooble lead sets `hasFullDescription: false`, which
 * caps it at 80% in the matching engine — below the user's 85% default. That is
 * the correct outcome rather than a defect: a lead nobody read the description
 * for has not been shown to match. Jooble's real job is discovery — surfacing an
 * employer whose posting the ATS providers can then fetch in full.
 *
 * *The host challenges unauthenticated callers.* Probing `jooble.org/api`
 * without a key returns a Cloudflare interstitial — HTML, HTTP 403 — and it does
 * so before the key is examined, identically with a browser User-Agent. Whether
 * a real key passes could not be tested from here. So the failure is handled
 * explicitly: an HTML body produces a sentence explaining what happened, not a
 * JSON parse error twenty frames down. If a deployment finds this source
 * permanently unreachable, that message is the diagnosis.
 */

import type { RawJob } from '@job-radar/shared';
import { HttpError } from '../http.js';
import { employmentTypeFrom } from '../normalize.js';
import type { JobProvider } from '../types.js';
import {
  createKeyedProvider,
  type KeyedAdapter,
  type KeyedPage,
  type KeyedPageRequest,
  type KeyedProviderOptions,
} from './base.js';

const ENDPOINT = 'https://jooble.org/api';

/** Jooble's documented maximum for a single response. */
const PAGE_SIZE = 20;

interface JoobleResponse {
  totalCount?: number;
  jobs?: JoobleJob[];
}

interface JoobleJob {
  id?: string | number;
  title?: string;
  company?: string;
  location?: string;
  /** A search-result teaser with `<b>` around the matched terms. Never the full JD. */
  snippet?: string;
  /** Free text: "₹12,00,000 - ₹18,00,000 per year", or an empty string. */
  salary?: string;
  /** "Full-time", "Part-time", "Contract" — or absent, which is common. */
  type?: string;
  /** The board Jooble found it on, e.g. "naukri.com". */
  source?: string;
  link?: string;
  /** ISO 8601. */
  updated?: string;
}

export type JoobleOptions = KeyedProviderOptions;

const adapter: KeyedAdapter<JoobleJob> = {
  id: 'jooble',
  label: 'Jooble',
  requiredCredentials: ['JOOBLE_API_KEY'],

  async fetchPage(request, ctx): Promise<KeyedPage<JoobleJob>> {
    // The key is a path segment rather than a header — Jooble's design, not a
    // choice available here. It never appears in a log: the http client logs
    // failures by host, and `describeFailure` renders the message, not the URL.
    const url = `${ENDPOINT}/${credential(request, 'JOOBLE_API_KEY')}`;

    const body: Record<string, string> = {
      keywords: request.keyword,
      page: String(request.page),
    };
    if (request.location) body.location = request.location;
    // Jooble takes a day count directly, so the search window is one of the few
    // filters that costs nothing to push server-side.
    if (request.query.postedWithinDays > 0) {
      body.datecreatedfrom = isoDate(request.now, request.query.postedWithinDays);
    }

    let payload: JoobleResponse;
    try {
      payload = await ctx.http.postJson<JoobleResponse>(url, body, { signal: ctx.signal });
    } catch (error) {
      throw explain(error);
    }

    const items = Array.isArray(payload?.jobs) ? payload.jobs : [];
    const total = payload?.totalCount;
    const hasMore =
      typeof total === 'number' ? request.page * PAGE_SIZE < total : items.length >= PAGE_SIZE;

    return { items, hasMore };
  },

  toRawJob(item) {
    if (!item.id || !item.title || !item.link) return null;

    const snippetText = item.snippet?.trim() || undefined;

    const job: RawJob = {
      source: 'jooble',
      sourceJobId: String(item.id),
      title: item.title.trim(),
      companyName: item.company?.trim() || 'Unknown',
      location: item.location?.trim() || undefined,
      // Always false. A snippet is not a description, and claiming otherwise
      // would let a two-sentence teaser score above the user's threshold.
      hasFullDescription: false,
      postedAt: isoOrUndefined(item.updated),
      employmentType: employmentTypeFrom(item.type),
      applyUrl: item.link,
      sourceUrl: item.link,
    };

    if (snippetText) {
      job.description = snippetText;
      // The snippet carries `<b>` highlights around the matched terms, so it
      // goes through the HTML path to have them stripped rather than shown.
      job.descriptionIsHtml = true;
    }

    // Free text, left unparsed here: `normalizeSalary` runs `parseCompensation`
    // over it, which already handles lakh notation and the range separators
    // Indian boards use. Parsing it twice in two places is how they diverge.
    const salary = item.salary?.trim();
    if (salary) job.salaryRaw = salary;

    // Jooble names the board it indexed — "naukri.com", "linkedin.com" — which
    // is the same fact JSearch reports and belongs in the same field.
    const publisher = item.source?.trim();
    if (publisher) job.sourcePublisher = publisher;

    return job;
  },
};

/**
 * Turn Jooble's two characteristic failures into sentences a user can act on.
 *
 * The bot check is the one worth naming explicitly. It arrives as HTML with a
 * 403, and without this it would surface as a JSON parse error that reads like
 * a bug in this code rather than a door closed by the host.
 */
function explain(error: unknown): unknown {
  if (!(error instanceof HttpError)) return error;

  const body = error.body ?? '';
  if (error.status === 403 || /just a moment|cf-browser-verification|cloudflare/i.test(body)) {
    return new Error(
      'Jooble answered with a bot check instead of results. Its API host challenges ' +
        'requests from datacentre addresses before it looks at the key, so this can ' +
        'happen with a perfectly valid one. Nothing to fix in the app.',
    );
  }
  if (error.status === 401) {
    return new Error('Jooble rejected the API key. Check JOOBLE_API_KEY.');
  }
  return error;
}

/** `YYYY-MM-DD`, `days` before the loop's clock. Jooble wants a date, not a count. */
function isoDate(now: number, days: number): string {
  return new Date(now - days * 86_400_000).toISOString().slice(0, 10);
}

function credential(request: KeyedPageRequest, name: string): string {
  const value = request.credentials[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

export function createJoobleProvider(options: JoobleOptions = {}): JobProvider {
  return createKeyedProvider(adapter, options);
}

/** Exported for the fixture tests, which exercise mapping without the network. */
export const joobleAdapter = adapter;
export type { JoobleJob, JoobleResponse };
