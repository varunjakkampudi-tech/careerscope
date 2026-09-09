/**
 * Ordering and failure-reporting shared by every provider family.
 *
 * Both provider shapes — the company-scoped ATS walk and the global remote
 * feeds — end up in the same position: more postings in hand than the result
 * budget allows, and a decision about which to keep. That decision belongs in
 * one place, because "which jobs the user never sees" is not something two
 * copies of a comparator should be allowed to disagree about.
 */

import type { RawJob } from '@job-radar/shared';
import { titleRelevance } from './filter.js';
import { HttpError } from './http.js';

/**
 * Order postings so the ones kept under a cap are the ones worth keeping:
 * closest to a target title first, then most recently posted. With no target
 * titles configured, freshness is the only signal available.
 *
 * Sorts in place, and never returns NaN from the comparator — an inconsistent
 * comparator produces a different order on every engine, which would make a
 * capped result set irreproducible.
 */
export function rankByRelevance(jobs: RawJob[], titles: readonly string[]): void {
  if (jobs.length < 2) return;

  if (titles.length === 0) {
    jobs.sort((a, b) => postedTime(b) - postedTime(a));
    return;
  }

  const relevance = new Map<RawJob, number>();
  for (const job of jobs) relevance.set(job, titleRelevance(job.title, titles));
  jobs.sort(
    (a, b) => (relevance.get(b) ?? 0) - (relevance.get(a) ?? 0) || postedTime(b) - postedTime(a),
  );
}

/** Epoch ms, or 0 — never NaN, which would make the comparator inconsistent. */
export function postedTime(job: RawJob): number {
  const at = Date.parse(job.postedAt ?? '');
  return Number.isFinite(at) ? at : 0;
}

/**
 * A one-line cause, written for the run log the user reads.
 *
 * The run log is a user-facing surface, so a failed request reads as "HTTP 503"
 * rather than dumping a stack or a URL — some of those carry API keys.
 */
export function describeFailure(error: unknown): string {
  if (error instanceof HttpError) {
    return error.status === null ? `${error.kind}: ${error.message}` : `HTTP ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}
