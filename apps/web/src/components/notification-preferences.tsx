'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiParsed } from '@/lib/api';
import { parseNotificationPreferences } from '@/lib/api-schemas';
import { localizedText, useInterfaceLocale } from '@/lib/locale';
import { NO_OWNER, useSession } from '@/lib/session';
import { ErrorState, LoadingState } from './ui-states';
import styles from './notification-preferences.module.css';

export default function NotificationPreferences() {
  const locale = useInterfaceLocale();
  const t = (key: Parameters<typeof localizedText>[1]) => localizedText(locale, key);
  const session = useSession();
  const queryClient = useQueryClient();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refreshedAfterSave, setRefreshedAfterSave] = useState(false);
  const [preferenceUnconfirmed, setPreferenceUnconfirmed] = useState(false);
  const owner = session.data?.owner ?? NO_OWNER;
  const preferences = useQuery({
    queryKey: ['notificationPreferences', owner],
    queryFn: () => apiParsed('/notifications/preferences', parseNotificationPreferences),
    enabled: session.data?.authenticated === true && !!session.data.owner,
  });

  async function changePreference(enabled: boolean) {
    if (saving || preferenceUnconfirmed) return;
    setSaving(true);
    setSaved(false);
    setRefreshedAfterSave(false);
    try {
      const updated = await apiParsed('/notifications/preferences', parseNotificationPreferences, {
        method: 'PUT',
        body: JSON.stringify({ interviewRemindersInAppEnabled: enabled }),
      });
      queryClient.setQueryData(['notificationPreferences', owner], updated);
      setSaved(true);
    } catch {
      // A failed response does not prove the write failed: the server may have
      // committed before a proxy/network error. Hide the cached checkbox until
      // a fresh read succeeds, so it cannot imply an unconfirmed setting.
      setPreferenceUnconfirmed(true);
      const refreshed = await preferences.refetch();
      if (refreshed.isSuccess && refreshed.data) {
        setPreferenceUnconfirmed(false);
        setRefreshedAfterSave(true);
      }
    } finally {
      setSaving(false);
    }
  }

  async function retryPreferenceRead() {
    const refreshed = await preferences.refetch();
    if (refreshed.isSuccess && refreshed.data) {
      setPreferenceUnconfirmed(false);
    } else setPreferenceUnconfirmed(true);
  }

  return (
    <section
      className={styles.panel}
      aria-labelledby="notification-preferences-heading"
      lang={locale}
    >
      <div className={styles.heading}>
        <h2 id="notification-preferences-heading">{t('notificationPreferencesHeading')}</h2>
        <p>{t('notificationPreferencesDescription')}</p>
      </div>
      {preferences.isLoading && (
        <div lang={locale}>
          <LoadingState variant="inline" message={t('notificationPreferencesLoading')} />
        </div>
      )}
      {(preferences.isError || preferenceUnconfirmed) && (
        <div lang={locale}>
          <ErrorState
            title={t('notificationPreferencesLoadError')}
            message={
              preferenceUnconfirmed
                ? t('notificationPreferencesUnconfirmed')
                : t('notificationPreferencesConnection')
            }
            onRetry={() => void retryPreferenceRead()}
            retryLabel={t('retry')}
          />
        </div>
      )}
      {preferences.data && !preferences.isError && !preferenceUnconfirmed && (
        <div className={styles.control}>
          <label className={styles.checkItem}>
            <input
              type="checkbox"
              checked={preferences.data.interviewRemindersInAppEnabled}
              disabled={saving}
              aria-describedby="interview-reminder-preference-note"
              onChange={(event) => void changePreference(event.currentTarget.checked)}
            />
            <span>{t('notificationReminderToggle')}</span>
          </label>
          <p className={styles.note} id="interview-reminder-preference-note">
            {t('notificationReminderNote')}
          </p>
          {saving && <p role="status">{t('notificationPreferenceSaving')}</p>}
          {saved && <p role="status">{t('notificationPreferenceSaved')}</p>}
          {refreshedAfterSave && <p role="status">{t('notificationPreferenceReloaded')}</p>}
        </div>
      )}
    </section>
  );
}
