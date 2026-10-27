'use client';

import { lazy, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { LoadingState } from '@/components/ui-states';

const PreparationPanel = lazy(() => import('@/components/preparation-panel'));

export default function PreparationPage() {
  const router = useRouter();
  return (
    <Suspense fallback={<LoadingState message="Loading preparation…" />}>
      <PreparationPanel onProfile={() => router.push('/resume')} />
    </Suspense>
  );
}
