'use client';

import { useEffect, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, SESSION_EXPIRED_EVENT } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { hasUnsavedChanges } from '@/lib/unsaved-changes';
import { clearAuthQueryCache } from '@/lib/query-cache';
import {
  DashboardMobileNav,
  DashboardSidebar,
  DashboardTopbar,
  navKeyForPath,
} from './dashboard-shell';
import { ErrorState, LoadingState } from './ui-states';
import styles from './dashboard-shell.module.css';

// The one place CS-6 requires: every authenticated route renders through
// this component, and it is the only place that decides whether private
// content may render at all. An unauthenticated or still-resolving visit
// never reaches `children` — it sees a neutral loading state or is bounced
// to `/`, never so much as a flash of the shell or any page's data.
export default function AuthenticatedShell({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const cache = useQueryClient();
  const session = useSession();
  const { theme, toggle } = useTheme();
  const authenticated = session.data?.authenticated === true;

  useEffect(() => {
    // CS-36 (review P3, 2026-09-25): this is the THIRD teardown path, and it
    // was the only one that did not clear the cache. The other two — logout
    // and SESSION_EXPIRED_EVENT — both call `cache.clear()` below. A session
    // that resolves as unauthenticated WITHOUT a 401 (so `api()` never
    // dispatches the expiry event) redirected to `/` while leaving every data
    // key intact, so the next owner to sign in could be served the previous
    // one's cached profile and leads. Narrow, because a 401 is the usual way
    // a session ends — but a teardown path that skips the reset is exactly the
    // kind of gap that stops being narrow after one unrelated refactor.
    if (session.isSuccess && !authenticated) {
      clearAuthQueryCache(cache);
      router.replace('/');
    }
  }, [authenticated, cache, router, session.isSuccess]);

  // The single 401 handler for every route (Independent Reviewer finding 2,
  // 2026-09-23): previously three routes each implemented their own ad hoc
  // detection and two routes — Resume and Settings — had none, leaving an
  // expired session there stuck on an inline error with a Retry button that
  // could only fail again. `api()` announces every 401 here; this is now the
  // only place that resets the session and redirects, closing finding 3's
  // two-redirect race at the same time.
  //
  // CS-36 (Independent Reviewer finding 2, 2026-09-24): a genuinely expired
  // session cannot be usefully "waited out" — the confirm dialog below does
  // not retry or extend anything, it only makes sure the owner is not
  // silently redirected away from unsaved notes/profile edits without a
  // chance to notice, matching the discard-confirmation pattern already
  // used for in-app navigation in saved-leads.tsx and profile-editor.tsx.
  useEffect(() => {
    const onExpired = () => {
      if (
        hasUnsavedChanges() &&
        !window.confirm('Your session expired. Unsaved changes will be lost. Continue to sign in?')
      )
        return;
      clearAuthQueryCache(cache);
      router.replace('/?expired=1');
    };
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [cache, router]);

  // The single sign-out action every authenticated route can reach through
  // the shared topbar, replacing the one copy that used to live in the old
  // monolithic page.tsx header.
  const logout = useMutation({
    mutationFn: () =>
      api('/logout', { method: 'POST', headers: { 'x-csrf-token': session.data?.csrf ?? '' } }),
    onSuccess: async () => {
      clearAuthQueryCache(cache);
      // Logout changes the owner-discovery query just as login does. Refresh
      // it explicitly so the CS-61 experiment can retain owner-private cache
      // entries without retaining an authenticated session identity.
      await session.refetch();
      router.replace('/');
    },
  });

  if (session.isPending) {
    return <LoadingState message="Loading workspace…" />;
  }
  if (session.isError) {
    return (
      <ErrorState
        title="Workspace unavailable"
        message="Could not reach the local service."
        onRetry={() => session.refetch()}
      />
    );
  }
  if (!authenticated) return null;

  const active = navKeyForPath(pathname);
  return (
    <div className={styles.shell} data-theme={theme}>
      <a className={styles.skipLink} href="#main-content">
        Skip to content
      </a>
      <DashboardSidebar active={active} email={session.data?.email} />
      <div className={styles.main}>
        <DashboardTopbar
          theme={theme}
          onToggleTheme={toggle}
          email={session.data?.email}
          onSignOut={() => {
            if (!logout.isPending && window.confirm('Sign out?')) logout.mutate();
          }}
          signOutPending={logout.isPending}
        />
        <DashboardMobileNav active={active} />
        <main id="main-content" className={styles.content} tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
