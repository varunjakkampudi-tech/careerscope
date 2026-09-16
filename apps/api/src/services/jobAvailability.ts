import type { HttpClient } from '@job-radar/providers';
import type { Job } from '@job-radar/shared';
import type { Repos } from '../db/repo/index.js';

export type JobAvailability = 'open' | 'removed' | 'unknown';

export async function removeWithdrawnLeads(
  repos: Repos,
  http: HttpClient,
  signal: AbortSignal,
  at: string,
): Promise<{ checked: number; removed: number; unknown: number }> {
  const key = 'leads.removalCheckCursor';
  const cursor = repos.settings.get(key) ?? '';
  let candidates = repos.leads.removalCandidates(cursor, 25);
  if (candidates.length === 0 && cursor) candidates = repos.leads.removalCandidates('', 25);
  const scoped = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  const result = { checked: 0, removed: 0, unknown: 0 };
  for (const lead of candidates) {
    if (scoped.aborted) break;
    const availability = await checkJobAvailability(lead.job, http, scoped);
    if (scoped.aborted) break;
    result.checked += 1;
    if (availability === 'removed' && repos.leads.deleteConfirmedRemoved(lead)) result.removed += 1;
    if (availability === 'unknown') result.unknown += 1;
    repos.settings.set(key, lead.id, at);
  }
  return result;
}

export async function checkJobAvailability(
  job: Pick<Job, 'source' | 'sourceJobId' | 'sourceUrl'>,
  http: HttpClient,
  signal: AbortSignal,
): Promise<JobAvailability> {
  try {
    const url = new URL(job.sourceUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return 'unknown';
    let boardUrl: string;
    let jobUrl: string;
    let postingId = job.sourceJobId;
    if (job.source === 'greenhouse') {
      const scopedId = /^([a-zA-Z0-9_-]+):(\d+)$/.exec(job.sourceJobId);
      const hosted = ['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(url.hostname);
      const path = hosted ? /^\/([a-zA-Z0-9_-]+)\/jobs\/(\d+)\/?$/.exec(url.pathname) : null;
      postingId = scopedId?.[2] ?? job.sourceJobId;
      const slug = scopedId?.[1] ?? path?.[1];
      if (!slug || !/^\d+$/.test(postingId)) return 'unknown';
      if (
        hosted
          ? !path || path[1] !== slug || path[2] !== postingId
          : !scopedId ||
            url.searchParams.getAll('gh_jid').length !== 1 ||
            url.searchParams.get('gh_jid') !== postingId
      )
        return 'unknown';
      boardUrl = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
      jobUrl = `${boardUrl}/${postingId}`;
    } else if (
      job.source === 'lever' &&
      ['jobs.lever.co', 'jobs.eu.lever.co'].includes(url.hostname)
    ) {
      const match = /^\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9-]+)\/?$/.exec(url.pathname);
      if (!match || match[2] !== job.sourceJobId) return 'unknown';
      const host = url.hostname === 'jobs.eu.lever.co' ? 'api.eu.lever.co' : 'api.lever.co';
      boardUrl = `https://${host}/v0/postings/${match[1]}?mode=json`;
      jobUrl = `https://${host}/v0/postings/${match[1]}/${match[2]}?mode=json`;
    } else {
      return 'unknown';
    }

    const options = {
      signal,
      noCache: true,
      retries: 0,
      timeoutMs: 5_000,
      maxBytes: 2 * 1024 * 1024,
      acceptStatuses: [404, 410],
    };
    const response = await http.get(jobUrl, options);
    if (response.url !== jobUrl) return 'unknown';
    const detail: unknown = JSON.parse(response.body);
    if (response.status === 200) {
      return detail !== null &&
        typeof detail === 'object' &&
        'id' in detail &&
        String(detail.id) === postingId
        ? 'open'
        : 'unknown';
    }
    if (![404, 410].includes(response.status)) return 'unknown';
    const board = await http.get(boardUrl, options);
    if (board.status !== 200 || board.url !== boardUrl) return 'unknown';
    const payload: unknown = JSON.parse(board.body);
    const postings: unknown =
      job.source === 'greenhouse' &&
      payload !== null &&
      typeof payload === 'object' &&
      'jobs' in payload
        ? payload.jobs
        : payload;
    if (!Array.isArray(postings)) return 'unknown';
    if (
      postings.some(
        (posting: unknown) =>
          posting === null ||
          typeof posting !== 'object' ||
          !('id' in posting) ||
          String(posting.id) === postingId,
      )
    )
      return 'unknown';
    return signal.aborted ? 'unknown' : 'removed';
  } catch {
    return 'unknown';
  }
}
