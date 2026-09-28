import type { QueryClient } from '@tanstack/react-query';

declare global {
  interface Window {
    /** Explicitly enabled only by the CS-61 browser experiment. */
    __CAREERSCOPE_DISABLE_CACHE_CLEAR__?: boolean;
  }
}

/**
 * Clear private query state on an auth boundary transition. The browser
 * experiment can disable this deliberately to prove owner-scoped keys are
 * sufficient even when the reset policy is absent; production keeps the
 * defensive reset by default.
 */
export function clearAuthQueryCache(cache: QueryClient): void {
  if (typeof window !== 'undefined' && window.__CAREERSCOPE_DISABLE_CACHE_CLEAR__) return;
  cache.clear();
}
