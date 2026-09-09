/**
 * Light / dark / follow-the-system.
 *
 * The class goes on `<html>` — `index.css` defines `dark` as
 * `&:where(.dark, .dark *)`, so every token flips from one class rather than
 * from a `dark:` variant on each element.
 *
 * The awkward part is *when* it is applied. The usual trick is a tiny inline
 * `<script>` in `index.html` that runs before first paint, but the API's CSP on
 * the single-origin deploy sets `default-src 'self'` with no `script-src`
 * override, so an inline script is blocked. Instead:
 *
 *  - `index.css` paints the right background for the first frame via
 *    `@media (prefers-color-scheme: dark) { html:not(.light):not(.dark) }`;
 *  - {@link initTheme} runs at the top of `main.tsx`, before `createRoot`, so
 *    the class is on `<html>` before React renders anything.
 *
 * A stored `system` preference stays live: the OS switching at sunset moves the
 * app with it, without a reload.
 */

const STORAGE_KEY = 'job-radar.theme';

export type ThemeChoice = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

type Listener = () => void;
const listeners = new Set<Listener>();

let choice: ThemeChoice = readStoredChoice();
let media: MediaQueryList | null = null;

/** What the user picked — `system` included, unresolved. */
export function getThemeChoice(): ThemeChoice {
  return choice;
}

/** What is actually on screen right now. */
export function getResolvedTheme(): ResolvedTheme {
  return choice === 'system' ? systemTheme() : choice;
}

export function setThemeChoice(next: ThemeChoice): void {
  choice = next;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Private browsing. The choice still applies for this session; it just will
    // not survive a reload, which is a better outcome than a thrown error.
  }
  apply();
}

export function subscribeToTheme(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Applies the stored theme and starts following the OS.
 *
 * Called once from `main.tsx` before the first render — see the module note on
 * why this cannot be an inline script.
 */
export function initTheme(): void {
  apply();

  if (media === null && typeof matchMedia === 'function') {
    media = matchMedia('(prefers-color-scheme: dark)');
    // Only matters while the choice is `system`; `apply` reads the current
    // choice each time, so the listener is harmless when it is not.
    media.addEventListener('change', () => {
      if (choice === 'system') apply();
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function apply(): void {
  const resolved = getResolvedTheme();
  const root = document.documentElement;

  root.classList.toggle('dark', resolved === 'dark');
  root.classList.toggle('light', resolved === 'light');
  // Native controls — scrollbars, date pickers, form widgets — read this rather
  // than our CSS variables, and look badly out of place without it.
  root.style.colorScheme = resolved;

  for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    meta.content = resolved === 'dark' ? '#11151f' : '#ffffff';
  }

  for (const listener of listeners) listener();
}

function systemTheme(): ResolvedTheme {
  if (typeof matchMedia !== 'function') return 'light';
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readStoredChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    // Ignored — see setThemeChoice.
  }
  return 'system';
}
