export const SEARCH_RESULTS_PER_PAGE = 20;

export interface SearchPage<T> {
  items: T[];
  page: number;
  pageCount: number;
  firstItem: number;
  lastItem: number;
}

/** Return a bounded page window while keeping an out-of-range page on the last page. */
export function paginateSearchResults<T>(
  items: readonly T[],
  requestedPage: number,
  pageSize = SEARCH_RESULTS_PER_PAGE,
): SearchPage<T> {
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError('pageSize must be a positive integer');
  }

  const pageCount = Math.max(1, Math.ceil(items.length / pageSize));
  const normalizedPage = Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 1;
  const page = Math.min(Math.max(1, normalizedPage), pageCount);
  const start = (page - 1) * pageSize;
  const pageItems = items.slice(start, start + pageSize);

  return {
    items: pageItems,
    page,
    pageCount,
    firstItem: pageItems.length === 0 ? 0 : start + 1,
    lastItem: start + pageItems.length,
  };
}
