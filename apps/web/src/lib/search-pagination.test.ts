import assert from 'node:assert/strict';
import test from 'node:test';
import { paginateSearchResults, SEARCH_RESULTS_PER_PAGE } from './search-pagination.js';

test('search results are divided into stable bounded pages', () => {
  const values = Array.from({ length: 45 }, (_, index) => index + 1);

  assert.deepEqual(paginateSearchResults(values, 1), {
    items: values.slice(0, 20),
    page: 1,
    pageCount: 3,
    firstItem: 1,
    lastItem: 20,
  });
  assert.deepEqual(paginateSearchResults(values, 2), {
    items: values.slice(20, 40),
    page: 2,
    pageCount: 3,
    firstItem: 21,
    lastItem: 40,
  });
  assert.deepEqual(paginateSearchResults(values, 3), {
    items: values.slice(40),
    page: 3,
    pageCount: 3,
    firstItem: 41,
    lastItem: 45,
  });
  assert.equal(SEARCH_RESULTS_PER_PAGE, 20);
});

test('empty and filtered result sets never expose invalid page ranges', () => {
  assert.deepEqual(paginateSearchResults([], 4), {
    items: [],
    page: 1,
    pageCount: 1,
    firstItem: 0,
    lastItem: 0,
  });
  assert.deepEqual(paginateSearchResults(['a', 'b'], 99, 1), {
    items: ['b'],
    page: 2,
    pageCount: 2,
    firstItem: 2,
    lastItem: 2,
  });
});

test('invalid page sizes are rejected', () => {
  assert.throws(() => paginateSearchResults([1], 1, 0), RangeError);
  assert.throws(() => paginateSearchResults([1], 1, 1.5), RangeError);
});
