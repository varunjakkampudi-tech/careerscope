import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sortSearchJobs, type SortableSearchJob } from './job-search-sort.js';

const entries: SortableSearchJob[] = [
  {
    id: 'low-confidence',
    data: {
      title: 'Alpha',
      postedAt: '2026-02-01T00:00:00Z',
      match: { score: 0.99, confidence: 'low' },
    },
  },
  {
    id: 'newest',
    data: {
      title: 'Beta',
      postedAt: '2026-02-03T00:00:00Z',
      match: { score: 0.7, confidence: 'high' },
    },
  },
  {
    id: 'older-high',
    data: {
      title: 'Gamma',
      postedAt: '2026-02-02T00:00:00Z',
      match: { score: 0.8, confidence: 'high' },
    },
  },
  { id: 'unknown-date', data: { title: 'Delta', postedAt: null, match: null } },
];

describe('sortSearchJobs', () => {
  it('orders by match score, with stable date/title tie breaks and unknown scores last', () => {
    assert.deepEqual(
      sortSearchJobs(entries, 'match').map(({ id }) => id),
      ['low-confidence', 'older-high', 'newest', 'unknown-date'],
    );
  });

  it('puts high-confidence descriptions first, then uses match score', () => {
    assert.deepEqual(
      sortSearchJobs(entries, 'evidence').map(({ id }) => id),
      ['older-high', 'newest', 'low-confidence', 'unknown-date'],
    );
  });

  it('orders newest first and keeps undated postings last', () => {
    assert.deepEqual(
      sortSearchJobs(entries, 'newest').map(({ id }) => id),
      ['newest', 'older-high', 'low-confidence', 'unknown-date'],
    );
  });

  it('keeps invalid dates last and deterministically sorts multiple undated and unscored results', () => {
    const invalidAndUnknown: SortableSearchJob[] = [
      { id: 'missing-z', data: { title: 'Zulu', postedAt: null, match: null } },
      {
        id: 'invalid-date',
        data: {
          title: 'Invalid',
          postedAt: 'not-a-date',
          match: { score: 0.2, confidence: 'low' },
        },
      },
      { id: 'missing-a', data: { title: 'Alpha', postedAt: null, match: null } },
    ];

    assert.deepEqual(
      sortSearchJobs(invalidAndUnknown, 'newest').map(({ id }) => id),
      ['invalid-date', 'missing-a', 'missing-z'],
    );
    assert.deepEqual(
      sortSearchJobs(invalidAndUnknown, 'match').map(({ id }) => id),
      ['invalid-date', 'missing-a', 'missing-z'],
    );
  });

  it('does not mutate the cached source array', () => {
    const original = [...entries];
    sortSearchJobs(entries, 'newest');
    assert.deepEqual(entries, original);
  });

  it('uses locale-independent title and id tie breaks', () => {
    const tied = [
      {
        id: 'z',
        data: {
          title: 'Alpha',
          postedAt: null,
          match: { score: 0.5, confidence: 'high' as const },
        },
      },
      {
        id: 'b',
        data: { title: 'Beta', postedAt: null, match: { score: 0.5, confidence: 'high' as const } },
      },
      {
        id: 'a',
        data: { title: 'Beta', postedAt: null, match: { score: 0.5, confidence: 'high' as const } },
      },
    ];
    assert.deepEqual(
      sortSearchJobs(tied, 'match').map(({ id }) => id),
      ['z', 'a', 'b'],
    );
  });
});
