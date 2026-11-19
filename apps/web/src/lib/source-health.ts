import type { SearchSourceOutcome } from './api-schemas';

export interface SourceHealthRun {
  createdAt: string;
  sourceOutcomes?: SearchSourceOutcome[] | null;
}

export interface SourceHealthSummary {
  source: SearchSourceOutcome['source'];
  observations: number;
  completed: number;
  empty: number;
  failed: number;
  permissionPending: number;
  accepted: number;
  latencyObservations: number;
  averageDurationMs: number | null;
  latestDurationMs: number | null;
  latestStatus: SearchSourceOutcome['status'];
  latestErrorCode: SearchSourceOutcome['errorCode'];
  latestLimited: boolean;
  latestRunAt: string;
}

/** Summarize only owner-visible source outcomes, ordered newest source observation first. */
export function summarizeRecentSourceHealth(
  runs: readonly SourceHealthRun[],
): SourceHealthSummary[] {
  const summaries = new Map<SearchSourceOutcome['source'], SourceHealthSummary>();

  for (const run of runs) {
    for (const outcome of run.sourceOutcomes ?? []) {
      let summary = summaries.get(outcome.source);
      if (!summary) {
        summary = {
          source: outcome.source,
          observations: 0,
          completed: 0,
          empty: 0,
          failed: 0,
          permissionPending: 0,
          accepted: 0,
          latencyObservations: 0,
          averageDurationMs: null,
          latestDurationMs: outcome.durationMs ?? null,
          latestStatus: outcome.status,
          latestErrorCode: outcome.errorCode,
          latestLimited: outcome.limited,
          latestRunAt: run.createdAt,
        };
        summaries.set(outcome.source, summary);
      }

      summary.observations += 1;
      summary.accepted += outcome.accepted;
      if (outcome.durationMs !== null && outcome.durationMs !== undefined) {
        summary.averageDurationMs =
          ((summary.averageDurationMs ?? 0) * summary.latencyObservations + outcome.durationMs) /
          (summary.latencyObservations + 1);
        summary.latencyObservations += 1;
      }
      if (outcome.status === 'completed') summary.completed += 1;
      else if (outcome.status === 'empty') summary.empty += 1;
      else {
        summary.failed += 1;
        if (outcome.errorCode === 'source_permission_pending') summary.permissionPending += 1;
      }
    }
  }

  return [...summaries.values()].sort(
    (left, right) =>
      right.latestRunAt.localeCompare(left.latestRunAt) || left.source.localeCompare(right.source),
  );
}
