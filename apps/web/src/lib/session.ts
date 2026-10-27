/**
 * Session query and user-scoped query keys for the web app. Reads `/api/session` through `api.ts`;
 * every screen uses `useSession`, and `ownerKey` keeps one user's cached data from reaching another.
 */

import { useQuery } from '@tanstack/react-query';
import { apiParsed } from './api';
import { parseSession, type Session } from './api-schemas';

export type { Session };

/**
 * Sentinel used when no user is known. It never collides with a real digest
 * (which is 64 hex characters), and queries keyed with it are always disabled,
 * so **no cache entry is ever populated under it**.
 *
 * Without it, `['profile', owner]` with `owner === undefined` would silently
 * collapse to a user-agnostic key, letting one user's cache serve another.
 */
export const NO_OWNER = '__no-owner__';

/**
 * Build a user-scoped React Query key.
 *
 * The owner segment sits immediately after the name so that **prefix-based
 * invalidation keeps working** — `invalidateQueries({ queryKey: ['leads'] })`
 * still matches `['leads', owner, status]`.
 *
 * `['session']` is deliberately NOT scoped and must never be: it is the query
 * through which the user is discovered, so keying it by its own result would
 * be circular.
 */
export function ownerKey(
  owner: string | undefined,
  name: string,
  ...rest: readonly unknown[]
): readonly unknown[] {
  return [name, owner ?? NO_OWNER, ...rest];
}

/** The current user digest, or `undefined` when nobody is signed in. */
export function useOwner(): string | undefined {
  return useSession().data?.owner;
}

/**
 * The single session query every route reads. One `queryKey` means every caller shares one
 * in-flight request and one cache entry instead of each route re-querying `/session`.
 */
export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: ({ signal }) => apiParsed('/session', parseSession, { signal }),
    retry: 1,
  });
}
