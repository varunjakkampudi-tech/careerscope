/**
 * Greenhouse.
 *
 * The list endpoint is the whole board but **without descriptions**, and there
 * is a `?content=true` variant that includes them. We deliberately do not use
 * it: measured against the live API, Stripe's board is 0.37 MB without content
 * and 4.54 MB with it, and Databricks' is 9.02 MB — past the client's body
 * ceiling, which would lose that board entirely.
 *
 * So the flow is list → filter on title and location → fetch the description
 * only for postings that survived. For a 869-posting board where the user is
 * interested in a dozen, that is a dozen small requests instead of one enormous
 * one, and it is the difference between the board working and not.
 */

import { decodeEntities } from '../html.js';
import type { JobProvider } from '../types.js';
import {
  boardJson,
  boardScopedId,
  createBoardProvider,
  splitBoardScopedId,
  type BoardAdapter,
  type BoardProviderOptions,
} from './base.js';

const API = 'https://boards-api.greenhouse.io/v1/boards';

interface GreenhouseJob {
  id: number;
  title?: string;
  absolute_url?: string;
  location?: { name?: string } | null;
  updated_at?: string;
  first_published?: string;
  company_name?: string;
  /** Present only on the detail endpoint, and HTML-escaped when it is. */
  content?: string;
}

const adapter: BoardAdapter<GreenhouseJob> = {
  id: 'greenhouse',
  label: 'Greenhouse',

  async listBoard(board, ctx) {
    const payload = await boardJson<{ jobs?: GreenhouseJob[] }>(
      ctx,
      `${API}/${encodeURIComponent(board.slug)}/jobs`,
    );
    return payload?.jobs ?? [];
  },

  toRawJob(item, board) {
    if (!item.id || !item.title) return null;
    const url =
      item.absolute_url ?? `https://job-boards.greenhouse.io/${board.slug}/jobs/${item.id}`;

    return {
      source: 'greenhouse',
      sourceJobId: boardScopedId(board.slug, item.id),
      title: item.title,
      // The board's own `company_name` is more current than our curated label:
      // it follows a rebrand the day it happens.
      companyName: item.company_name?.trim() || board.company,
      location: item.location?.name ?? undefined,
      // No description yet — `fetchDetail` supplies it, and until then the
      // matching engine must treat this listing as low confidence.
      hasFullDescription: false,
      postedAt: item.first_published ?? item.updated_at,
      applyUrl: url,
      sourceUrl: url,
      atsType: 'greenhouse',
      companyCareersUrl: `https://job-boards.greenhouse.io/${board.slug}`,
    };
  },

  async fetchDetail(job, ctx) {
    const parts = splitBoardScopedId(job.sourceJobId);
    if (!parts) return job;

    const detail = await boardJson<GreenhouseJob>(
      ctx,
      `${API}/${encodeURIComponent(parts.slug)}/jobs/${encodeURIComponent(parts.id)}`,
    );
    // `content` arrives HTML-escaped — `&lt;p&gt;` rather than `<p>` — so it has
    // to be unescaped before it is HTML at all.
    const content = detail?.content ? decodeEntities(detail.content) : '';
    if (!content.trim()) return job;

    return {
      ...job,
      description: content,
      descriptionIsHtml: true,
      hasFullDescription: true,
    };
  },
};

export function createGreenhouseProvider(options: BoardProviderOptions = {}): JobProvider {
  return createBoardProvider(adapter, options);
}

/** Exported for the fixture tests, which exercise mapping without the network. */
export const greenhouseAdapter: BoardAdapter<GreenhouseJob> = adapter;
export type { GreenhouseJob };
