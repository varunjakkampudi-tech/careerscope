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
  jobFingerprint,
  normalizeJob,
  type JobProvider,
} from '@job-radar/providers';
import { buildCandidateContext, scoreJob } from '@job-radar/matching';

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
  // CS-78: passed straight through, with no `application` override. What used
  // to be here — `application: { ...profile.application, currentCtc: '',
  // noticePeriodDays: 0 }` — was not blanking sensitive values that were
  // present. `MatchingProfile` has never carried those two fields; the override
  // FABRICATED them, because V1's `MatchableProfile` demanded the full
  // `ApplicationDetails` and V2 deliberately snapshots only three fields.
  //
  // That stub was the actual hazard, and it was worse than a type mismatch: it
  // satisfied the type, so if the matcher had ever started reading
  // `noticePeriodDays` it would have read this fabricated `0` — a plausible
  // value — and produced a silently wrong score with every check still green.
  // `MatchableProfile['application']` is now narrowed to exactly the three
  // fields `buildCandidateContext` reads, so the two shapes correspond, there
  // is nothing to invent, and a fourth-field read is a compile error at the
  // read site instead of a fabricated default two tiers away.
  const candidate = profile ? buildCandidateContext(profile) : null;
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
            sourceJobId: normalized.sourceJobId,
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
          // Recorded under both keys because dedup can later decide this
          // fingerprint is ambiguous (two different reqs, not two sources for
          // one role) and give the posting its own identity — at that point
          // only the per-(source, id) bucket is still the right one to read
          // back, since the shared-fingerprint bucket also holds a sibling
          // posting's links.
          const link = { source: normalized.source, url: normalized.sourceUrl };
          const linkKey = `${normalized.source}:${normalized.sourceUrl}`;
          for (const bucketKey of [
            normalized.fingerprint,
            `${normalized.source}:${normalized.sourceJobId}`,
          ]) {
            const links = sourceLinks.get(bucketKey) ?? new Map();
            links.set(linkKey, link);
            sourceLinks.set(bucketKey, links);
          }
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
        // A provider that ran without throwing but yielded nothing is not the
        // same claim as "found real results" - that silence is exactly what a
        // job board changing its markup looks like, and it must be visible as
        // its own state, not folded into 'completed'.
        status: errorCode ? 'failed' : collected === 0 ? 'empty' : 'completed',
        accepted: collected,
        limited: limited || collected >= 100,
        errorCode,
      }),
    );
  }
  for (const normalized of dedupeJobs(normalizedJobs)) {
    const match = candidate ? scoreJob(normalized, candidate, { now, windowDays: 30 }) : null;
    if (match?.excludedReason) continue;
    // A fingerprint that no longer matches this job's own title/company/city
    // was reassigned by dedup because the fingerprint was ambiguous; read the
    // links back from the narrower per-(source, id) bucket in that case, not
    // the shared one, which may also hold a sibling posting's links.
    const wasDisambiguated =
      normalized.fingerprint !==
      jobFingerprint(
        normalized.title,
        normalized.company.name,
        normalized.location,
        normalized.isRemote,
      );
    const linkBucketKey = wasDisambiguated
      ? `${normalized.source}:${normalized.sourceJobId}`
      : normalized.fingerprint;
    jobs.push(
      collectedJobSchema.parse({
        fingerprint: normalized.fingerprint,
        sourceJobId: normalized.sourceJobId,
        title: normalized.title,
        company: normalized.company.name,
        location: normalized.location,
        description: normalized.descriptionText,
        source: normalized.source,
        sourceUrl: normalized.sourceUrl,
        sourceLinks: [...(sourceLinks.get(linkBucketKey)?.values() ?? [])],
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
        emptySources: result.outcomes.filter((outcome) => outcome.status === 'empty').length,
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
    const settled = await database.completeCollection(command, fence, result.jobs, result.outcomes);
    // Checked after the current outcome is itself on record, so a streak that
    // completes on this exact run is visible - not just streaks that were
    // already five deep before this run started. A source ran without error
    // but found nothing across several consecutive runs, system-wide - the
    // exact shape a job board's markup breaking looks like from here. One
    // empty run is unremarkable; a streak is not.
    //
    // This whole block is a diagnostic side effect on an already-successful
    // search - a transient failure here (e.g. a momentary Postgres error)
    // must never surface as if the search itself failed. Its own try/catch
    // keeps that failure mode from riding on the handler's real exception
    // path (Independent Reviewer finding CS-23-B).
    try {
      const EMPTY_STREAK_THRESHOLD = 5;
      for (const outcome of result.outcomes) {
        if (outcome.status !== 'empty') continue;
        const recent = await database.recentSourceStatuses(outcome.source, EMPTY_STREAK_THRESHOLD);
        if (recent.length >= EMPTY_STREAK_THRESHOLD && recent.every((status) => status === 'empty'))
          logger.warn(
            { source: outcome.source, consecutiveEmptyRuns: recent.length },
            'Source has returned zero results for consecutive runs across all owners; its provider may need attention',
          );
      }
    } catch (error) {
      logger.error({ error }, 'Empty-streak check failed; the search itself still completed');
    }
    return settled;
  };
}
