/**
 * Lever.
 *
 * Descriptions come inline, so there is no detail fetch — but the whole board in
 * one request is not viable either: Palantir's board measured 5.66 MB and took
 * **17 seconds**, within a second or two of the client's request timeout. So the
 * board is paged at 100 postings a time.
 *
 * The pagination parameter is `skip`, not `offset`. This is worth stating
 * plainly because `offset` is silently accepted and ignored — passing it returns
 * page one forever, which reads as "this board only has 100 jobs" rather than as
 * an error. Verified against the live API: `skip=5` advances, `offset=5` does
 * not.
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

const API = 'https://api.lever.co/v0/postings';
const PAGE_SIZE = 100;
/** 1,000 postings is far past any board we have seen; beyond it, stop asking. */
const MAX_PAGES = 10;

interface LeverPosting {
  id?: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  /** Epoch milliseconds. */
  createdAt?: number;
  workplaceType?: string;
  country?: string;
  categories?: {
    commitment?: string;
    location?: string;
    team?: string;
    department?: string;
    allLocations?: string[];
  };
  salaryRange?: {
    interval?: string;
    currency?: string;
    min?: number;
    max?: number;
  };
  description?: string;
  additional?: string;
  lists?: Array<{ text?: string; content?: string }>;
}

const adapter: BoardAdapter<LeverPosting> = {
  id: 'lever',
  label: 'Lever',

  async listBoard(board, ctx) {
    const all: LeverPosting[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url =
        `${API}/${encodeURIComponent(board.slug)}` +
        `?mode=json&limit=${PAGE_SIZE}&skip=${page * PAGE_SIZE}`;
      const rows = await boardJson<LeverPosting[]>(ctx, url);

      // A missing board on the first page is a dead slug; on a later page it is
      // simply the end of the list.
      if (!Array.isArray(rows) || rows.length === 0) break;
      all.push(...rows);
      if (rows.length < PAGE_SIZE) break;

      if (page === MAX_PAGES - 1) {
        ctx.log?.({
          level: 'info',
          source: 'lever',
          message: `${board.company}: stopped after ${all.length} postings — the board is larger than we page through`,
        });
      }
    }

    return all;
  },

  toRawJob(item, board) {
    if (!item.id || !item.text) return null;

    const url = item.hostedUrl ?? `https://jobs.lever.co/${board.slug}/${item.id}`;
    const workplace = (item.workplaceType ?? '').toLowerCase();

    // Lever splits a posting across several fields: an intro, then one block per
    // requirements section, then a closing note. Only the concatenation is the
    // job description — the intro alone reads like a company blurb and would
    // score as a thin listing.
    const sections = [
      item.description ?? '',
      ...(item.lists ?? []).map((list) =>
        list.content ? `<h3>${list.text ?? ''}</h3>${list.content}` : '',
      ),
      item.additional ?? '',
    ].filter((section) => section.trim().length > 0);

    const salary = item.salaryRange;

    return {
      source: 'lever',
      sourceJobId: item.id,
      title: item.text,
      companyName: board.company,
      location: item.categories?.location ?? item.categories?.allLocations?.[0] ?? item.country,
      ...(workplace === 'remote' ? { isRemote: true } : {}),
      employmentType: employmentTypeFrom(item.categories?.commitment),
      description: sections.join('\n'),
      descriptionIsHtml: true,
      hasFullDescription: sections.length > 0,
      ...(salary?.min || salary?.max
        ? {
            salaryMin: salary.min,
            salaryMax: salary.max,
            salaryCurrency: salary.currency,
            salaryPeriod: periodFrom(salary.interval),
          }
        : {}),
      postedAt: item.createdAt ? new Date(item.createdAt).toISOString() : undefined,
      applyUrl: item.applyUrl ?? url,
      sourceUrl: url,
      atsType: 'lever',
      companyCareersUrl: `https://jobs.lever.co/${board.slug}`,
    } satisfies RawJob;
  },
};

export function createLeverProvider(options: BoardProviderOptions = {}): JobProvider {
  return createBoardProvider(adapter, options);
}

export const leverAdapter: BoardAdapter<LeverPosting> = adapter;
export type { LeverPosting };
