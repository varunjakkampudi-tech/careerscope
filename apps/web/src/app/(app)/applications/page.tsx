'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import SavedLeads from '@/components/saved-leads';
import { useSession } from '@/lib/session';
import { setHasUnsavedChanges } from '@/lib/unsaved-changes';

// CS-50, honest v1: real leads filtered to the four "you applied" statuses,
// reusing SavedLeads (the same real data, status control and dated history
// as CS-19's shortlist) instead of a separate screen with a fabricated
// interview-stage timeline, AI insights panel or documents manager - none of
// which exist as real CareerScope capability today.
function ApplicationsWorkspace() {
  const router = useRouter();
  const params = useSearchParams();
  const session = useSession();
  return (
    <SavedLeads
      scope="applications"
      csrf={session.data?.csrf ?? ''}
      // Deep-linkable, on the same terms as /saved (forensic audit F-2/F-8).
      initialId={params.get('lead')}
      onDirty={setHasUnsavedChanges}
      onBack={() => router.push('/dashboard')}
    />
  );
}

// `useSearchParams()` requires a Suspense boundary in the App Router.
export default function ApplicationsPage() {
  return (
    <Suspense fallback={null}>
      <ApplicationsWorkspace />
    </Suspense>
  );
}
