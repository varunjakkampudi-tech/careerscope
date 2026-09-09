import { describe, expect, it } from 'vitest';
import {
  filtersFromParams,
  paramsFromFilters,
  freshMatchFilters,
  savedShortlistFilters,
} from './Leads';

describe('lead match threshold', () => {
  it('includes all saved leads without hiding older or lower-scored choices', () => {
    const filters = filtersFromParams(paramsFromFilters(savedShortlistFilters(), null), []);
    expect(filters.statuses).toEqual(['saved']);
    expect(filters.minScore).toBe(0);
    expect(filters.postedWithinDays).toBeUndefined();
    expect(filters.sort).toBe('score');
  });
  it('round-trips the fresh match queue without stale filters or an open drawer', () => {
    const params = paramsFromFilters(freshMatchFilters(), null);
    const filters = filtersFromParams(params, []);
    expect(filters).toMatchObject({
      minScore: 0.85,
      postedWithinDays: 1,
      statuses: ['new', 'saved'],
      sort: 'postedAt',
      order: 'desc',
    });
    expect(params.has('lead')).toBe(false);
    expect(filters.search).toBeUndefined();
    expect(filters.runId).toBeUndefined();
    expect(filters.sources).toBeUndefined();
  });
  it('defaults to 0% unless an explicit default is supplied', () => {
    expect(filtersFromParams(new URLSearchParams(), []).minScore).toBe(0);
    expect(filtersFromParams(new URLSearchParams(), [], 0.92).minScore).toBe(0.92);
  });

  it('keeps an explicit URL threshold above the saved default', () => {
    expect(filtersFromParams(new URLSearchParams('minScore=0.8'), [], 0.92).minScore).toBe(0.8);
  });

  it('preserves an explicit return to 85% when the saved threshold differs', () => {
    const filters = filtersFromParams(new URLSearchParams('minScore=0.85'), [], 0.92);
    const params = paramsFromFilters(filters, null);
    expect(params.get('minScore')).toBe('0.85');
    expect(filtersFromParams(params, [], 0.92).minScore).toBe(0.85);
  });
});
