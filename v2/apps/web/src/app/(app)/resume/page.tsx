'use client';

import { lazy, Suspense } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';
import { setHasUnsavedChanges } from '@/lib/unsaved-changes';
import { LoadingState } from '@/components/ui-states';

const ProfileEditor = lazy(() => import('@/components/profile-editor'));

export default function ResumePage() {
  const router = useRouter();
  const session = useSession();
  return (
    <Suspense fallback={<LoadingState message="Loading profile…" />}>
      <ProfileEditor
        csrf={session.data?.csrf ?? ''}
        onDirty={setHasUnsavedChanges}
        onBack={() => router.push('/dashboard')}
      />
    </Suspense>
  );
}
