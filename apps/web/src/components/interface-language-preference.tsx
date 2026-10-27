'use client';

import { useState } from 'react';
import {
  isInterfaceLocale,
  useInterfaceLocale,
  setInterfaceLocale,
  localizedText,
  type InterfaceMessage,
} from '@/lib/locale';
import styles from './interface-language-preference.module.css';

export default function InterfaceLanguagePreference() {
  const locale = useInterfaceLocale();
  const [saveState, setSaveState] = useState<'device' | 'page' | null>(null);
  const t = (key: InterfaceMessage) => localizedText(locale, key);

  function update(value: string) {
    if (!isInterfaceLocale(value)) return;
    setSaveState(setInterfaceLocale(value) ? 'device' : 'page');
  }

  return (
    <section className={styles.panel} aria-labelledby="interface-language-heading" lang={locale}>
      <h2 id="interface-language-heading">{t('languageHeading')}</h2>
      <label htmlFor="interface-language">{t('languageLabel')}</label>
      <select
        className={styles.select}
        id="interface-language"
        name="interface-language"
        value={locale}
        onChange={(event) => update(event.currentTarget.value)}
        aria-describedby="interface-language-help"
      >
        <option value="en">{t('english')}</option>
        <option value="te">{t('telugu')}</option>
        <option value="hi">{t('hindi')}</option>
      </select>
      <p id="interface-language-help">{t('languageHelp')}</p>
      {saveState === 'device' && <p role="status">{t('languageSaved')}</p>}
      {saveState === 'page' && <p role="status">{t('languageSavedThisPage')}</p>}
    </section>
  );
}
