'use client';

import { lazy, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { useSession } from '@/lib/session';
import { LoadingState } from '@/components/ui-states';
import { clearAuthQueryCache } from '@/lib/query-cache';

const AccountSecurity = lazy(() => import('@/components/account-security'));

export default function SettingsPage() {
  const router = useRouter();
  const cache = useQueryClient();
  const session = useSession();
  return (
    <Suspense fallback={<LoadingState message="Loading account security…" />}>
      <AccountSecurity
        csrf={session.data?.csrf ?? ''}
        onBack={() => router.push('/dashboard')}
        onChanged={() => {
          // A password change invalidates every session, including this
          // one — the server has already signed everyone out, so the
          // client must land back on the sign-in screen rather than keep
          // presenting authenticated routes it can no longer use.
          clearAuthQueryCache(cache);
          router.replace('/?notice=security-changed');
        }}
      />
    </Suspense>
  );
}
