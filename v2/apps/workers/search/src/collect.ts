import {
  collectedJobSchema,
  collectionStatus,
  sourceOutcomeSchema,
  sourceOutcomesSchema,
  type CollectedJob,
  type CreateSearch,
  type Database,
  type Handler,
  type MatchingProfile,
  type SourceOutcome,
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
  const selected = Array.isArray(providers) ? providers : [providers];
  if (
    selected.length !== request.sources.length ||
    new Set(selected.map((provider) => provider.id)).size !== selected.length ||
    selected.some((provider) => !request.sources.some((source) => source === provider.id))
  )
    throw new Error('Providers must match selected sources');
  const outcomes: SourceOutcome[] = [];
  for (const provider of selected) {
    combined.throwIfAborted();
    let collected = 0;
    let errorCode: SourceOutcome['errorCode'] = null;
    const sourceSignal = AbortSignal.any([combined, AbortSignal.timeout(25_000)]);
    try {
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
          signal: sourceSignal,
          log: (event) => {
            if (event.level === 'warn' || event.level === 'error') errorCode = 'source_failed';
          },
        },
      )) {
        sourceSignal.throwIfAborted();
        try {
          if (raw.source !== provider.id) throw new Error('Source attribution mismatch');
          const normalized = normalizeJob(raw, { now });
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
            match: null,
          });
          normalizedJobs.push(normalized);
          collected += 1;
        } catch {
          errorCode = 'invalid_response';
          break;
        }
        if (collected >= 100) break;
      }
      sourceSignal.throwIfAborted();
    } catch {
      combined.throwIfAborted();
      errorCode = sourceSignal.aborted ? 'source_timeout' : 'source_failed';
    }
    combined.throwIfAborted();
    outcomes.push(
      sourceOutcomeSchema.parse({
        source: provider.id,
        status: errorCode ? 'failed' : 'completed',
        accepted: collected,
        limited: collected >= 100,
        errorCode,
      }),
    );
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
  const results = jobs
    .sort(
      (left, right) =>
        (right.match?.score ?? 0) - (left.match?.score ?? 0) ||
        left.fingerprint.localeCompare(right.fingerprint),
    )
    .slice(0, 100);
  return {
    jobs: results,
    outcomes: sourceOutcomesSchema.parse(outcomes),
    status: collectionStatus(results, outcomes),
  };
}

export function searchHandler(database: Database, providers?: JobProvider[]): Handler {
  return async (command, fence, signal) => {
    if (command.type !== 'search.collect') throw new Error('Unsupported search command');
    const search = await database.getSearch(command.ownerId, command.aggregateId);
    if (!search || !['queued', 'running'].includes(search.status))
      throw new Error('Search cannot run');
    if (!(await database.startSearch(command, fence))) return false;
    const result = await collect(search.request, signal, providers, undefined, {
      profile: search.matchingProfile,
      now: search.createdAt.getTime(),
    });
    signal.throwIfAborted();
    return database.completeCollection(command, fence, result.jobs, result.outcomes);
  };
}
