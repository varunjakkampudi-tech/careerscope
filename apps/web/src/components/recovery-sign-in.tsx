'use client';

import { useState, type FormEvent } from 'react';
import { apiJson } from '../lib/api';
import { localizedText, useInterfaceLocale } from '../lib/locale';

/**
 * Signs in with the confirmed recovery address when the sign-in email is lost (2.17). The request
 * reply is the same whether or not a code was sent, so this form cannot reveal whether an account
 * or recovery address exists.
 */
export default function RecoverySignIn({
  onAuthenticated,
  onBack,
}: {
  onAuthenticated: () => Promise<void> | void;
  onBack: () => void;
}) {
  const locale = useInterfaceLocale();
  const t = (key: Parameters<typeof localizedText>[1]) => localizedText(locale, key);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function request(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await apiJson('/recovery/request', {
        method: 'POST',
        body: JSON.stringify({ email }),
      });
      setSent(true);
      setMessage(t('recoveryRequestNote'));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('apiErrorDefault'));
    } finally {
      setPending(false);
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError('');
    try {
      await apiJson('/recovery/verify', {
        method: 'POST',
        body: JSON.stringify({ email, code }),
      });
      setCode('');
      await onAuthenticated();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('couldNotVerifyCode'));
      setCode('');
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-labelledby="recovery-sign-in-heading" lang={locale}>
      <h2 id="recovery-sign-in-heading">{t('recoveryFindTitle')}</h2>
      <p>{t('recoveryFindIntro')}</p>
      {!sent ? (
        <form onSubmit={request}>
          <label>
            {t('recoveryAddressLabel')}
            <input
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <button className="primary" type="submit" disabled={pending}>
            {t('recoverySignInButton')}
          </button>
        </form>
      ) : (
        <form onSubmit={verify}>
          <label>
            {t('recoveryCodeLabel')}
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              value={code}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <button className="primary" type="submit" disabled={pending || code.length !== 6}>
            {t('recoveryVerify')}
          </button>
        </form>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" onClick={onBack}>
        {t('recoveryBack')}
      </button>
    </section>
  );
}
