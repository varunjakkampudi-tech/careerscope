/**
 * Workable.
 *
 * The awkward one, for two reasons.
 *
 * **The list endpoint is a POST**, not a GET — it takes a filter object and
 * returns `{ total, results, nextPage }`. And it returns only **ten postings a
 * page**, which is not a detail: Apna's board has 127 postings, so a
 * single-page implementation would show the user 8% of an employer and look
 * like it had shown them all of it.
 *
 * **How the `nextPage` token is passed could not be verified.** The probe that
 * would have settled it — token in the query string vs. token in the body — was
 * rate-limited on every attempt, and shipping a guess here has a specific,
 * nasty failure mode: a token the API does not recognise is *ignored*, not
 * rejected, so the wrong guess silently re-fetches page one forever. That reads
 * as "this company only has ten jobs" while quietly duplicating them.
 *
 * So the mode is settled at runtime instead of at authoring time. The first
 * board that needs a second page tries the query-string form, checks whether
 * the response actually contains postings it has not already seen, and falls
 * back to the body form if it does not. Whichever advances is remembered for
 * the rest of the run, so the discovery costs at most one extra request. If
 * neither advances, paging stops rather than looping — the guard is the
 * unseen-shortcode check, so a token mechanism we never anticipated degrades to
 * "first page only" instead of to duplicates.
 *
 * List items carry no description; `fetchDetail` supplies it from the posting
 * endpoint, which returns it split across `description`, `requirements` and
 * `benefits`.
 */

import type { RawJob } from '@job-radar/shared';
import type { JobProvider, ProviderContext } from '../types.js';
import { employmentTypeFrom } from '../normalize.js';
import {
  boardJson,
  boardPostJson,
  boardScopedId,
  createBoardProvider,
  splitBoardScopedId,
  type BoardAdapter,
  type BoardProviderOptions,
} from './base.js';

const API = 'https://apply.workable.com/api/v1/accounts';

/** The board returns ten at a time regardless of what we ask for. */
const MAX_PAGES = 20;

/** The empty filter: every posting on the board. */
const ALL_JOBS = {
  query: '',
  location: [] as string[],
  department: [] as string[],
  worktype: [] as string[],
  remote: [] as string[],
} as const;

/** How the `nextPage` token is passed. Discovered on first use. */
type PageMode = 'query' | 'body' | 'unpaged';

interface WorkableLocation {
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
  workplace?: string;
  telecommuting?: boolean;
}

interface WorkableJob {
  id?: string | number;
  shortcode?: string;
  title?: string;
  /** An object on the list endpoint; some deployments answer with a string. */
  location?: WorkableLocation | string;
  department?: string | string[];
  employmentType?: string;
  type?: string;
  telecommuting?: boolean;
  remote?: boolean;
  published?: string;
  publishedOn?: string;
  created_at?: string;
  /** Detail endpoint only. */
  description?: string;
  requirements?: string;
  benefits?: string;
}

interface WorkablePage {
  total?: number;
  results?: WorkableJob[];
  nextPage?: string | null;
}

/**
 * Read a location out of either shape the endpoint answers with.
 *
 * The field names below are the ones the detail endpoint was verified to use.
 * Anything unrecognised yields `undefined`, which the pre-filter treats as
 * "unknown location" and passes through — the failure mode is a job that gets
 * scored without a location, not a job that is wrongly discarded.
 */
function locationOf(location: WorkableJob['location']): string | undefined {
  if (typeof location === 'string') return location.trim() || undefined;
  if (!location) return undefined;
  const parts = [location.city, location.region, location.country ?? location.countryCode]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? [...new Set(parts)].join(', ') : undefined;
}

function isRemote(item: WorkableJob): boolean {
  if (item.telecommuting === true || item.remote === true) return true;
  const workplace = typeof item.location === 'object' ? item.location?.workplace : undefined;
  return (workplace ?? '').toLowerCase() === 'remote';
}

/**
 * Built per provider so the discovered page mode is scoped to one run rather
 * than to the module — a process-wide cache would leak one test's answer into
 * the next.
 */
export function createWorkableAdapter(): BoardAdapter<WorkableJob> {
  let mode: PageMode | null = null;

  async function fetchPage(
    ctx: ProviderContext,
    slug: string,
    token: string | null,
    via: PageMode,
  ): Promise<WorkablePage | null> {
    const query = token && via === 'query' ? `?token=${encodeURIComponent(token)}` : '';
    const body = token && via === 'body' ? { ...ALL_JOBS, token } : ALL_JOBS;
    return boardPostJson<WorkablePage>(
      ctx,
      `${API}/${encodeURIComponent(slug)}/jobs${query}`,
      body,
    );
  }

  /** Postings on `page` that we have not already collected. */
  function freshOf(page: WorkablePage | null, seen: Set<string>): WorkableJob[] {
    return (page?.results ?? []).filter((job) => {
      const key = job.shortcode ?? String(job.id ?? '');
      return key !== '' && !seen.has(key);
    });
  }

  return {
    id: 'workable',
    label: 'Workable',

    async listBoard(board, ctx) {
      const first = await fetchPage(ctx, board.slug, null, 'query');
      if (!first?.results?.length) return [];

      const all: WorkableJob[] = [];
      const seen = new Set<string>();
      const absorb = (jobs: WorkableJob[]): void => {
        for (const job of jobs) {
          seen.add(job.shortcode ?? String(job.id ?? ''));
          all.push(job);
        }
      };
      absorb(first.results);

      let token = first.nextPage ?? null;
      for (let page = 1; token && page < MAX_PAGES; page += 1) {
        if (ctx.signal?.aborted) break;

        let next: WorkablePage | null = null;
        let fresh: WorkableJob[] = [];

        if (mode === null) {
          // One-time discovery: try each form and keep whichever returns
          // postings we have not seen. An ignored token returns page one, which
          // this check reads as "no new postings".
          for (const candidate of ['query', 'body'] as const) {
            next = await fetchPage(ctx, board.slug, token, candidate);
            fresh = freshOf(next, seen);
            if (fresh.length > 0) {
              mode = candidate;
              break;
            }
          }
          if (mode === null) mode = 'unpaged';
          ctx.log?.({
            level: 'info',
            source: 'workable',
            message:
              mode === 'unpaged'
                ? 'pagination token was not accepted in either form — reading first pages only'
                : `pagination confirmed: nextPage travels in the ${mode}`,
          });
        } else if (mode !== 'unpaged') {
          next = await fetchPage(ctx, board.slug, token, mode);
          fresh = freshOf(next, seen);
        }

        if (fresh.length === 0) break;
        absorb(fresh);
        token = next?.nextPage ?? null;
      }

      return all;
    },

    toRawJob(item, board) {
      const code = item.shortcode ?? (item.id != null ? String(item.id) : '');
      if (!code || !item.title) return null;

      const url = `https://apply.workable.com/${board.slug}/j/${code}/`;
      const sections = [item.description, item.requirements, item.benefits].filter(
        (section): section is string => Boolean(section?.trim()),
      );

      return {
        source: 'workable',
        sourceJobId: boardScopedId(board.slug, code),
        title: item.title,
        companyName: board.company,
        location: locationOf(item.location),
        ...(isRemote(item) ? { isRemote: true } : {}),
        employmentType: employmentTypeFrom(item.employmentType ?? item.type),
        description: sections.join('\n'),
        descriptionIsHtml: true,
        hasFullDescription: sections.length > 0,
        postedAt: item.published ?? item.publishedOn ?? item.created_at,
        applyUrl: url,
        sourceUrl: url,
        atsType: 'workable',
        companyCareersUrl: `https://apply.workable.com/${board.slug}/`,
      } satisfies RawJob;
    },

    async fetchDetail(job, ctx) {
      const parts = splitBoardScopedId(job.sourceJobId);
      if (!parts) return job;

      // The detail endpoint is a GET even though the list endpoint is a POST.
      const detail = await boardJson<WorkableJob>(
        ctx,
        `${API}/${encodeURIComponent(parts.slug)}/jobs/${encodeURIComponent(parts.id)}`,
      );
      // Workable splits one description across three fields. Requirements is
      // where the skills live, so dropping it would gut the match score.
      const sections = [detail?.description, detail?.requirements, detail?.benefits].filter(
        (section): section is string => Boolean(section?.trim()),
      );
      if (sections.length === 0) return job;

      return {
        ...job,
        description: sections.join('\n'),
        descriptionIsHtml: true,
        hasFullDescription: true,
      };
    },
  };
}

export function createWorkableProvider(options: BoardProviderOptions = {}): JobProvider {
  return createBoardProvider(createWorkableAdapter(), options);
}

export type { WorkableJob };
