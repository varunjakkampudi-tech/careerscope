/**
 * Remote OK.
 *
 * The simplest feed of the three and the one with the most traps. Everything
 * arrives as a single JSON array in one request — no paging, no parameters, no
 * key — and four details in that array need handling:
 *
 * **The first element is not a job.** Index 0 is a legal notice object. It is
 * skipped here by *shape* rather than by index — an item with no `position` is
 * not a posting — so that the day RemoteOK moves the notice, appends a second
 * one, or drops it entirely, nothing breaks and no legal text is offered to the
 * user as a lead.
 *
 * **A missing salary is written as zero.** `salary_min` and `salary_max` are `0`
 * rather than absent when RemoteOK does not know the pay. Passed through, that
 * would render as "₹0" and, worse, score as a real compensation mismatch
 * against the user's expected CTC. Zeroes are dropped.
 *
 * **The descriptions are mojibake.** In a sample of 100 postings, 61 carried
 * UTF-8 that had been decoded as Latin-1 somewhere upstream — every apostrophe
 * and dash rendered as "â€™". It is repaired on the way in, because the damage
 * otherwise reaches both the user's screen and the skill extractor's input.
 *
 * **Attribution is a condition of access.** RemoteOK's terms require a follow
 * link back to the RemoteOK posting and a mention of RemoteOK as the source, so
 * `sourceUrl` is always the RemoteOK page even when a direct `apply_url` exists.
 */

import type { RawJob } from '@job-radar/shared';
import { repairMojibake } from '../html.js';
import type { JobProvider } from '../types.js';
import {
  createFeedProvider,
  epochSecondsToIso,
  withKeywordLine,
  type FeedAdapter,
  type FeedProviderOptions,
} from './base.js';

const API = 'https://remoteok.com/api';

interface RemoteOkJob {
  /** Absent on the legal-notice element that leads the array. */
  id?: string;
  slug?: string;
  /** RemoteOK's word for the job title. */
  position?: string;
  company?: string;
  company_logo?: string;
  tags?: string[];
  description?: string;
  /** Frequently an empty string; every posting here is remote regardless. */
  location?: string;
  /** Epoch seconds. */
  epoch?: number;
  date?: string;
  /** Annual USD, or `0` meaning "not stated". */
  salary_min?: number;
  salary_max?: number;
  /** The employer's own link, when RemoteOK has one. */
  apply_url?: string;
  original?: boolean;
  /** The RemoteOK posting page. Required by the attribution terms. */
  url?: string;
}

const adapter: FeedAdapter<RemoteOkJob> = {
  id: 'remoteok',
  label: 'Remote OK',

  async *pages(ctx) {
    // The whole board is one array — roughly 370 KB — and there is nothing to
    // page through.
    const payload = await ctx.http.getJson<RemoteOkJob[]>(API, { signal: ctx.signal });
    yield Array.isArray(payload) ? payload : [];
  },

  toRawJob(item) {
    // No title means this is the legal notice, not a posting.
    if (!item.id || !item.position) return null;

    const url = item.url ?? `https://remoteok.com/remote-jobs/${item.slug ?? item.id}`;
    const description = item.description
      ? withKeywordLine(repairMojibake(item.description), item.tags ?? [])
      : undefined;

    const job: RawJob = {
      source: 'remoteok',
      sourceJobId: String(item.id),
      title: repairMojibake(item.position),
      companyName: repairMojibake(item.company?.trim() || 'Unknown'),
      location: item.location?.trim() || undefined,
      isRemote: true,
      hasFullDescription: Boolean(description?.trim()),
      postedAt: epochSecondsToIso(item.epoch) ?? isoOrUndefined(item.date),
      // The employer's link when there is one, but `sourceUrl` stays with
      // RemoteOK — the link back is what the terms require.
      applyUrl: item.apply_url ?? url,
      sourceUrl: url,
    };

    if (description) {
      job.description = description;
      job.descriptionIsHtml = true;
    }

    // Zero is RemoteOK's way of saying "unknown", not a salary of nothing.
    const min = positive(item.salary_min);
    const max = positive(item.salary_max);
    if (min !== undefined || max !== undefined) {
      if (min !== undefined) job.salaryMin = min;
      if (max !== undefined) job.salaryMax = max;
      job.salaryCurrency = 'USD';
      job.salaryPeriod = 'year';
    }

    return job;
  },
};

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isoOrUndefined(value: string | undefined): string | undefined {
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) ? new Date(at).toISOString() : undefined;
}

export function createRemoteOkProvider(options: FeedProviderOptions = {}): JobProvider {
  return createFeedProvider(adapter, options);
}

/** Exported for the fixture tests, which exercise mapping without the network. */
export const remoteOkAdapter: FeedAdapter<RemoteOkJob> = adapter;
export type { RemoteOkJob };
