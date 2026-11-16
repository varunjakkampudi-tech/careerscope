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
        outcome({ source: 'lever', status: 'failed', errorCode: 'source_timeout' }),
        outcome({
          source: 'greenhouse',
          status: 'failed',
          errorCode: 'source_permission_pending',
        }),
      ],
    },
    {
      createdAt: '2026-11-17T09:00:00.000Z',
      sourceOutcomes: [
        outcome({ source: 'lever', status: 'empty' }),
        outcome({ source: 'greenhouse', status: 'completed', accepted: 4, limited: true }),
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
      latestStatus: 'failed',
      latestErrorCode: 'source_permission_pending',
      latestLimited: false,
      latestObservedAt: '2026-11-17T10:00:00.000Z',
    },
    {
      source: 'lever',
      observations: 2,
      completed: 0,
      empty: 1,
      failed: 1,
      permissionPending: 0,
      accepted: 0,
      latestStatus: 'failed',
      latestErrorCode: 'source_timeout',
      latestLimited: false,
      latestObservedAt: '2026-11-17T10:00:00.000Z',
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
