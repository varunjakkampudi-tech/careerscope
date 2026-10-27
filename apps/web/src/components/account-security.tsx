'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, LogOut } from 'lucide-react';
import { ApiError, apiJson, apiParsed } from '../lib/api';
import {
  parseAccountSessions,
  parseEmailChangeVerification,
  parseMarketingConsent,
  type AccountSession,
} from '../lib/api-schemas';
import { NO_OWNER, useSession } from '../lib/session';
import {
  localizedApiErrorMessage,
  localizedText,
  localizedValue,
  useInterfaceLocale,
} from '../lib/locale';
import { ErrorState } from './ui-states';
import styles from './account-security.module.css';

function dateLabel(value: string | null, locale: 'en' | 'te' | 'hi'): string {
  if (!value) return localizedText(locale, 'notAvailable');
  const parsed = new Date(value);
  const languageTag = locale === 'en' ? 'en-IN' : locale === 'te' ? 'te-IN' : 'hi-IN';
  return Number.isNaN(parsed.getTime())
    ? localizedText(locale, 'notAvailable')
    : new Intl.DateTimeFormat(languageTag, { dateStyle: 'medium', timeStyle: 'short' }).format(
        parsed,
      );
}

export default function AccountSecurity({
  csrf,
  onBusyChange,
}: {
  csrf: string;
  /** Reports whether a sign-out is in flight, so the page can hold navigation until it settles. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const session = useSession();
  const locale = useInterfaceLocale();
  const t = (key: Parameters<typeof localizedText>[1], value?: string | number) =>
    value === undefined ? localizedText(locale, key) : localizedValue(locale, key, value);
  const queryClient = useQueryClient();
  const testMode = session.data?.testUser !== undefined;
  const sessionsQuery = useQuery({
    queryKey: ['accountSessions', session.data?.owner ?? NO_OWNER],
    queryFn: () => apiParsed('/account/sessions', parseAccountSessions),
    enabled: session.data?.authenticated === true && !!session.data.owner,
  });
  const marketingQuery = useQuery({
    queryKey: ['marketingConsent', session.data?.owner ?? NO_OWNER],
    queryFn: () => apiParsed('/account/marketing-consent', parseMarketingConsent),
    enabled: session.data?.authenticated === true && !!session.data.owner,
  });
  const [revoking, setRevoking] = useState(false);
  const [revokingSessionId, setRevokingSessionId] = useState<string | null>(null);
  const [sessionError, setSessionError] = useState('');
  const [notice, setNotice] = useState('');
  const [marketingPending, setMarketingPending] = useState(false);
  const [marketingError, setMarketingError] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [emailChangeRequested, setEmailChangeRequested] = useState(false);
  const [currentEmailCode, setCurrentEmailCode] = useState('');
  const [newEmailCode, setNewEmailCode] = useState('');
  const [currentEmailVerified, setCurrentEmailVerified] = useState(false);
  const [newEmailVerified, setNewEmailVerified] = useState(false);
  const [emailChangePending, setEmailChangePending] = useState(false);
  const [emailChangeError, setEmailChangeError] = useState('');
  const [emailChangeNotice, setEmailChangeNotice] = useState('');
  const busy = revoking;
  useEffect(() => onBusyChange?.(busy), [busy, onBusyChange]);

  async function requestEmailChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (emailChangePending) return;
    setEmailChangePending(true);
    setEmailChangeError('');
    setEmailChangeNotice('');
    try {
      await apiJson('/account/email-change/request', {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({ newEmail }),
      });
      setEmailChangeRequested(true);
      setCurrentEmailVerified(false);
      setNewEmailVerified(false);
      setCurrentEmailCode('');
      setNewEmailCode('');
      setEmailChangeNotice(t('emailChangeCodesSent'));
    } catch (failure) {
      setEmailChangeError(
        failure instanceof ApiError
          ? localizedApiErrorMessage(locale, failure.status)
          : t('pleaseTryConnection'),
      );
    } finally {
      setEmailChangePending(false);
    }
  }

  async function verifyEmailChange(address: 'current' | 'new') {
    if (emailChangePending) return;
    const code = address === 'current' ? currentEmailCode : newEmailCode;
    setEmailChangePending(true);
    setEmailChangeError('');
    setEmailChangeNotice('');
    try {
      const result = await apiParsed('/account/email-change/verify', parseEmailChangeVerification, {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({ address, code }),
      });
      if (result.emailChanged) {
        setEmailChangeRequested(false);
        setNewEmail('');
        setEmailChangeNotice(t('emailAddressUpdated'));
        await queryClient.invalidateQueries({ queryKey: ['session'] });
      } else if (address === 'current') {
        setCurrentEmailVerified(true);
        setEmailChangeNotice(t('currentAddressVerified'));
      } else {
        setNewEmailVerified(true);
        setEmailChangeNotice(t('newAddressVerified'));
      }
    } catch (failure) {
      setEmailChangeError(
        failure instanceof ApiError
          ? localizedApiErrorMessage(locale, failure.status)
          : t('pleaseTryConnection'),
      );
    } finally {
      setEmailChangePending(false);
    }
  }

  async function revokeOthers() {
    if (busy || !window.confirm(t('sessionSignOutAllConfirm'))) return;
    setSessionError('');
    setNotice('');
    setRevoking(true);
    try {
      await apiJson('/account/sessions/revoke-others', {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({}),
      });
      setNotice(t('otherSessionsSignedOut'));
    } catch (failure) {
      // The fallback no longer repeats the operation name — `what` carries it.
      setSessionError(
        failure instanceof ApiError
          ? localizedApiErrorMessage(locale, failure.status)
          : t('pleaseTryAgain'),
      );
    } finally {
      setRevoking(false);
    }
  }

  async function revokeSession(target: AccountSession) {
    if (busy || target.current || !window.confirm(t('signOutDeviceConfirm', target.deviceLabel)))
      return;
    setSessionError('');
    setNotice('');
    setRevokingSessionId(target.id);
    try {
      await apiJson(`/account/sessions/${target.id}`, { method: 'DELETE' });
      await queryClient.invalidateQueries({ queryKey: ['accountSessions'] });
      setNotice(t('deviceSignedOut', target.deviceLabel));
    } catch (failure) {
      setSessionError(
        failure instanceof ApiError
          ? localizedApiErrorMessage(locale, failure.status)
          : t('pleaseTryAgain'),
      );
    } finally {
      setRevokingSessionId(null);
    }
  }

  async function updateMarketingConsent() {
    if (!marketingQuery.data || marketingPending) return;
    setMarketingPending(true);
    setMarketingError('');
    try {
      await apiJson('/account/marketing-consent', {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({ optIn: !marketingQuery.data.optedIn }),
      });
      await queryClient.invalidateQueries({ queryKey: ['marketingConsent'] });
    } catch (failure) {
      setMarketingError(
        failure instanceof ApiError
          ? localizedApiErrorMessage(locale, failure.status)
          : t('pleaseTryConnection'),
      );
    } finally {
      setMarketingPending(false);
    }
  }

  return (
    <section className={styles.panel} aria-labelledby="security-heading" lang={locale}>
      <h2 id="security-heading">{t('accountSecurity')}</h2>
      {session.data?.authenticated && !testMode && (
        <p role="status">
          {session.data.emailVerifiedAt
            ? t('emailVerifiedOn', dateLabel(session.data.emailVerifiedAt, locale))
            : t('emailVerificationNotRecorded')}
        </p>
      )}
      {!testMode && session.data?.emailOtpEnabled && (
        <section aria-labelledby="email-change-heading">
          <h2 id="email-change-heading">{t('changeSignInEmail')}</h2>
          <p>
            {t('currentEmail')}: {session.data.email ?? t('notAvailable')}
          </p>
          {!emailChangeRequested ? (
            <form onSubmit={requestEmailChange} aria-busy={emailChangePending}>
              <label>
                {t('newEmailAddress')}
                <input
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  value={newEmail}
                  onChange={(event) => setNewEmail(event.target.value)}
                  disabled={emailChangePending}
                />
              </label>
              <button type="submit" disabled={emailChangePending}>
                {emailChangePending ? t('sendingVerificationCodes') : t('sendVerificationCodes')}
              </button>
            </form>
          ) : (
            <div aria-busy={emailChangePending}>
              <p>{t('enterBothEmailCodes')}</p>
              <label>
                {t('codeSentToCurrentEmail')}
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={currentEmailCode}
                  onChange={(event) =>
                    setCurrentEmailCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  disabled={emailChangePending || currentEmailVerified}
                />
              </label>
              <button
                type="button"
                onClick={() => void verifyEmailChange('current')}
                disabled={
                  emailChangePending || currentEmailVerified || currentEmailCode.length !== 6
                }
              >
                {currentEmailVerified ? t('currentEmailVerified') : t('verifyCurrentEmail')}
              </button>
              <label>
                {t('codeSentToNewEmail')}
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  pattern="[0-9]{6}"
                  maxLength={6}
                  required
                  value={newEmailCode}
                  onChange={(event) =>
                    setNewEmailCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  disabled={emailChangePending || newEmailVerified}
                />
              </label>
              <button
                type="button"
                onClick={() => void verifyEmailChange('new')}
                disabled={emailChangePending || newEmailVerified || newEmailCode.length !== 6}
              >
                {newEmailVerified ? t('newEmailVerified') : t('verifyNewEmail')}
              </button>
            </div>
          )}
          {emailChangeError && <p role="alert">{emailChangeError}</p>}
          {emailChangeNotice && <p role="status">{emailChangeNotice}</p>}
        </section>
      )}
      <button type="button" onClick={revokeOthers} disabled={busy}>
        {revoking ? (
          <LoaderCircle className="spin" size={18} aria-hidden="true" />
        ) : (
          <LogOut size={18} aria-hidden="true" />
        )}
        {revoking ? t('signOutOthersLoading') : t('signOutOthers')}
      </button>
      <section aria-labelledby="active-sessions-heading">
        <h2 id="active-sessions-heading">{t('activeSessions')}</h2>
        {sessionsQuery.isPending ? (
          <p role="status">{t('activeSessionsLoading')}</p>
        ) : sessionsQuery.isError ? (
          <>
            <ErrorState
              variant="inline"
              what={t('couldNotLoadSessions')}
              detail={t('tryConnectionAgain')}
            />
            <button
              type="button"
              onClick={() => void sessionsQuery.refetch()}
              disabled={sessionsQuery.isFetching}
            >
              {sessionsQuery.isFetching ? t('retrying') : t('retry')}
            </button>
          </>
        ) : sessionsQuery.data.sessions.length === 0 ? (
          <p>{t('noSessions')}</p>
        ) : (
          <ul aria-label={t('activeDevicesLabel')}>
            {sessionsQuery.data.sessions.map((item) => (
              <li key={item.id}>
                <p>
                  <strong>{item.deviceLabel}</strong>
                  {item.current ? ` — ${t('thisDevice')}` : ''}
                </p>
                <p>
                  {t('started')}: {dateLabel(item.createdAt, locale)}
                </p>
                <p>
                  {t('lastRefreshed')}: {dateLabel(item.lastUsedAt, locale)}
                </p>
                {!item.current && (
                  <button
                    type="button"
                    onClick={() => void revokeSession(item)}
                    disabled={busy || revokingSessionId !== null}
                    aria-label={t('signOutDeviceLabel', item.deviceLabel)}
                  >
                    {revokingSessionId === item.id ? t('signingOut') : t('signOutThisDevice')}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="marketing-consent-heading">
        <h2 id="marketing-consent-heading">{t('optionalProductUpdates')}</h2>
        {marketingQuery.isPending ? (
          <p role="status">{t('loadingMarketingPreference')}</p>
        ) : marketingQuery.isError ? (
          <>
            <ErrorState
              variant="inline"
              what={t('couldNotLoadMarketing')}
              detail={t('tryConnectionAgain')}
            />
            <button
              type="button"
              onClick={() => void marketingQuery.refetch()}
              disabled={marketingQuery.isFetching}
            >
              {marketingQuery.isFetching ? t('retrying') : t('retry')}
            </button>
          </>
        ) : (
          <>
            <p>
              {marketingQuery.data.optedIn
                ? t(
                    'optedInProductUpdates',
                    marketingQuery.data.version
                      ? t('versionInParentheses', marketingQuery.data.version)
                      : '',
                  )
                : t('notOptedInProductUpdates')}
            </p>
            {marketingError && (
              <ErrorState
                variant="inline"
                what={t('couldNotUpdateMarketing')}
                detail={marketingError}
              />
            )}
            <button
              type="button"
              onClick={() => void updateMarketingConsent()}
              disabled={marketingPending}
            >
              {marketingPending
                ? t('savingPreference')
                : marketingQuery.data.optedIn
                  ? t('withdrawMarketingConsent')
                  : t('optInProductUpdates')}
            </button>
          </>
        )}
      </section>
      {sessionError && (
        <ErrorState variant="inline" what={t('couldNotSignOutSessions')} detail={sessionError} />
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
