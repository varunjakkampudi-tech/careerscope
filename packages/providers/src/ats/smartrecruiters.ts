/**
 * SmartRecruiters.
 *
 * The most India-relevant of the six — Swiggy, Freshworks, Unacademy, Upstox
 * and Whatfix all run their boards here — and the only one with a genuinely
 * paginated list endpoint that reports its own total, so paging is exact rather
 * than "keep going until a short page".
 *
 * The list omits descriptions, so this is a list → filter → `fetchDetail` flow
 * like Greenhouse's. The detail payload is the richest of any ATS: it carries a
 * structured location (including remote/hybrid flags), an employment type, a
 * seniority label, and a description already split into the sections the
 * matching engine wants to weight differently — `jobDescription` and
 * `qualifications` are the two that carry skills, and `companyDescription` is
 * marketing that would dilute them, so it is placed last rather than first.
 */

import type { RawJob } from '@job-radar/shared';
import type { JobProvider } from '../types.js';
import { employmentTypeFrom } from '../normalize.js';
import {
  boardJson,
  boardScopedId,
  createBoardProvider,
  splitBoardScopedId,
  type BoardAdapter,
  type BoardProviderOptions,
} from './base.js';

const API = 'https://api.smartrecruiters.com/v1/companies';

/** The documented maximum; asking for more is silently capped. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

interface SmartRecruitersLocation {
  city?: string;
  region?: string;
  country?: string;
  remote?: boolean;
  hybrid?: boolean;
  fullLocation?: string;
}

interface SmartRecruitersPosting {
  id?: string;
  name?: string;
  company?: { identifier?: string; name?: string };
  location?: SmartRecruitersLocation;
  releasedDate?: string;
  typeOfEmployment?: { id?: string; label?: string };
  experienceLevel?: { id?: string; label?: string };
  /** Detail endpoint only. */
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: {
    sections?: {
      companyDescription?: { title?: string; text?: string };
      jobDescription?: { title?: string; text?: string };
      qualifications?: { title?: string; text?: string };
      additionalInformation?: { title?: string; text?: string };
    };
  };
}

interface SmartRecruitersPage {
  offset?: number;
  limit?: number;
  totalFound?: number;
  content?: SmartRecruitersPosting[];
}

function locationOf(location: SmartRecruitersLocation | undefined): string | undefined {
  if (!location) return undefined;
  if (location.fullLocation?.trim()) return location.fullLocation.trim();
  const parts = [location.city, location.region, location.country]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return parts.length > 0 ? [...new Set(parts)].join(', ') : undefined;
}

/**
 * Assemble the description, skills-bearing sections first.
 *
 * Each section keeps its own heading so the extractor can still tell
 * requirements from perks — that distinction is what drives the required-vs-
 * preferred skill weighting, and flattening the sections into one blob would
 * throw it away.
 */
function descriptionOf(posting: SmartRecruitersPosting | null): string {
  const sections = posting?.jobAd?.sections;
  if (!sections) return '';
  return [
    sections.jobDescription,
    sections.qualifications,
    sections.additionalInformation,
    sections.companyDescription,
  ]
    .filter((section) => Boolean(section?.text?.trim()))
    .map((section) => `<h3>${section?.title ?? ''}</h3>${section?.text ?? ''}`)
    .join('\n');
}

const adapter: BoardAdapter<SmartRecruitersPosting> = {
  id: 'smartrecruiters',
  label: 'SmartRecruiters',

  async listBoard(board, ctx) {
    const all: SmartRecruitersPosting[] = [];

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url =
        `${API}/${encodeURIComponent(board.slug)}/postings` +
        `?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`;
      const payload = await boardJson<SmartRecruitersPage>(ctx, url);

      const content = payload?.content ?? [];
      if (content.length === 0) break;
      all.push(...content);

      // The endpoint reports its own total, so we know when we are done rather
      // than inferring it from a short page.
      const total = payload?.totalFound ?? all.length;
      if (all.length >= total || content.length < PAGE_SIZE) break;
    }

    return all;
  },

  toRawJob(item, board) {
    if (!item.id || !item.name) return null;

    const url = item.postingUrl ?? `https://jobs.smartrecruiters.com/${board.slug}/${item.id}`;
    const description = descriptionOf(item);
    const remote = item.location?.remote === true;

    return {
      source: 'smartrecruiters',
      sourceJobId: boardScopedId(board.slug, item.id),
      title: item.name,
      companyName: item.company?.name?.trim() || board.company,
      location: locationOf(item.location),
      ...(remote ? { isRemote: true } : {}),
      employmentType: employmentTypeFrom(item.typeOfEmployment?.label ?? item.typeOfEmployment?.id),
      description,
      descriptionIsHtml: true,
      // The list endpoint has no `jobAd` at all, so this is false until
      // `fetchDetail` runs — which is what keeps the low-confidence clamp honest.
      hasFullDescription: description.length > 0,
      postedAt: item.releasedDate,
      applyUrl: item.applyUrl ?? url,
      sourceUrl: url,
      atsType: 'smartrecruiters',
      companyCareersUrl: `https://jobs.smartrecruiters.com/${board.slug}`,
    } satisfies RawJob;
  },

  async fetchDetail(job, ctx) {
    const parts = splitBoardScopedId(job.sourceJobId);
    if (!parts) return job;

    const detail = await boardJson<SmartRecruitersPosting>(
      ctx,
      `${API}/${encodeURIComponent(parts.slug)}/postings/${encodeURIComponent(parts.id)}`,
    );
    const description = descriptionOf(detail);
    if (!description) return job;

    return {
      ...job,
      description,
      descriptionIsHtml: true,
      hasFullDescription: true,
      // The detail payload knows things the list did not: whether the role is
      // remote, and what it is actually called on the employer's own site.
      ...(detail?.location?.remote === true ? { isRemote: true } : {}),
      location: locationOf(detail?.location) ?? job.location,
      employmentType:
        employmentTypeFrom(detail?.typeOfEmployment?.label) ?? job.employmentType ?? null,
      applyUrl: detail?.applyUrl ?? job.applyUrl,
    };
  },
};

export function createSmartRecruitersProvider(options: BoardProviderOptions = {}): JobProvider {
  return createBoardProvider(adapter, options);
}

export const smartRecruitersAdapter: BoardAdapter<SmartRecruitersPosting> = adapter;
export type { SmartRecruitersPosting };
