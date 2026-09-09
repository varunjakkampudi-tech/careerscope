const KEY_NAME = 'job-radar.apiKey';

export type KeyPersistence = 'local' | 'session';

/** Notified when the key changes, so the header can re-render its lock state. */
type Listener = () => void;
const listeners = new Set<Listener>();

/**
 * Reads the key, preferring the session copy.
 *
 * Session first because it is the more deliberate choice: someone who typed the
 * key into a session-scoped field this morning means that one, even if a stale
 * value from a previous "remember me" is still sitting in `localStorage`.
 */
export function getApiKey(): string | null {
  return read(sessionStorage) ?? read(localStorage);
}

export function hasApiKey(): boolean {
  return getApiKey() !== null;
}

export function setApiKey(key: string, persistence: KeyPersistence = 'local'): void {
  const trimmed = key.trim();
  if (!trimmed) {
    clearApiKey();
    return;
  }

  // Written to one store and cleared from the other, so switching persistence
  // cannot leave a stale copy behind that `getApiKey` would later prefer.
  const [target, other] =
    persistence === 'session' ? [sessionStorage, localStorage] : [localStorage, sessionStorage];

  safely(() => target.setItem(KEY_NAME, trimmed));
  safely(() => other.removeItem(KEY_NAME));
  authFailed = false;
  notify();
}

export function clearApiKey(): void {
  safely(() => localStorage.removeItem(KEY_NAME));
  safely(() => sessionStorage.removeItem(KEY_NAME));
  // No key is "absent", not "rejected" — the banner should ask for one, not
  // claim the one we have is wrong.
  authFailed = false;
  notify();
}

export function currentPersistence(): KeyPersistence | null {
  if (read(sessionStorage)) return 'session';
  if (read(localStorage)) return 'local';
  return null;
}

/**
 * Shows enough of the key to recognise it, never enough to use it.
 *
 * The settings screen has to confirm *which* key is stored — otherwise the only
 * way to check is to paste a new one and see if requests start working.
 */
export function maskedApiKey(): string | null {
  const key = getApiKey();
  if (!key) return null;
  if (key.length <= 8) return '•'.repeat(key.length);
  return `${key.slice(0, 4)}${'•'.repeat(Math.min(key.length - 8, 24))}${key.slice(-4)}`;
}

export function subscribeToApiKey(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/* -------------------------------------------------------------------------- */
/* Rejection                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether the API has rejected the key we hold.
 *
 * Tracked separately from "is a key stored" because the two need different
 * messages: an absent key means *set one*, a rejected key means *the one you
 * set is wrong*. Without the distinction the shell can only say "check your
 * key", which is unhelpful in both cases.
 *
 * Set from the React Query caches in `main.tsx` — every request in the app goes
 * through one of them, so a 401 anywhere raises the banner exactly once.
 */
let authFailed = false;
const failureListeners = new Set<Listener>();

export function reportAuthFailure(): void {
  if (authFailed) return;
  authFailed = true;
  for (const listener of failureListeners) listener();
}

export function isAuthRejected(): boolean {
  return authFailed;
}

export function subscribeToAuthFailure(listener: Listener): () => void {
  failureListeners.add(listener);
  return () => failureListeners.delete(listener);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function read(store: Storage): string | null {
  return safely(() => store.getItem(KEY_NAME)) ?? null;
}

/**
 * Storage access throws, not returns null, when it is unavailable — Safari's
 * private mode and a `localStorage`-blocked iframe both do it. The app is
 * perfectly usable with `AUTH_DISABLED=true`, so a storage failure must not take
 * the page down with it.
 */
function safely<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function notify(): void {
  // Both sets, because storing a key also clears the rejected flag and the
  // banner watching that flag has to hear about it.
  for (const listener of listeners) listener();
  for (const listener of failureListeners) listener();
}
