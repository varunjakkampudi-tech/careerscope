/**
 * Ashby.
 *
 * One request returns the entire board, descriptions included — which makes this
 * the cheapest of the six ATSs when the board is small, and the only one that
 * needs the body ceiling raised when it is not. OpenAI's board measured
 * **12.21 MB**, past the client's 8 MB default; without the raise, the largest
 * and most interesting boards would be the ones that silently failed.
 *
 * The raise is per-request rather than global on purpose: a board that is large
 * *by malfunction* should still get cut off everywhere else.
 */

import type { RawJob } from '@job-radar/shared';
import type { JobProvider } from '../types.js';
import { employmentTypeFrom, periodFrom } from '../normalize.js';
import {
  boardJson,
  createBoardProvider,
  type BoardAdapter,
  type BoardProviderOptions,
} from './base.js';

const API = 'https://api.ashbyhq.com/posting-api/job-board';

/** Enough for the largest board measured, with room to grow. */
const MAX_BOARD_BYTES = 24 * 1024 * 1024;

/** Ashby's boards are the slowest to transfer; give them room past the default. */
const BOARD_TIMEOUT_MS = 45_000;

interface AshbyCompensationComponent {
  compensationType?: string;
  interval?: string;
  currencyCode?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
}

interface AshbyJob {
  id?: string;
  title?: string;
  location?: string;
  secondaryLocations?: Array<{ location?: string }>;
  isRemote?: boolean;
  isListed?: boolean;
  employmentType?: string;
  publishedAt?: string;
  jobUrl?: string;
  applyUrl?: string;
  descriptionHtml?: string;
  descriptionPlain?: string;
  compensation?: {
    compensationTierSummary?: string | null;
    scrapeableCompensationSalarySummary?: string | null;
    summaryComponents?: AshbyCompensationComponent[];
  } | null;
}

const adapter: BoardAdapter<AshbyJob> = {
  id: 'ashby',
  label: 'Ashby',

  async listBoard(board, ctx) {
    const payload = await boardJson<{ jobs?: AshbyJob[] }>(
      ctx,
      `${API}/${encodeURIComponent(board.slug)}?includeCompensation=true`,
      { maxBytes: MAX_BOARD_BYTES, timeoutMs: BOARD_TIMEOUT_MS },
    );
    // `isListed: false` is a posting the company has taken down but not deleted.
    return (payload?.jobs ?? []).filter((job) => job.isListed !== false);
  },

  toRawJob(item, board) {
    if (!item.id || !item.title) return null;

    const url = item.jobUrl ?? `https://jobs.ashbyhq.com/${board.slug}/${item.id}`;
    const html = item.descriptionHtml?.trim() ?? '';
    const plain = item.descriptionPlain?.trim() ?? '';
    const description = html || plain;

    // Compensation arrives as a list of components — base salary, equity,
    // bonus. Only the salary component is a number the user can compare against
    // an expected CTC; the human-readable summary keeps the rest ("Offers
    // Equity"), which is information the two numbers lose.
    const salary = (item.compensation?.summaryComponents ?? []).find(
      (component) => component.compensationType === 'Salary',
    );

    return {
      source: 'ashby',
      sourceJobId: item.id,
      title: item.title,
      companyName: board.company,
      location: item.location ?? item.secondaryLocations?.[0]?.location,
      ...(item.isRemote === true ? { isRemote: true } : {}),
      employmentType: employmentTypeFrom(item.employmentType),
      description,
      descriptionIsHtml: html.length > 0,
      hasFullDescription: description.length > 0,
      ...(salary?.minValue || salary?.maxValue
        ? {
            salaryMin: salary.minValue ?? undefined,
            salaryMax: salary.maxValue ?? undefined,
            salaryCurrency: salary.currencyCode ?? undefined,
            salaryPeriod: periodFrom(salary.interval),
          }
        : {}),
      salaryRaw:
        item.compensation?.compensationTierSummary ??
        item.compensation?.scrapeableCompensationSalarySummary ??
        undefined,
      postedAt: item.publishedAt,
      applyUrl: item.applyUrl ?? url,
      sourceUrl: url,
      atsType: 'ashby',
      companyCareersUrl: `https://jobs.ashbyhq.com/${board.slug}`,
    } satisfies RawJob;
  },
};

export function createAshbyProvider(options: BoardProviderOptions = {}): JobProvider {
  return createBoardProvider(adapter, options);
}

export const ashbyAdapter: BoardAdapter<AshbyJob> = adapter;
export type { AshbyJob };
