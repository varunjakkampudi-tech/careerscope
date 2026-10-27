'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { LoaderCircle, ShieldCheck, User } from 'lucide-react';
import { api } from '../lib/api';
import { localizedText, localizedValue, useInterfaceLocale } from '../lib/locale';

type Account = { email: string; role: 'candidate' | 'admin' };

export default function AccountForm({
  emailOtpEnabled = false,
  testUsersEnabled = false,
  accounts = [],
  registrationEnabled = false,
  legalDocuments,
  expired,
  notice = '',
  onAuthenticated,
}: {
  registrationEnabled?: boolean;
  emailOtpEnabled?: boolean;
  testUsersEnabled?: boolean;
  accounts?: Account[];
  legalDocuments?: {
    termsVersion: string;
    termsUrl: string;
    privacyVersion: string;
    privacyUrl: string;
  };
  expired: boolean;
  notice?: string;
  onAuthenticated: () => void | Promise<void>;
}) {
  const locale = useInterfaceLocale();
  const t = (key: Parameters<typeof localizedText>[1], value?: string | number) =>
    value === undefined ? localizedText(locale, key) : localizedValue(locale, key, value);
  const [pending, setPending] = useState<'request' | 'verify' | string | null>(null);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [intent, setIntent] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false);
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(0);
  const resendSeconds = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const codeInput = useRef<HTMLInputElement>(null);

  // Move focus to the code field once the code form replaces the email form.
  useEffect(() => {
    if (codeSent) codeInput.current?.focus();
  }, [codeSent]);

  useEffect(() => {
    if (!codeSent || resendSeconds === 0) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [codeSent, resendSeconds]);

  async function selectUser(accountEmail: string) {
    if (pending) return;
    setError('');
    setPending(accountEmail);
    try {
      await api('/login', {
        method: 'POST',
        body: JSON.stringify({ email: accountEmail }),
      });
      await onAuthenticated();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('apiErrorDefault'));
    } finally {
      setPending(null);
    }
  }

  async function requestCode(event?: Pick<FormEvent<HTMLFormElement>, 'preventDefault'>) {
    event?.preventDefault();
    if (pending) return;
    setError('');
    setPending('request');
    try {
      const result = await api<{ resendAfterSeconds: number }>('/otp/request', {
        method: 'POST',
        body: JSON.stringify(
          intent === 'sign-up'
            ? { email, intent, termsAccepted, privacyAcknowledged, marketingOptIn, dateOfBirth }
            : { email },
        ),
      });
      const requestedAt = Date.now();
      setNow(requestedAt);
      setResendAt(requestedAt + result.resendAfterSeconds * 1000);
      setCodeSent(true);
      setCode('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('couldNotRequestCode'));
    } finally {
      if (intent === 'sign-up') setDateOfBirth('');
      setPending(null);
    }
  }

  async function verifyCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || code.length !== 6) return;
    setError('');
    setPending('verify');
    try {
      await api('/otp/verify', {
        method: 'POST',
        body: JSON.stringify({ email, code, ...(intent === 'sign-up' ? { intent } : {}) }),
      });
      setCode('');
      await onAuthenticated();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('couldNotVerifyCode'));
      setCode('');
    } finally {
      setPending(null);
    }
  }

  function useDifferentEmail() {
    if (pending) return;
    setCodeSent(false);
    setCode('');
    setError('');
  }

  return (
    <section className="login" aria-labelledby="account-heading" lang={locale}>
      {testUsersEnabled ? (
        <>
          <h1 id="account-heading">{t('selectTestAccount')}</h1>
          <p style={{ marginBottom: '1.5rem' }}>{t('chooseRoleToEnter')}</p>
          {(error || expired) && <p role="alert">{error || t('sessionExpiredUnsaved')}</p>}
          {notice && <p role="status">{notice}</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {accounts.map((account) => {
              const Icon = account.role === 'admin' ? ShieldCheck : User;
              const isLoading = pending === account.email;
              return (
                <button
                  key={account.email}
                  className="primary"
                  disabled={pending !== null}
                  onClick={() => void selectUser(account.email)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.75rem',
                    padding: '1rem 1.5rem',
                    textAlign: 'left',
                  }}
                >
                  {isLoading ? (
                    <LoaderCircle className="spin" size={24} aria-hidden="true" />
                  ) : (
                    <Icon size={24} aria-hidden="true" />
                  )}
                  <span>
                    <strong style={{ display: 'block' }}>
                      {account.role === 'admin' ? t('roleAdmin') : t('roleCandidate')}
                    </strong>
                    <small>{account.email}</small>
                    <br />
                    <small style={{ fontSize: '0.8em' }}>
                      {account.role === 'admin'
                        ? t('adminWorkspaceDescription')
                        : t('candidateWorkspaceDescription')}
                    </small>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      ) : emailOtpEnabled ? (
        <>
          <h1 id="account-heading">
            {intent === 'sign-up' ? t('createCareerScopeAccount') : t('signInToCareerScope')}
          </h1>
          <p style={{ marginBottom: '1.5rem' }}>
            {intent === 'sign-up' ? t('verifyEmailSignUp') : t('verifyEmailSignIn')}
          </p>
          {(error || expired) && <p role="alert">{error || t('sessionExpiredUnsaved')}</p>}
          {notice && <p role="status">{notice}</p>}
          {codeSent ? (
            <form onSubmit={verifyCode}>
              <p role="status" aria-live="polite">
                {t('checkInboxForCode')}
              </p>
              <label htmlFor="otp-email">{t('emailAddress')}</label>
              <input id="otp-email" type="email" value={email} readOnly autoComplete="email" />
              <label htmlFor="otp-code">{t('sixDigitVerificationCode')}</label>
              <input
                id="otp-code"
                ref={codeInput}
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/[^0-9]/g, '').slice(0, 6))}
                required
                aria-describedby="otp-code-help"
              />
              <small id="otp-code-help">{t('enterCodeHelp')}</small>
              <button
                className="primary"
                type="submit"
                disabled={pending !== null || code.length !== 6}
              >
                {pending === 'verify' ? (
                  <>
                    <LoaderCircle className="spin" size={18} aria-hidden="true" /> {t('verifying')}
                  </>
                ) : intent === 'sign-up' ? (
                  t('verifyAndCreateAccount')
                ) : (
                  t('verifyAndSignIn')
                )}
              </button>
              <button
                type="button"
                onClick={() => void requestCode()}
                disabled={pending !== null || resendSeconds > 0}
              >
                {pending === 'request'
                  ? t('sending')
                  : resendSeconds > 0
                    ? t('resendCodeIn', resendSeconds)
                    : t('resendCode')}
              </button>
              <button type="button" onClick={useDifferentEmail} disabled={pending !== null}>
                {t('useDifferentEmail')}
              </button>
            </form>
          ) : (
            <form onSubmit={requestCode}>
              <label htmlFor="otp-email">{t('emailAddress')}</label>
              <input
                id="otp-email"
                type="email"
                autoComplete="email"
                maxLength={254}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
              />
              {registrationEnabled && intent === 'sign-up' && (
                <>
                  <label htmlFor="signup-date-of-birth">{t('dateOfBirth')}</label>
                  <input
                    id="signup-date-of-birth"
                    type="date"
                    autoComplete="bday"
                    aria-describedby="signup-age-screen-help"
                    value={dateOfBirth}
                    onChange={(event) => setDateOfBirth(event.target.value)}
                    required
                  />
                  <small id="signup-age-screen-help">{t('ageScreenHelp')}</small>
                </>
              )}
              {registrationEnabled && intent === 'sign-up' && legalDocuments && (
                <fieldset className="form-options">
                  <legend>{t('legalNotices')}</legend>
                  <label>
                    <input
                      type="checkbox"
                      checked={termsAccepted}
                      onChange={(event) => setTermsAccepted(event.target.checked)}
                      required
                    />{' '}
                    {t('acceptTermsPrefix')}{' '}
                    <a href={legalDocuments.termsUrl} target="_blank" rel="noreferrer">
                      {t('termsOfServiceWithVersion', legalDocuments.termsVersion)}
                    </a>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={privacyAcknowledged}
                      onChange={(event) => setPrivacyAcknowledged(event.target.checked)}
                      required
                    />{' '}
                    {t('acknowledgePrivacyPrefix')}{' '}
                    <a href={legalDocuments.privacyUrl} target="_blank" rel="noreferrer">
                      {t('privacyNoticeWithVersion', legalDocuments.privacyVersion)}
                    </a>
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={marketingOptIn}
                      onChange={(event) => setMarketingOptIn(event.target.checked)}
                    />{' '}
                    {t('marketingOptInLabel')}
                  </label>
                </fieldset>
              )}
              <button className="primary" type="submit" disabled={pending !== null}>
                {pending === 'request' ? (
                  <>
                    <LoaderCircle className="spin" size={18} aria-hidden="true" /> {t('sending')}
                  </>
                ) : (
                  t('sendVerificationCode')
                )}
              </button>
            </form>
          )}
          {registrationEnabled && !codeSent && legalDocuments && (
            <button
              type="button"
              onClick={() => {
                setIntent((current) => (current === 'sign-in' ? 'sign-up' : 'sign-in'));
                setTermsAccepted(false);
                setPrivacyAcknowledged(false);
                setMarketingOptIn(false);
                setError('');
              }}
              disabled={pending !== null}
            >
              {intent === 'sign-up' ? t('signInExistingAccount') : t('createAnAccount')}
            </button>
          )}
        </>
      ) : (
        <>
          <h1 id="account-heading">{t('signInUnavailable')}</h1>
          <p role="status">{t('noSignInMethod')}</p>
          {(error || expired) && <p role="alert">{error || t('sessionExpiredUnsaved')}</p>}
        </>
      )}
    </section>
  );
}
