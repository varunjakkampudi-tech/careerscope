'use client';

import { lazy, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';
import { LoadingState } from '@/components/ui-states';

const PreparationPanel = lazy(() => import('@/components/preparation-panel'));

export default function PreparationPage() {
  const router = useRouter();
  const session = useSession();
  return (
    <Suspense fallback={<LoadingState message="Loading preparation…" />}>
      <PreparationPanel onProfile={() => router.push('/resume')} csrf={session.data?.csrf ?? ''} />
    </Suspense>
  );
}
