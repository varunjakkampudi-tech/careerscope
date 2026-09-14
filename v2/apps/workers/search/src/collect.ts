import {
  collectedJobSchema,
  type CollectedJob,
  type CreateSearch,
  type Database,
  type Handler,
  type MatchingProfile,
} from '@careerscope/core';
import {
  createRemoteOkProvider,
  createHimalayasProvider,
  dedupeJobs,
  HttpClient,
  normalizeJob,
  type JobProvider,
} from '../../../../../packages/providers/dist/index.js';
import { buildCandidateContext, scoreJob } from '../../../../../packages/matching/dist/index.js';

export async function collect(
  request: CreateSearch,
  signal: AbortSignal,
  providers: JobProvider | JobProvider[] = request.sources.map((source) =>
    source === 'remoteok' ? createRemoteOkProvider() : createHimalayasProvider(),
  ),
  http = new HttpClient({ timeoutMs: 20_000, retries: 1, maxBytes: 2_000_000 }),
  options: { profile?: MatchingProfile | null; now?: number } = {},
) {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const jobs: CollectedJob[] = [];
  const normalizedJobs: ReturnType<typeof normalizeJob>[] = [];
  const now = options.now ?? Date.now();
  const profile = options.profile;
  const candidate = profile
    ? buildCandidateContext({
        ...profile,
        application: { ...profile.application, currentCtc: '', noticePeriodDays: 0 },
        derived: null,
      })
    : null;
  let failed = false;
  for (const provider of Array.isArray(providers) ? providers : [providers]) {
    combined.throwIfAborted();
    let collected = 0;
    for await (const raw of provider.search(
      {
        titles: [request.query],
        locations: profile?.preferences.locations ?? [],
        excludeKeywords: profile?.preferences.excludeKeywords ?? [],
        remoteOnly: profile?.preferences.remoteOnly ?? false,
        employmentTypes: profile?.preferences.employmentTypes ?? [],
        postedWithinDays: 30,
        maxResults: 100,
      },
      {
        http,
        signal: combined,
        log: (event) => {
          if (event.level === 'warn' || event.level === 'error') failed = true;
        },
      },
    )) {
      combined.throwIfAborted();
      normalizedJobs.push(normalizeJob(raw, { now }));
      collected += 1;
      if (collected >= 100) break;
    }
    combined.throwIfAborted();
    if (failed) throw new Error('Provider collection failed');
  }
  for (const normalized of dedupeJobs(normalizedJobs)) {
    const match = candidate ? scoreJob(normalized, candidate, { now, windowDays: 30 }) : null;
    if (match?.excludedReason) continue;
    jobs.push(
      collectedJobSchema.parse({
        fingerprint: normalized.fingerprint,
        title: normalized.title,
        company: normalized.company.name,
        location: normalized.location,
        description: normalized.descriptionText,
        source: normalized.source,
        sourceUrl: normalized.sourceUrl,
        applyUrl: normalized.applyUrl,
        postedAt: normalized.postedAt,
        match,
      }),
    );
  }
  combined.throwIfAborted();
  return jobs
    .sort(
      (left, right) =>
        (right.match?.score ?? 0) - (left.match?.score ?? 0) ||
        left.fingerprint.localeCompare(right.fingerprint),
    )
    .slice(0, 100);
}

export function searchHandler(database: Database): Handler {
  return async (command, fence, signal) => {
    if (command.type !== 'search.collect') throw new Error('Unsupported search command');
    const search = await database.getSearch(command.ownerId, command.aggregateId);
    if (!search || !['queued', 'running'].includes(search.status))
      throw new Error('Search cannot run');
    const jobs = await collect(search.request, signal, undefined, undefined, {
      profile: search.matchingProfile,
      now: search.createdAt.getTime(),
    });
    signal.throwIfAborted();
    return database.complete(command, fence, jobs);
  };
}
