/** Re-score stored search results after a successfully parsed resume changes. */

import {
  applyConfidenceCeiling,
  buildCandidateContext,
  combine,
  scoreJob,
} from '@careerscope/matching';
import { normalizeJob } from '@careerscope/providers';
import { logger, type CollectedJob, type Database, type Handler } from '@careerscope/core';

function scoreInput(data: CollectedJob, createdAt: Date) {
  if (data.matchingInput) return { job: data.matchingInput, exact: true };
  return {
    job: normalizeJob(
      {
        source: data.source,
        sourceJobId: data.sourceJobId ?? data.fingerprint,
        title: data.title,
        companyName: data.company,
        location: data.location,
        description: data.description,
        hasFullDescription: data.match?.confidence === 'high',
        postedAt: data.postedAt ?? undefined,
        sourceUrl: data.sourceUrl,
        applyUrl: data.applyUrl,
      },
      { now: createdAt.getTime() },
    ),
    exact: false,
  };
}

export function resumeRecomputeHandler(database: Database): Handler {
  return async (command, fence, signal) => {
    if (command.type !== 'search.recompute') throw new Error('Unsupported recompute command');
    signal.throwIfAborted();
    const snapshot = await database.resumeRecomputeSnapshot(command.ownerId);
    const searches = snapshot.searches.flatMap((search) => {
      const candidate = search.matchingProfile
        ? buildCandidateContext(search.matchingProfile)
        : null;
      return [
        {
          id: search.id,
          profileRevision: search.profileRevision,
          matchingProfile: search.matchingProfile,
          jobs: search.jobs.map((job) => ({
            fingerprint: job.fingerprint,
            match: candidate
              ? (() => {
                  const input = scoreInput(job.data, search.createdAt);
                  const rescored = scoreJob(input.job, candidate, {
                    now: search.createdAt.getTime(),
                    windowDays: 30,
                  });
                  const previous = job.data.match;
                  if (!previous) return rescored;
                  // Legacy display rows do not retain remote/employment details, so keep a
                  // previous hard exclusion when its original input cannot be reconstructed.
                  if (previous.excludedReason && !input.exact)
                    return { ...previous, resumeConsidered: candidate.resumeConsidered };
                  if (rescored.excludedReason) return rescored;
                  const dimensions = {
                    ...rescored.dimensions,
                    location: previous.dimensions.location,
                    compensation: previous.dimensions.compensation,
                    recency: previous.dimensions.recency,
                  };
                  const heuristicScore = combine(dimensions);
                  return {
                    ...rescored,
                    dimensions,
                    heuristicScore,
                    score: applyConfidenceCeiling(heuristicScore, previous.confidence),
                    confidence: previous.confidence,
                  };
                })()
              : null,
          })),
        },
      ];
    });
    signal.throwIfAborted();
    const committed = await database.completeResumeRecompute(command, fence, {
      sourceUploadId: snapshot.sourceUploadId,
      searches,
    });
    if (committed)
      logger.info(
        { runCount: searches.length },
        'Stored search matches refreshed after a successfully parsed resume',
      );
    return committed;
  };
}
