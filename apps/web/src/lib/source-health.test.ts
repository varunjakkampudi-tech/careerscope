import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeRecentSourceHealth } from './source-health.js';
import type { SearchSourceOutcome } from './api-schemas.js';

const outcome = (
  values: Partial<SearchSourceOutcome> & Pick<SearchSourceOutcome, 'source' | 'status'>,
): SearchSourceOutcome => ({
  accepted: 0,
  limited: false,
  errorCode: null,
  ...values,
});

test('source health summarizes recent owner-visible outcomes and latest state', () => {
  const summaries = summarizeRecentSourceHealth([
    {
      createdAt: '2026-11-17T10:00:00.000Z',
      sourceOutcomes: [
        outcome({
          source: 'lever',
          status: 'failed',
          errorCode: 'source_timeout',
          durationMs: 25_000,
        }),
        outcome({
          source: 'greenhouse',
          status: 'failed',
          errorCode: 'source_permission_pending',
          durationMs: null,
        }),
      ],
    },
    {
      createdAt: '2026-11-17T09:00:00.000Z',
      sourceOutcomes: [
        outcome({ source: 'lever', status: 'empty', durationMs: 300 }),
        outcome({
          source: 'greenhouse',
          status: 'completed',
          accepted: 4,
          limited: true,
          durationMs: 500,
        }),
      ],
    },
  ]);

  assert.deepEqual(summaries, [
    {
      source: 'greenhouse',
      observations: 2,
      completed: 1,
      empty: 0,
      failed: 1,
      permissionPending: 1,
      accepted: 4,
      latencyObservations: 1,
      averageDurationMs: 500,
      latestDurationMs: null,
      latestStatus: 'failed',
      latestErrorCode: 'source_permission_pending',
      latestLimited: false,
      latestRunAt: '2026-11-17T10:00:00.000Z',
    },
    {
      source: 'lever',
      observations: 2,
      completed: 0,
      empty: 1,
      failed: 1,
      permissionPending: 0,
      accepted: 0,
      latencyObservations: 2,
      averageDurationMs: 12650,
      latestDurationMs: 25_000,
      latestStatus: 'failed',
      latestErrorCode: 'source_timeout',
      latestLimited: false,
      latestRunAt: '2026-11-17T10:00:00.000Z',
    },
  ]);
});

test('empty histories and runs without source outcomes contribute no health signal', () => {
  assert.deepEqual(
    summarizeRecentSourceHealth([
      { createdAt: '2026-11-17T10:00:00.000Z', sourceOutcomes: null },
      { createdAt: '2026-11-17T09:00:00.000Z' },
    ]),
    [],
  );
});
