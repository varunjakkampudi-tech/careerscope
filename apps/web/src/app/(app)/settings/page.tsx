'use client';

import { lazy, Suspense, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useSession } from '@/lib/session';
import { LoadingState } from '@/components/ui-states';
import InterfaceLanguagePreference from '@/components/interface-language-preference';
import { ArrowLeft } from 'lucide-react';
import { localizedText, useInterfaceLocale } from '@/lib/locale';
import styles from './page.module.css';

const AccountSecurity = lazy(() => import('@/components/account-security'));
const NotificationPreferences = lazy(() => import('@/components/notification-preferences'));

export default function SettingsPage() {
  const router = useRouter();
  const session = useSession();
  const locale = useInterfaceLocale();
  // Leaving while a sign-out request is in flight would drop its result, so the way back waits.
  const [signingOut, setSigningOut] = useState(false);
  return (
    <div className={styles.page} lang={locale}>
      <header className={styles.header}>
        <h1>{localizedText(locale, 'settings')}</h1>
        <button type="button" disabled={signingOut} onClick={() => router.push('/dashboard')}>
          <ArrowLeft size={18} aria-hidden="true" />
          {localizedText(locale, 'backToSearch')}
        </button>
      </header>
      <InterfaceLanguagePreference />
      <Suspense fallback={<LoadingState message="Loading account security…" />}>
        <AccountSecurity csrf={session.data?.csrf ?? ''} onBusyChange={setSigningOut} />
      </Suspense>
      <Suspense fallback={<LoadingState message="Loading notification preferences…" />}>
        <NotificationPreferences />
      </Suspense>
    </div>
  );
}
