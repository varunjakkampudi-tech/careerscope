/**
 * Remotive.
 *
 * A curated remote-only board with a public JSON feed. Three things about it
 * shape this adapter, each verified against the live API rather than taken from
 * the documentation:
 *
 * **The query parameters do nothing.** `search`, `category` and `limit` are all
 * documented, and all three return byte-identical responses — same job count,
 * same ids, in the same order. The endpoint is served from a CDN cache whose key
 * ignores the query string (`cf-cache-status: HIT`, `age: 39653`). So this sends
 * no parameters at all. Attaching them would suggest a server-side narrowing
 * that does not happen, and would leave whoever reads this next believing the
 * feed had already been filtered. The whole feed arrives in one request and is
 * filtered here.
 *
 * **One request per run, by licence.** Remotive's terms ask for at most about
 * four GETs a day and state that excessive requests will be blocked. Hence no
 * pagination, and no per-title request fan-out.
 *
 * **Attribution is a condition of access.** The terms require linking back to
 * the Remotive URL and naming Remotive as the source, explicitly on pain of
 * termination. `sourceUrl` and `applyUrl` therefore both point at the Remotive
 * posting rather than the employer's own page, and the source id travels with
 * the lead through to the UI.
 *
 * One more thing worth knowing when this source looks thin: Remotive delays its
 * public feed by 24 hours on purpose, so nothing from here can ever satisfy a
 * "posted today" window.
 */

import type { RawJob } from '@job-radar/shared';
import { employmentTypeFrom } from '../normalize.js';
import type { JobProvider } from '../types.js';
import {
  createFeedProvider,
  withKeywordLine,
  type FeedAdapter,
  type FeedProviderOptions,
} from './base.js';

const API = 'https://remotive.com/api/remote-jobs';

interface RemotiveJob {
  id: number;
  url?: string;
  title?: string;
  company_name?: string;
  company_logo?: string;
  category?: string;
  tags?: string[];
  /** `full_time` | `part_time` | `contract` | `freelance`. */
  job_type?: string;
  /** ISO, but with no timezone designator. See `publishedAt`. */
  publication_date?: string;
  /** A region *restriction* — "Worldwide", "LATAM, Europe, USA" — not an office. */
  candidate_required_location?: string;
  /** Freeform: "$20k -$35k", "60000 - 80000 USD", or absent. */
  salary?: string;
  description?: string;
}

const adapter: FeedAdapter<RemotiveJob> = {
  id: 'remotive',
  label: 'Remotive',

  async *pages(ctx) {
    const payload = await ctx.http.getJson<{ jobs?: RemotiveJob[] }>(API, { signal: ctx.signal });
    yield payload?.jobs ?? [];
  },

  toRawJob(item) {
    if (!item.id || !item.title || !item.url) return null;

    const description = item.description
      ? withKeywordLine(item.description, [item.category, ...(item.tags ?? [])])
      : undefined;

    const job: RawJob = {
      source: 'remotive',
      sourceJobId: String(item.id),
      title: item.title,
      companyName: item.company_name?.trim() || 'Unknown',
      // Everything on Remotive is remote; this field says *where you may live*,
      // which is a different and genuinely useful fact, so it is kept as-is
      // rather than flattened to the word "Remote".
      location: item.candidate_required_location?.trim() || undefined,
      isRemote: true,
      employmentType: employmentTypeFrom(item.job_type),
      hasFullDescription: Boolean(description?.trim()),
      postedAt: publishedAt(item.publication_date),
      // Remotive's own page, for both links: the licence requires the link back,
      // and applications are routed through it in any case.
      applyUrl: item.url,
      sourceUrl: item.url,
    };

    if (description) {
      job.description = description;
      job.descriptionIsHtml = true;
    }
    if (item.salary?.trim()) job.salaryRaw = item.salary.trim();

    return job;
  },
};

/**
 * Remotive stamps its dates without a timezone — `2026-09-02T19:59:53`. Bare,
 * `Date.parse` reads that as *local* time, which shifts every posting by the
 * host's UTC offset. That is only hours against a window measured in days, but
 * it is a real error at the window edge and it changes answers depending on
 * which machine the API happens to be running on.
 */
function publishedAt(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const stamped = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed) ? trimmed : `${trimmed}Z`;
  const at = Date.parse(stamped);
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

export function createRemotiveProvider(options: FeedProviderOptions = {}): JobProvider {
  return createFeedProvider(adapter, options);
}

/** Exported for the fixture tests, which exercise mapping without the network. */
export const remotiveAdapter: FeedAdapter<RemotiveJob> = adapter;
export type { RemotiveJob };
