import { useSyncExternalStore } from 'react';

// A real, working, client-only preference (localStorage), read via
// useSyncExternalStore rather than an effect + setState — this is the
// preference-storage pattern React itself recommends for a browser-only
// value that must render 'light' during any server-rendered pass without
// a hydration mismatch, and re-render immediately on toggle in this tab
// (which the native 'storage' event alone does not do).
const themeListeners = new Set<() => void>();
function subscribeTheme(listener: () => void) {
  themeListeners.add(listener);
  return () => themeListeners.delete(listener);
}
function readTheme(): 'light' | 'dark' {
  return window.localStorage.getItem('careerscope:dashboard-theme') === 'dark' ? 'dark' : 'light';
}
export function useTheme() {
  const theme = useSyncExternalStore<'light' | 'dark'>(subscribeTheme, readTheme, () => 'light');
  function toggle() {
    window.localStorage.setItem('careerscope:dashboard-theme', theme === 'dark' ? 'light' : 'dark');
    for (const listener of themeListeners) listener();
  }
  return { theme, toggle };
}
