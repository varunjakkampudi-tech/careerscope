/** Query-cache helper for authentication transitions; works with the keys built in `session.ts`. */

import type { QueryClient } from '@tanstack/react-query';

/**
 * Clear private query state on every authentication boundary transition.
 * User-scoped query keys provide a second isolation boundary, but must never
 * be treated as a reason to retain another session's private cache.
 */
export function clearAuthQueryCache(cache: QueryClient): void {
  cache.clear();
}
