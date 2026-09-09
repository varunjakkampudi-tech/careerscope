/**
 * Recruitee.
 *
 * The simplest of the six and the most generous: one unauthenticated GET
 * returns every posting on a board with the description, the requirements, a
 * structured salary, an employment-type code, and — uniquely among the six ATS
 * APIs — a real careers mailbox the employer configured themselves.
 *
 * That last field is worth calling out. The app's rule is that a contact
 * address is only ever shown when it was *observed*, never constructed from a
 * company name, because a fabricated `careers@` that bounces is worse than an
 * honest "apply via portal". `mailbox_email` comes from the employer's own
 * board configuration, which makes it the strongest provenance of any source
 * here — stronger even than a `mailto:` scraped off a careers page.
 *
 * The board is per-subdomain (`{slug}.recruitee.com`), not per-path, so the
 * slug is interpolated into the host. It is restricted to the characters a
 * hostname label may contain before it goes anywhere near a URL.
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

/**
 * A board token becomes part of the hostname, where percent-encoding does not
 * apply. Anything outside this set could redirect the request to another host
 * entirely, so it is rejected rather than escaped.
 */
const SAFE_SUBDOMAIN = /^[a-z0-9][a-z0-9-]{0,62}$/i;

/** Local parts that indicate a recruiting mailbox rather than a personal one. */
const CAREERS_MAILBOX = /^(careers?|jobs?|hr|recruit(ing|ment)?|talent|hiring|apply|work)\b/i;

interface RecruiteeOffer {
  id?: number | string;
  slug?: string;
  title?: string;
  description?: string;
  requirements?: string;
  careers_url?: string;
  careers_apply_url?: string;
  location?: string;
  city?: string;
  country_code?: string;
  remote?: boolean;
  on_site?: boolean;
  hybrid?: boolean;
  employment_type_code?: string;
  salary?: {
    min?: number | string | null;
    max?: number | string | null;
    period?: string | null;
    currency?: string | null;
  } | null;
  created_at?: string;
  published_at?: string;
  company_name?: string;
  department?: string;
  tags?: string[];
  mailbox_email?: string;
}

/** Recruitee returns salary bounds as strings on some boards and numbers on others. */
function amount(value: number | string | null | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value.replace(/[,\s]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Keep the mailbox only when it reads as a recruiting address.
 *
 * A board can be configured with a named recruiter's personal inbox. Surfacing
 * that in a leads table invites the user to cold-mail an individual, which is
 * both worse outreach and not what they asked for.
 */
function careersEmail(value: string | undefined): string | undefined {
  const email = value?.trim().toLowerCase();
  if (!email || !email.includes('@')) return undefined;
  return CAREERS_MAILBOX.test(email) ? email : undefined;
}

const adapter: BoardAdapter<RecruiteeOffer> = {
  id: 'recruitee',
  label: 'Recruitee',

  async listBoard(board, ctx) {
    if (!SAFE_SUBDOMAIN.test(board.slug)) {
      ctx.log?.({
        level: 'warn',
        source: 'recruitee',
        message: `${board.company}: "${board.slug}" is not a usable board subdomain — skipped`,
      });
      return [];
    }

    const payload = await boardJson<{ offers?: RecruiteeOffer[] }>(
      ctx,
      `https://${board.slug}.recruitee.com/api/offers/`,
    );
    return payload?.offers ?? [];
  },

  toRawJob(item, board) {
    const id = item.id != null ? String(item.id) : item.slug;
    if (!id || !item.title) return null;

    const url = item.careers_url ?? `https://${board.slug}.recruitee.com/o/${item.slug ?? id}`;
    const sections = [item.description, item.requirements].filter((section): section is string =>
      Boolean(section?.trim()),
    );
    const min = amount(item.salary?.min);
    const max = amount(item.salary?.max);
    const email = careersEmail(item.mailbox_email);

    return {
      source: 'recruitee',
      sourceJobId: id,
      title: item.title,
      companyName: item.company_name?.trim() || board.company,
      location:
        item.location?.trim() ||
        [item.city, item.country_code].filter(Boolean).join(', ') ||
        undefined,
      ...(item.remote === true ? { isRemote: true } : {}),
      employmentType: employmentTypeFrom(item.employment_type_code),
      description: sections.join('\n'),
      descriptionIsHtml: true,
      hasFullDescription: sections.length > 0,
      ...(min || max
        ? {
            salaryMin: min,
            salaryMax: max,
            salaryCurrency: item.salary?.currency ?? undefined,
            salaryPeriod: periodFrom(item.salary?.period),
          }
        : {}),
      postedAt: item.published_at ?? item.created_at,
      applyUrl: item.careers_apply_url ?? url,
      sourceUrl: url,
      atsType: 'recruitee',
      companyCareersUrl: `https://${board.slug}.recruitee.com/`,
      ...(email ? { companyCareersEmail: email } : {}),
    } satisfies RawJob;
  },
};

export function createRecruiteeProvider(options: BoardProviderOptions = {}): JobProvider {
  return createBoardProvider(adapter, options);
}

export const recruiteeAdapter: BoardAdapter<RecruiteeOffer> = adapter;
export type { RecruiteeOffer };
