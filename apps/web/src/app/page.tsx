'use client';

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import AccountForm from '@/components/account-form';
import BrandLogo from '@/components/brand-logo';
import { LoadingState } from '@/components/ui-states';
import { useSession } from '@/lib/session';
import { clearAuthQueryCache } from '@/lib/query-cache';
import { localizedText, useInterfaceLocale } from '@/lib/locale';

function SignIn() {
  const router = useRouter();
  const cache = useQueryClient();
  const params = useSearchParams();
  const session = useSession();
  const locale = useInterfaceLocale();
  const t = (key: Parameters<typeof localizedText>[1]) => localizedText(locale, key);
  const authenticated = session.data?.authenticated === true;
  const expired = params.get('expired') === '1';
  const noticeParam = params.get('notice');
  const notice = noticeParam === 'rate_limited' ? t('noticeRateLimited') : '';

  useEffect(() => {
    // The one other authenticated-boundary redirect (CS-6): a signed-in
    // visitor to the sign-in screen has nothing to do here, so send them
    // straight to the real workspace rather than re-showing a form that
    // would just look broken next to an already-valid session.
    if (session.isSuccess && authenticated) router.replace('/dashboard');
  }, [authenticated, router, session.isSuccess]);

  return (
    <>
      <a className="skip-link" href="#workspace-content">
        {t('skipContent')}
      </a>
      <header className="topbar">
        <BrandLogo />
        <span className="brand-version">
          {session.data?.testUsersEnabled
            ? t('testModeBrandVersion')
            : session.data?.emailOtpEnabled
              ? t('secureEmailSignIn')
              : t('signInUnavailable')}
        </span>
      </header>
      <main id="workspace-content" tabIndex={-1}>
        {session.isPending ? (
          <LoadingState message={t('loadingWorkspace')} />
        ) : session.isError ? (
          <div className="state">
            <h1>{t('workspaceUnavailable')}</h1>
            <p role="alert">{t('localServiceError')}</p>
            <button onClick={() => session.refetch()}>
              <RefreshCw size={16} />
              {t('retry')}
            </button>
          </div>
        ) : authenticated ? null : (
          <AccountForm
            testUsersEnabled={session.data?.testUsersEnabled === true}
            emailOtpEnabled={session.data?.emailOtpEnabled === true}
            accounts={session.data?.testAccounts}
            registrationEnabled={session.data?.registrationEnabled === true}
            legalDocuments={session.data?.legalDocuments}
            expired={expired}
            notice={notice}
            onAuthenticated={async () => {
              clearAuthQueryCache(cache);
              // Authentication changes the identity discovered by this shared
              // query. Refresh it explicitly after the authenticated shell
              // clears private cache entries at the session boundary.
              await session.refetch();
              router.replace('/dashboard');
            }}
          />
        )}
      </main>
    </>
  );
}

// `useSearchParams()` requires a Suspense boundary in the App Router.
export default function Home() {
  return (
    <Suspense fallback={null}>
      <SignIn />
    </Suspense>
  );
}
