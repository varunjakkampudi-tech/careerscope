import { describe, expect, it } from 'vitest';
import { filtersFromParams, paramsFromFilters } from './Leads';

describe('lead match threshold', () => {
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
