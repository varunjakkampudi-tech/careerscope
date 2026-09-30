'use client';

import { Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import SavedLeads from '@/components/saved-leads';
import { useSession } from '@/lib/session';
import { setHasUnsavedChanges } from '@/lib/unsaved-changes';

function SavedWorkspace() {
  const router = useRouter();
  const params = useSearchParams();
  const session = useSession();
  return (
    <SavedLeads
      csrf={session.data?.csrf ?? ''}
      // A lead is deep-linkable (forensic audit F-2/F-8): `?lead=` opens that
      // lead on arrival instead of this screen always starting empty. The id
      // is not trusted here — it is handed to the same owner-scoped
      // GET /api/leads/:id the list itself uses, so an unknown, malformed or
      // foreign-owner id lands in this screen's existing lead error state.
      initialId={params.get('lead')}
      onDirty={setHasUnsavedChanges}
      onBack={() => router.push('/dashboard')}
    />
  );
}

// `useSearchParams()` requires a Suspense boundary in the App Router.
export default function SavedPage() {
  return (
    <Suspense fallback={null}>
      <SavedWorkspace />
    </Suspense>
  );
}
