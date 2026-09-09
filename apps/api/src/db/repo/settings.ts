/**
 * Key/value settings.
 *
 * Deliberately small. This holds things the *app* discovers or the user toggles
 * — the last search request to prefill the form, whether the seed data has been
 * loaded — and nothing that belongs in `env.ts`. The dividing line: if getting it
 * wrong should stop the process from booting, it is an environment variable; if
 * it is state the app accumulates, it lives here.
 *
 * Secrets never land in this table. They are read from the environment, held in
 * memory, and never written to disk by us.
 */

import { fromJson, toText, type Db } from '../index.js';

export class SettingsRepo {
  constructor(private readonly db: Db) {}

  get(key: string): string | null {
    const row = this.db.get('SELECT value FROM settings WHERE key = :key', { key });
    return row ? toText(row['value']) : null;
  }

  getJson<T>(key: string, fallback: T): T {
    const raw = this.get(key);
    if (raw === null) return fallback;
    try {
      return fromJson<T>(raw, `settings.${key}`);
    } catch {
      // A corrupt setting is not worth failing a request over — it is a UI
      // convenience by definition, and the next write repairs it.
      return fallback;
    }
  }

  set(key: string, value: string, at: string): void {
    this.db.run(
      `INSERT INTO settings (key, value, updated_at) VALUES (:key, :value, :at)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      { key, value, at },
    );
  }

  setJson(key: string, value: unknown, at: string): void {
    this.set(key, JSON.stringify(value), at);
  }

  delete(key: string): void {
    this.db.run('DELETE FROM settings WHERE key = :key', { key });
  }

  all(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const row of this.db.all('SELECT key, value FROM settings')) {
      out[toText(row['key'])] = toText(row['value']);
    }
    return out;
  }
}

/** Known keys, in one place so a typo in a caller is a compile error. */
export const SETTING = {
  /** Stamped by `db/seed.ts` so the seed files load once, not on every boot. */
  seedVersion: 'seed.version',
  /** The last successful search request, used to prefill the search form. */
  lastSearchRequest: 'search.last',
  lastScheduledAt: 'search.scheduledAt',
  lastScheduledAttempt: 'search.scheduledAttempt',
  searchIntervalMinutes: 'search.intervalMinutes',
  searchDailyAt: 'search.dailyAt',
  /** UI preferences that should survive a browser change (theme, columns). */
  uiPreferences: 'ui.preferences',
  /**
   * ATS boards found by enrichment, on top of the curated list.
   *
   * Persisted rather than kept in memory because discovery is the expensive
   * part: it costs a request to a company's careers page to learn that they run
   * Greenhouse under a slug nobody would guess. Throwing that away on every
   * restart would mean paying for it again.
   */
  discoveredBoards: 'boards.discovered',
} as const;
