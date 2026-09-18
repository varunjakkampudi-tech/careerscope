/**
 * Himalayas.
 *
 * By far the largest of the three feeds — 103,909 live postings at the time of
 * writing — and the only one with real pagination. It is also the only one with
 * **no keyword parameter at all**, which is the fact that shapes this adapter.
 *
 * Filtering therefore happens entirely on our side, over whatever slice of the
 * feed we choose to walk, and that slice has to be bounded. Measured against the
 * live API, twenty consecutive postings spanned eight minutes — roughly 3,600
 * new postings a day — so a naive "walk until the window closes" would fetch
 * tens of thousands of jobs to satisfy an ordinary two-week search. Two stops
 * apply instead:
 *
 *  - **The window stop**, which is the principled one. The feed is strictly
 *    newest-first (verified: `pubDate` descending), so once a page *ends* older
 *    than the search window, no later page can contain anything eligible and the
 *    walk is genuinely finished.
 *  - **The page ceiling**, which is a budget rather than a fact. When it is what
 *    stopped the walk, it is logged — a cap the user cannot see reads as "there
 *    was nothing else", and that is a claim this code has not earned.
 *
 * Pagination uses `cursor`. The feed's own `comments` field records that offset
 * paging is deprecated, slower, and can return the same job twice.
 */

import type { RawJob } from '@job-radar/shared';
import { employmentTypeFrom, periodFrom } from '../normalize.js';
import type { JobProvider } from '../types.js';
import {
  createFeedProvider,
  epochSecondsToIso,
  withKeywordLine,
  type FeedAdapter,
  type FeedProviderOptions,
} from './base.js';

const API = 'https://himalayas.app/jobs/api';

/** The feed's own maximum. Fewer, larger pages is fewer round trips. */
const PAGE_SIZE = 100;

/**
 * Twenty pages — the 2,000 most recent postings, a little over half a day of
 * this feed. Past that the walk costs more than the marginal lead is worth, and
 * anything older is reachable by narrowing the search rather than widening it.
 */
const MAX_PAGES = 20;

const DAY_MS = 86_400_000;

interface HimalayasPage {
  jobs?: HimalayasJob[];
  nextCursor?: string | null;
  totalCount?: number;
}

interface HimalayasJob {
  /** The posting's URL on Himalayas. There is no separate id field. */
  guid?: string;
  title?: string;
  companyName?: string;
  companySlug?: string;
  companyLogo?: string;
  excerpt?: string;
  description?: string;
  /** "Full Time", "Contract", … */
  employmentType?: string;
  minSalary?: number | null;
  maxSalary?: number | null;
  currency?: string | null;
  /** "annual", "hourly", … */
  salaryPeriod?: string | null;
  seniority?: string[];
  /** Where the holder may live — these roles are all remote. */
  locationRestrictions?: string[];
  categories?: string[];
  parentCategories?: string[];
  /** Epoch seconds. */
  pubDate?: number;
  expiryDate?: number;
  /** The employer's own application link. */
  applicationLink?: string;
}

const adapter: FeedAdapter<HimalayasJob> = {
  id: 'himalayas',
  label: 'Himalayas',

  async *pages(ctx, query, now): AsyncGenerator<HimalayasJob[]> {
    const oldestWanted = now - query.postedWithinDays * DAY_MS;
    let cursor: string | null = null;

    for (let page = 1; ; page += 1) {
      const url: string = cursor
        ? `${API}?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`
        : `${API}?limit=${PAGE_SIZE}`;

      const payload: HimalayasPage = await ctx.http.getJson<HimalayasPage>(url, {
        signal: ctx.signal,
      });
      const jobs = payload?.jobs ?? [];
      if (jobs.length === 0) return;

      yield jobs;

      // Newest-first, so a page whose *last* posting predates the window means
      // every remaining page does too. This is the stop that means something.
      const oldest = jobs[jobs.length - 1]?.pubDate;
      if (typeof oldest === 'number' && oldest * 1000 < oldestWanted) return;

      cursor = payload?.nextCursor ?? null;
      if (!cursor) return;

      if (page >= MAX_PAGES) {
        ctx.log?.({
          level: 'info',
          source: 'himalayas',
          limited: true,
          message:
            `stopped after ${MAX_PAGES} pages (${MAX_PAGES * PAGE_SIZE} most recent postings) — ` +
            `the feed carries ${payload?.totalCount ?? 'many more'} and offers no keyword filter, ` +
            `so older matches exist but were not read`,
        });
        return;
      }
    }
  },

  toRawJob(item, now) {
    if (!item.guid || !item.title) return null;
    // An expired posting is not a lead, however well it scores.
    if (typeof item.expiryDate === 'number' && item.expiryDate * 1000 < now) return null;

    const body = item.description?.trim() || item.excerpt?.trim() || '';
    const description = body
      ? withKeywordLine(body, [...(item.parentCategories ?? []), ...(item.categories ?? [])])
      : undefined;

    const location = (item.locationRestrictions ?? [])
      .map((value) => value.trim())
      .filter(Boolean)
      .join(', ');

    const job: RawJob = {
      source: 'himalayas',
      sourceJobId: item.guid,
      title: item.title,
      companyName: item.companyName?.trim() || 'Unknown',
      // As with Remotive, this says where the holder may live rather than where
      // an office is — worth keeping verbatim rather than flattening.
      location: location || undefined,
      isRemote: true,
      employmentType: employmentTypeFrom(item.employmentType),
      // The excerpt is a teaser, so a posting that only has one must stay marked
      // low-confidence — that clamp is what stops a thin listing scoring 90%.
      hasFullDescription: Boolean(item.description?.trim()),
      postedAt: epochSecondsToIso(item.pubDate),
      applyUrl: item.applicationLink ?? item.guid,
      sourceUrl: item.guid,
    };

    if (description) {
      job.description = description;
      job.descriptionIsHtml = true;
    }
    if (item.companySlug?.trim()) {
      job.companyCareersUrl = `https://himalayas.app/companies/${item.companySlug.trim()}`;
    }

    const min = positive(item.minSalary);
    const max = positive(item.maxSalary);
    if (min !== undefined || max !== undefined) {
      if (min !== undefined) job.salaryMin = min;
      if (max !== undefined) job.salaryMax = max;
      if (item.currency?.trim()) job.salaryCurrency = item.currency.trim().toUpperCase();
      job.salaryPeriod = periodFrom(item.salaryPeriod);
    }

    return job;
  },
};

function positive(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function createHimalayasProvider(options: FeedProviderOptions = {}): JobProvider {
  return createFeedProvider(adapter, options);
}

/** Exported for the fixture tests, which exercise mapping without the network. */
export const himalayasAdapter: FeedAdapter<HimalayasJob> = adapter;
export type { HimalayasJob, HimalayasPage };
