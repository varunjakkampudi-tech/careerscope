import {
  collectedJobSchema,
  collectionStatus,
  logger,
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
  createGreenhouseProvider,
  createLeverProvider,
  createWorkableProvider,
  dedupeJobs,
  HttpClient,
  normalizeJob,
  type JobProvider,
} from '../../../../../packages/providers/dist/index.js';
import { buildCandidateContext, scoreJob } from '../../../../../packages/matching/dist/index.js';

const providerFactories = {
  remoteok: createRemoteOkProvider,
  himalayas: createHimalayasProvider,
  greenhouse: createGreenhouseProvider,
  lever: createLeverProvider,
  workable: createWorkableProvider,
};

export async function collect(
  request: CreateSearch,
  signal: AbortSignal,
  providers: JobProvider | JobProvider[] = request.sources.map((source) =>
    providerFactories[source](),
  ),
  http = new HttpClient({ timeoutMs: 20_000, retries: 1, maxBytes: 2_000_000 }),
  options: { profile?: MatchingProfile | null; now?: number } = {},
) {
  const combined = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
  const jobs: CollectedJob[] = [];
  const normalizedJobs: ReturnType<typeof normalizeJob>[] = [];
  const sourceLinks = new Map<string, Map<string, { source: string; url: string }>>();
  const now = options.now ?? Date.now();
  const profile = options.profile;
  const titles = request.useProfileTitles
    ? [
        ...new Map(
          (profile?.preferences.titles ?? [])
            .map((title) => title.trim().replace(/\s+/g, ' '))
            .filter((title) => title.length >= 2 && title.length <= 160)
            .map((title) => [title.toLowerCase(), title]),
        ).values(),
      ].slice(0, 5)
    : [request.query];
  if (!titles.length) throw new Error('Saved target roles are required for profile discovery');
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
    let detailed = 0;
    let limited = false;
    let errorCode: SourceOutcome['errorCode'] = null;
    const sourceSignal = AbortSignal.any([
      combined,
      AbortSignal.timeout(Math.min(25_000, Math.floor(55_000 / selected.length))),
    ]);
    const context = {
      http,
      signal: sourceSignal,
      log: (event: { level: string; limited?: boolean }) => {
        if (event.limited) limited = true;
        if (event.level === 'warn' || event.level === 'error') errorCode = 'source_failed';
      },
    };
    try {
      for await (const raw of provider.search(
        {
          titles,
          locations: profile?.preferences.locations ?? [],
          excludeKeywords: profile?.preferences.excludeKeywords ?? [],
          remoteOnly: profile?.preferences.remoteOnly ?? false,
          employmentTypes: profile?.preferences.employmentTypes ?? [],
          postedWithinDays: 30,
          maxResults: 100,
        },
        context,
      )) {
        sourceSignal.throwIfAborted();
        try {
          if (raw.source !== provider.id) throw new Error('Source attribution mismatch');
          let enriched = raw;
          if (!raw.hasFullDescription && provider.fetchDetail && detailed < 20) {
            detailed += 1;
            try {
              enriched = await provider.fetchDetail(raw, context);
            } catch {
              combined.throwIfAborted();
              errorCode = sourceSignal.aborted ? 'source_timeout' : 'source_failed';
            }
          }
          if (enriched.source !== provider.id) throw new Error('Source attribution mismatch');
          const normalized = normalizeJob(enriched, { now });
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
          const links = sourceLinks.get(normalized.fingerprint) ?? new Map();
          links.set(`${normalized.source}:${normalized.sourceUrl}`, {
            source: normalized.source,
            url: normalized.sourceUrl,
          });
          sourceLinks.set(normalized.fingerprint, links);
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
        limited: limited || collected >= 100,
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
        sourceLinks: [...(sourceLinks.get(normalized.fingerprint)?.values() ?? [])],
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
    const started = performance.now();
    const result = await collect(search.request, signal, providers, undefined, {
      profile: search.matchingProfile,
      now: search.createdAt.getTime(),
    });
    // Per-source outcome so a failing or throttled provider is identifiable.
    logger.info(
      {
        runId: command.aggregateId,
        fence,
        durationMs: Math.round(performance.now() - started),
        accepted: result.jobs.length,
        failedSources: result.outcomes.filter((outcome) => outcome.status === 'failed').length,
        limitedSources: result.outcomes.filter((outcome) => outcome.limited).length,
        sources: result.outcomes.map((outcome) => ({
          source: outcome.source,
          status: outcome.status,
          accepted: outcome.accepted,
          limited: outcome.limited,
          errorCode: outcome.errorCode,
        })),
      },
      'Search collection finished',
    );
    signal.throwIfAborted();
    return database.completeCollection(command, fence, result.jobs, result.outcomes);
  };
}
