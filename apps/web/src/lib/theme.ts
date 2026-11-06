/** Light and dark theme preference for the dashboard, stored in localStorage and exposed as a React hook. */

import { useSyncExternalStore } from 'react';

// A real, working, client-only preference (localStorage), read via
// useSyncExternalStore rather than an effect + setState — this is the
// preference-storage pattern React itself recommends for a browser-only
// value that must render 'light' during any server-rendered pass without
// a hydration mismatch, and re-render immediately on toggle in this tab
// (which the native 'storage' event alone does not do).
const themeListeners = new Set<() => void>();
let fallbackTheme: 'light' | 'dark' = 'light';
function subscribeTheme(listener: () => void) {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}
function readTheme(): 'light' | 'dark' {
  try {
    fallbackTheme =
      window.localStorage.getItem('careerscope:dashboard-theme') === 'dark' ? 'dark' : 'light';
  } catch {
    // Some privacy modes deny storage access. Keep the preference usable in this tab.
  }
  return fallbackTheme;
}
/** Current theme and a `toggle` that persists the opposite value and notifies subscribers in this tab. */
export function useTheme() {
  const theme = useSyncExternalStore<'light' | 'dark'>(subscribeTheme, readTheme, () => 'light');
  function toggle() {
    fallbackTheme = theme === 'dark' ? 'light' : 'dark';
    try {
      window.localStorage.setItem('careerscope:dashboard-theme', fallbackTheme);
    } catch {
      // Keep the in-tab preference working when persistence is unavailable.
    }
    for (const listener of themeListeners) listener();
  }
  return { theme, toggle };
}
