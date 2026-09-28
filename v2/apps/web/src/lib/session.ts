import { useQuery } from '@tanstack/react-query';
import { api } from './api';

declare global {
  interface Window {
    /** Explicitly enabled only by the CS-61 paired positive control. */
    __CAREERSCOPE_TEST_OWNER_AGNOSTIC_KEYS__?: boolean;
  }
}

export type Session = {
  authenticated: boolean;
  csrf?: string;
  email?: string;
  registrationEnabled?: boolean;
  /**
   * Whether an AI provider is actually configured on the server (CS-48 F-1).
   * Screens must derive what they say about AI from this rather than from a
   * hardcoded string, because a fixed "AI inference off" caption becomes a
   * false statement the moment the feature is enabled.
   */
  aiEnabled?: boolean;
  /**
   * A stable, opaque per-owner digest (CS-61). Present **only** when
   * `authenticated` is true — the server's unauthenticated branch omits it.
   *
   * It is a SHA-256 digest of the owner id, not the id itself, and not
   * anything derived from the session token. Deliberately:
   *
   * - **not the raw `ownerId`** — every API route derives `ownerId` from the
   *   session and never from input, so publishing it would put the one value
   *   that must never be client-supplied into client hands;
   * - **not `email`** — that is optional and mutable, so it is an identity
   *   *proxy* rather than an identity, and an absent one silently produces an
   *   owner-agnostic key;
   * - **not per-session** — a value that changed on each sign-in would churn
   *   the whole cache for no extra isolation.
   */
  owner?: string;
};

/**
 * Sentinel used when no owner is known. It never collides with a real digest
 * (which is 64 hex characters), and queries keyed with it are always disabled,
 * so **no cache entry is ever populated under it**.
 *
 * Its purpose is to make the CS-61 defect unrepresentable rather than
 * discouraged: without it, `['profile', owner]` with `owner === undefined`
 * silently collapses back to an owner-agnostic key, which is exactly the bug.
 */
export const NO_OWNER = '__no-owner__';

/**
 * Build an owner-scoped React Query key.
 *
 * The owner segment sits immediately after the name so that **prefix-based
 * invalidation keeps working** — `invalidateQueries({ queryKey: ['leads'] })`
 * still matches `['leads', owner, status]`.
 *
 * `['session']` is deliberately NOT scoped and must never be: it is the query
 * through which the owner is discovered, so keying it by its own result would
 * be circular.
 */
export function ownerKey(
  owner: string | undefined,
  name: string,
  ...rest: readonly unknown[]
): readonly unknown[] {
  if (typeof window !== 'undefined' && window.__CAREERSCOPE_TEST_OWNER_AGNOSTIC_KEYS__ === true)
    return [name, ...rest];
  return [name, owner ?? NO_OWNER, ...rest];
}

/** The current owner digest, or `undefined` when nobody is signed in. */
export function useOwner(): string | undefined {
  return useSession().data?.owner;
}

// The single session query every route reads. One `queryKey` means every
// caller shares one in-flight request and one cache entry instead of each
// route re-querying `/session` independently — a real prerequisite for CS-6's
// "one routing definition... in a single place" rather than a cosmetic one.
export function useSession() {
  return useQuery({
    queryKey: ['session'],
    queryFn: ({ signal }) => api<Session>('/session', { signal }),
    retry: 1,
  });
}
