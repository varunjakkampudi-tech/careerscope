/**
 * Search collection: runs the selected providers for one search, normalises, de-duplicates and scores
 * jobs, and settles the result through `Database`. `searchHandler` is the queue handler used by
 * `main.ts`; providers come from `@careerscope/providers` and scoring from `@careerscope/matching`.
 */

import {
  collectedJobSchema,
  collectionStatus,
  logFailure,
  logger,
  sourceOutcomeSchema,
  sourceOutcomesSchema,
  type CollectedJob,
  type CreateSearchInput,
  type Database,
  type Handler,
  type MatchingProfile,
  type SourceOutcome,
} from '@careerscope/core';
import {
  createRemoteOkProvider,
  createHimalayasProvider,
  createAshbyProvider,
  createGreenhouseProvider,
  createLeverProvider,
  createWorkableProvider,
  dedupeJobs,
  HttpClient,
  jobFingerprint,
  normalizeJob,
  type JobProvider,
} from '@careerscope/providers';
import { buildCandidateContext, scoreJob } from '@careerscope/matching';
import { isJobSourcePermittedForCandidateDiscovery, type SourceId } from '@careerscope/shared';

/** Provider constructors for the sources a search may request. Must stay in step with `searchSourceSchema` in `@careerscope/core`. */
const providerFactories = {
  remoteok: createRemoteOkProvider,
  himalayas: createHimalayasProvider,
  greenhouse: createGreenhouseProvider,
  lever: createLeverProvider,
  ashby: createAshbyProvider,
  workable: createWorkableProvider,
};

/** Dot-joined field paths of a Zod validation error; empty for any other error. Never includes values. */
function issuePaths(error: unknown): string[] {
  const issues = (error as { issues?: unknown } | null)?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.map((issue: { path?: unknown }) =>
    Array.isArray(issue.path) ? issue.path.map(String).join('.') || '(root)' : '(root)',
  );
}

/**
 * Runs one provider per requested source and returns scored jobs (best first, at most 100), a
 * per-source outcome and the overall status. The whole run has a 60 second limit and each source a
 * share of it. A failing source is recorded as a failed outcome without stopping the others;
 * cancellation of `signal` aborts the run. `options.now` and `options.profile` make it deterministic and enable scoring.
 */
export async function collect(
  request: CreateSearchInput,
  signal: AbortSignal,
  providers: JobProvider | JobProvider[] = request.sources.map((source) =>
    providerFactories[source](),
  ),
  http = new HttpClient({ timeoutMs: 20_000, retries: 1, maxBytes: 2_000_000 }),
  options: { profile?: MatchingProfile | null; now?: number } = {},
) {
  // Overall limit for the run; each source below also gets its own slice so one slow source cannot use all of it.
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
  // The profile is passed straight through, with no `application` override.
  // `MatchingProfile` snapshots only the three application fields scoring
  // reads (see `MatchableProfile` in `@careerscope/shared`), so there is
  // nothing to blank, and inventing the other fields would risk a silently wrong
  // score if the matcher ever started reading them.
  const candidate = profile ? buildCandidateContext(profile) : null;
  const selected = Array.isArray(providers) ? providers : [providers];
  if (
    selected.length !== request.sources.length ||
    new Set(selected.map((provider) => provider.id)).size !== selected.length ||
    selected.some((provider) => !request.sources.some((source) => source === provider.id))
  )
    throw new Error('Providers must match selected sources');
  // Each provider must match a requested source exactly (checked above), so outcomes line up with the request.
  const outcomes: SourceOutcome[] = [];
  for (const provider of selected) {
    combined.throwIfAborted();
    let collected = 0;
    let detailed = 0;
    let limited = false;
    let skipped = 0;
    const skippedPaths = new Set<string>();
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
          // At most 20 detail requests per source, so one source cannot spend the whole time budget on descriptions.
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
        } catch (error) {
          // One unusable posting must not end the provider's loop and discard the
          // rest of its results. Zod issue paths identify the field without
          // logging any posting content.
          skipped += 1;
          for (const path of issuePaths(error)) skippedPaths.add(path);
          continue;
        }
        if (collected >= 100) break;
      }
      sourceSignal.throwIfAborted();
    } catch {
      combined.throwIfAborted();
      errorCode = sourceSignal.aborted ? 'source_timeout' : 'source_failed';
    }
    combined.throwIfAborted();
    if (skipped > 0) {
      logger.warn(
        { source: provider.id, skipped, collected, fields: [...skippedPaths].slice(0, 20) },
        'Skipped postings that failed validation',
      );
      // Keeps the established outcome contract: a source that returned any malformed
      // posting is reported as an invalid response, while its valid postings are kept.
      errorCode = 'invalid_response';
    }
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
    // Hard-eligibility results are advice, not discovery filters: keep the
    // posting visible with its zero score and exact explanation.
    //
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

/**
 * Queue handler for `search.collect`. Sources without a current permission profile are not run and
 * are recorded as `source_permission_pending`; if none is permitted the search is completed with
 * only those outcomes. Otherwise it starts the run under the fence, collects, and settles atomically.
 * Returns false when the lease or fence was lost, so the queue retries.
 */
export function searchHandler(
  database: Database,
  providers?: JobProvider[],
  sourcePermitted: (source: SourceId) => boolean = isJobSourcePermittedForCandidateDiscovery,
): Handler {
  return async (command, fence, signal) => {
    if (command.type !== 'search.collect') throw new Error('Unsupported search command');
    const search = await database.getSearch(command.ownerId, command.aggregateId);
    if (!search || !['queued', 'running'].includes(search.status))
      throw new Error('Search cannot run');
    const permissionBySource = new Map(
      search.request.sources.map((source) => [source, sourcePermitted(source)]),
    );
    const permittedSources = search.request.sources.filter((source) =>
      permissionBySource.get(source),
    );
    if (permittedSources.length === 0) {
      const outcomes = search.request.sources.map((source) => ({
        source,
        status: 'failed' as const,
        accepted: 0,
        limited: false,
        errorCode: 'source_permission_pending' as const,
      }));
      logger.warn(
        { runId: command.aggregateId, sourceCount: outcomes.length },
        'Search was not run because a source lacks a current permission profile',
      );
      return database.completeCollection(command, fence, [], outcomes);
    }
    if (!(await database.startSearch(command, fence))) return false;
    const started = performance.now();
    const permittedRequest = { ...search.request, sources: permittedSources };
    const permittedSourceSet = new Set<SourceId>(permittedSources);
    const permittedProviders = providers?.filter((provider) => permittedSourceSet.has(provider.id));
    const result = await collect(permittedRequest, signal, permittedProviders, undefined, {
      profile: search.matchingProfile,
      now: search.createdAt.getTime(),
    });
    const deniedOutcome = (source: SourceId): SourceOutcome =>
      sourceOutcomeSchema.parse({
        source,
        status: 'failed',
        accepted: 0,
        limited: false,
        errorCode: 'source_permission_pending',
      });
    const outcomes = [
      ...result.outcomes,
      ...search.request.sources
        .filter((source) => !permissionBySource.get(source))
        .map(deniedOutcome),
    ];
    // Per-source outcome so a failing or throttled provider is identifiable.
    logger.info(
      {
        runId: command.aggregateId,
        fence,
        durationMs: Math.round(performance.now() - started),
        accepted: result.jobs.length,
        failedSources: outcomes.filter((outcome) => outcome.status === 'failed').length,
        emptySources: outcomes.filter((outcome) => outcome.status === 'empty').length,
        limitedSources: outcomes.filter((outcome) => outcome.limited).length,
        sources: outcomes.map((outcome) => ({
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
    const settled = await database.completeCollection(command, fence, result.jobs, outcomes);
    // Checked after the current outcome is on record, so a streak that completes
    // on this run is counted. A source that runs without error but finds nothing
    // across several consecutive runs, system-wide, looks like a job board's
    // markup breaking. One empty run is unremarkable; a streak is not.
    //
    // This is a diagnostic side effect on an already-successful search, so a
    // transient failure here (for example a momentary Postgres error) must not
    // surface as a search failure. It has its own try/catch for that reason.
    try {
      const EMPTY_STREAK_THRESHOLD = 5;
      for (const outcome of outcomes) {
        if (outcome.status !== 'empty') continue;
        const recent = await database.recentSourceStatuses(outcome.source, EMPTY_STREAK_THRESHOLD);
        if (recent.length >= EMPTY_STREAK_THRESHOLD && recent.every((status) => status === 'empty'))
          logger.warn(
            { source: outcome.source, consecutiveEmptyRuns: recent.length },
            'Source has returned zero results for consecutive runs across all owners; its provider may need attention',
          );
      }
    } catch (error) {
      logFailure(error, {}, 'Empty-streak check failed; the search itself still completed');
    }
    return settled;
  };
}
