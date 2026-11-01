'use client';

import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiJson, apiParsed } from '../lib/api';
import { parseLegalStatus } from '../lib/api-schemas';
import { NO_OWNER, useSession } from '../lib/session';
import { localizedText, useInterfaceLocale } from '../lib/locale';
import styles from './legal-acceptance.module.css';

/**
 * Blocks the signed-in app until the account accepts changed terms or privacy versions (2.11). The
 * server refuses every change in the meantime, so this dialog is the way forward, not a courtesy.
 */
export default function LegalAcceptance() {
  const session = useSession();
  const locale = useInterfaceLocale();
  const cache = useQueryClient();
  const t = (key: Parameters<typeof localizedText>[1]) => localizedText(locale, key);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const query = useQuery({
    queryKey: ['legalStatus', session.data?.owner ?? NO_OWNER],
    queryFn: () => apiParsed('/account/legal', parseLegalStatus),
    enabled:
      session.data?.authenticated === true &&
      session.data.legalAcceptanceEnabled === true &&
      !!session.data.owner,
    retry: false,
  });
  const legal = query.data;
  if (!legal?.acceptanceRequired) return null;

  async function accept(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!confirmed || pending || !legal) return;
    setPending(true);
    setError('');
    try {
      await apiJson('/account/legal/accept', {
        method: 'POST',
        headers: { 'x-csrf-token': session.data?.csrf ?? '' },
        body: JSON.stringify({
          termsVersion: legal.current.termsVersion,
          privacyVersion: legal.current.privacyVersion,
        }),
      });
      await cache.invalidateQueries({ queryKey: ['legalStatus'] });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('apiErrorDefault'));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.overlay}>
      <form
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="legal-acceptance-title"
        onSubmit={accept}
        lang={locale}
      >
        <h2 id="legal-acceptance-title">{t('legalUpdatedTitle')}</h2>
        <p>{t('legalUpdatedBody')}</p>
        <p>
          <a href={legal.current.termsUrl} target="_blank" rel="noreferrer">
            {t('legalTermsLink')}
          </a>
          {' · '}
          <a href={legal.current.privacyUrl} target="_blank" rel="noreferrer">
            {t('legalPrivacyLink')}
          </a>
        </p>
        <label className={styles.check}>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>{t('legalAcceptCheckbox')}</span>
        </label>
        {error && <p role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={!confirmed || pending}>
          {t('legalAcceptButton')}
        </button>
      </form>
    </div>
  );
}
