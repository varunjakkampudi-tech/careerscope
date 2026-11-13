'use client';

import { lazy, Suspense, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';
import { setHasUnsavedChanges } from '@/lib/unsaved-changes';
import { LoadingState } from '@/components/ui-states';
import styles from './page.module.css';

const ProfileEditor = lazy(() => import('@/components/profile-editor'));

export default function ResumePage() {
  const router = useRouter();
  const session = useSession();
  useEffect(() => {
    setHasUnsavedChanges(false);
  }, [session.data?.owner]);
  return (
    <Suspense fallback={<LoadingState message="Loading profile…" />}>
      <div className={styles.resumePage}>
        <ProfileEditor
          key={session.data?.owner ?? '__no-owner__'}
          csrf={session.data?.csrf ?? ''}
          onDirty={setHasUnsavedChanges}
          onBack={() => router.push('/dashboard')}
        />
      </div>
    </Suspense>
  );
}
