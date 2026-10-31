'use client';

import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson, apiParsed, isNotFound } from '../lib/api';
import { parseRecoveryStatus } from '../lib/api-schemas';
import { NO_OWNER, useSession } from '../lib/session';
import { localizedText, useInterfaceLocale } from '../lib/locale';

/** Sets, confirms and removes the recovery address used for lost-email sign-in (2.17). */
export default function RecoveryEmailSection({ csrf }: { csrf: string }) {
  const session = useSession();
  const locale = useInterfaceLocale();
  const cache = useQueryClient();
  const t = (key: Parameters<typeof localizedText>[1]) => localizedText(locale, key);
  const enabled =
    session.data?.authenticated === true &&
    session.data.emailOtpEnabled === true &&
    !!session.data.owner;
  const status = useQuery({
    queryKey: ['recoveryEmail', session.data?.owner ?? NO_OWNER],
    queryFn: () => apiParsed('/account/recovery-email', parseRecoveryStatus),
    enabled,
    retry: false,
  });
  const [address, setAddress] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  if (!enabled || (status.error && isNotFound(status.error))) return null;
  const configured = status.data?.configured === true;
  async function run(action: () => Promise<unknown>, success: string) {
    setPending(true);
    setError('');
    setMessage('');
    try {
      await action();
      setMessage(success);
      await cache.invalidateQueries({ queryKey: ['recoveryEmail'] });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('apiErrorDefault'));
    } finally {
      setPending(false);
    }
  }

  function requestCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      await apiJson('/account/recovery-email/request', {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({ email: address }),
      });
      setCodeSent(true);
    }, t('recoverySent'));
  }

  function confirm(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void run(async () => {
      await apiJson('/account/recovery-email/verify', {
        method: 'POST',
        headers: { 'x-csrf-token': csrf },
        body: JSON.stringify({ email: address, code }),
      });
      setCodeSent(false);
      setAddress('');
      setCode('');
    }, t('recoveryConfigured'));
  }

  function remove() {
    void run(
      () =>
        apiJson('/account/recovery-email', { method: 'DELETE', headers: { 'x-csrf-token': csrf } }),
      t('recoveryNotConfigured'),
    );
  }

  return (
    <section aria-labelledby="recovery-email-heading" lang={locale}>
      <h2 id="recovery-email-heading">{t('recoverySetupTitle')}</h2>
      <p>{t('recoverySetupIntro')}</p>
      <p role="status">{configured ? t('recoveryConfigured') : t('recoveryNotConfigured')}</p>
      {configured && status.data?.available === false && <p>{t('recoveryCooldown')}</p>}
      {!configured && !codeSent && (
        <form onSubmit={requestCode}>
          <label>
            {t('recoveryAddressLabel')}
            <input
              type="email"
              autoComplete="email"
              required
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </label>
          <button className="primary" type="submit" disabled={pending}>
            {t('recoverySendCode')}
          </button>
        </form>
      )}
      {!configured && codeSent && (
        <form onSubmit={confirm}>
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
            {t('recoveryConfirm')}
          </button>
        </form>
      )}
      {configured && (
        <button type="button" onClick={remove} disabled={pending}>
          {t('recoveryRemove')}
        </button>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
