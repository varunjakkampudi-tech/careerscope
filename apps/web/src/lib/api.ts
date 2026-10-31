/**
 * Browser client for the CareerScope API: attaches the CSRF token, refreshes an expired session once,
 * and turns failures into `ApiError` with fixed, user-safe messages. Used by every screen.
 */

/** Failed API call. `code` is set only for a 409 whose code this client recognises. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    // The stable machine code the API emits with a 409, so a caller can offer
    // the recovery action that fits the conflict. `undefined` whenever the
    // response did not carry a code this client knows about; callers must treat
    // that as the generic conflict.
    readonly code?: string,
  ) {
    super(message);
  }
}

// The client's own allowlist of the conflict codes the API emits, each mapped to
// the message this client shows. It is a client-side table rather than the
// server's `error` string because server text is not a client contract and
// echoing it would put server-chosen content on screen. An unknown code (a
// newer server, a proxy, a hostile response) is not in the table, so it falls
// back to the generic conflict message and leaves `code` undefined. A Map, not
// an object literal, because the key arrives off the wire: `{}['__proto__']` is
// Object.prototype, not undefined.
const CONFLICT_MESSAGES = new Map<string, string>([
  [
    'PROFILE_REVISION_CONFLICT',
    'This record changed in another session. Your edits have not been saved.',
  ],
  [
    'LEAD_REVISION_CONFLICT',
    'This record changed in another session. Your edits have not been saved.',
  ],
  [
    'PROFILE_NOT_SAVED',
    'Save your profile before enabling this option. Your edits are still here.',
  ],
  ['MISSING_TARGET_ROLES', 'Add target roles to your profile before starting this search.'],
  ['IDEMPOTENCY_KEY_REUSED', 'This request already completed with different details. Try again.'],
  ['UPLOAD_CANCELLED', 'This upload was already cancelled.'],
  ['UPLOAD_NOT_CANCELLABLE', 'This upload can no longer be cancelled.'],
  ['UPLOAD_VERSION_CONFLICT', 'This upload changed. Refresh and try again.'],
]);

// The only conflicts whose correct recovery is to throw local edits away and
// reload. Every other known code is a conflict the edits survive.
const REVISION_CONFLICT_CODES = ['PROFILE_REVISION_CONFLICT', 'LEAD_REVISION_CONFLICT'];

/**
 * Whether a failed mutation should offer "discard edits and reload".
 *
 * True for a revision conflict, and for a 409 whose code this client does not
 * recognise (an older or newer server, or a malformed body); that is the safe
 * fallback, because a stale record is the only conflict a reload can repair. False for every other known code, so
 * unsaved profile or lead edits are not offered for destruction over a
 * conflict that has nothing to do with staleness.
 */
export function offersDiscardAndReload(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  return error.code === undefined || REVISION_CONFLICT_CODES.includes(error.code);
}

/**
 * True for a 404 from the API. `DELETE /account/sessions/:id` answers 404 when the session is not
 * one of the caller's, for example because it was already signed out elsewhere, so the caller can
 * treat the goal (that device is signed out) as met and refresh its list.
 */
export function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/**
 * Reads the machine code off a 409 body without ever letting a malformed body
 * become a success or a thrown parse error: anything that is not an object
 * carrying a known string `code` yields `undefined`.
 */
async function readConflict(
  response: Response,
): Promise<{ code: string; message: string } | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
    const code = (body as { code?: unknown }).code;
    if (typeof code !== 'string') return undefined;
    const message = CONFLICT_MESSAGES.get(code);
    return message === undefined ? undefined : { code, message };
  } catch {
    return undefined;
  }
}

// The single place a 401 is announced, instead of each route deciding whether to
// react. AuthenticatedShell is the one listener, so an expired session is
// handled the same way on every screen.
export const SESSION_EXPIRED_EVENT = 'careerscope:session-expired';
// CSRF token from the last `/session` or refresh response; sent on every non-GET request, cleared on login, logout and expiry.
let csrfToken: string | undefined;
// Shared promise so concurrent 401s trigger one refresh, not one each.
let refreshInFlight: Promise<'refreshed' | 'expired' | 'unavailable'> | undefined;

async function refreshSession(): Promise<'refreshed' | 'expired' | 'unavailable'> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = (async () => {
    try {
      const response = await fetch('/api/session/refresh', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401) {
        csrfToken = undefined;
        await response.body?.cancel();
        window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
        return 'expired';
      }
      if (!response.ok) {
        await response.body?.cancel();
        return 'unavailable';
      }
      const body: unknown = await response.json();
      if (
        typeof body !== 'object' ||
        body === null ||
        !('authenticated' in body) ||
        body.authenticated !== true ||
        !('csrf' in body) ||
        typeof body.csrf !== 'string' ||
        !/^[a-f0-9]{64}$/.test(body.csrf)
      ) {
        csrfToken = undefined;
        window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
        return 'expired';
      }
      csrfToken = body.csrf;
      return 'refreshed';
    } catch {
      return 'unavailable';
    }
  })();
  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = undefined;
  }
}

/**
 * Calls `/api${path}` with a 15 second timeout and resolves the JSON body as `unknown`
 * (`undefined` for a 204). On a 401 it refreshes the session once and retries; other failures
 * throw `ApiError`. Use it when the body is not read (a 204 or an ignored result); otherwise use
 * `apiParsed` with a parser from `api-schemas.ts`.
 */
export async function apiJson(path: string, options: RequestInit = {}): Promise<unknown> {
  return request(path, options, true);
}

/** Like `apiJson`, but passes the body through `parse`, which must throw on an unexpected shape. */
export async function apiParsed<T>(
  path: string,
  parse: (body: unknown) => T,
  options: RequestInit = {},
): Promise<T> {
  return parse(await request(path, options, true));
}

async function request(path: string, options: RequestInit, mayRefresh: boolean): Promise<unknown> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const method = (options.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken)
    headers.set('x-csrf-token', csrfToken);
  const response = await fetch(`/api${path}`, {
    ...options,
    cache: 'no-store',
    credentials: 'same-origin',
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
    headers,
  });
  if (
    response.status === 401 &&
    mayRefresh &&
    typeof window !== 'undefined' &&
    !['/session', '/session/refresh', '/login', '/otp/request', '/otp/verify'].includes(path) &&
    !(typeof ReadableStream !== 'undefined' && options.body instanceof ReadableStream)
  ) {
    await response.body?.cancel();
    const refresh = await refreshSession();
    if (refresh === 'refreshed') return request(path, options, false);
    throw new ApiError(
      refresh === 'expired' ? 401 : 503,
      refresh === 'expired'
        ? 'Please sign in again.'
        : 'Your session could not be refreshed. Check your connection and try again.',
    );
  }
  if (response.ok && path === '/session') {
    const body: unknown = await response.clone().json();
    csrfToken =
      typeof body === 'object' &&
      body !== null &&
      'authenticated' in body &&
      body.authenticated === true &&
      'csrf' in body &&
      typeof body.csrf === 'string'
        ? body.csrf
        : undefined;
  }
  if (response.ok && ['/login', '/otp/verify', '/logout', '/session/logout'].includes(path))
    csrfToken = undefined;
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: 'Check the fields and try again.',
      401:
        path === '/otp/verify'
          ? 'The code is invalid or expired. Request a new code and try again.'
          : path === '/login'
            ? 'Invalid email or password.'
            : 'Please sign in again.',
      409: 'This record changed in another session. Your edits have not been saved.',
      413: 'The submitted data is too large.',
      429: 'Too many requests. Try again shortly.',
      503: 'Service temporarily unavailable. Please try again shortly.',
      507: 'Resume storage capacity reached. Remove an unneeded completed resume or try again later.',
    };
    if (
      response.status === 401 &&
      path !== '/login' &&
      path !== '/otp/verify' &&
      typeof window !== 'undefined'
    ) {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    const conflict = response.status === 409 ? await readConflict(response) : undefined;
    // A non-409 error has no structured body contract in this client. Cancel
    // it before throwing so the underlying connection is not left with an
    // unread response stream when callers immediately retry or navigate away.
    if (response.status !== 409) await response.body?.cancel();
    throw new ApiError(
      response.status,
      conflict?.message ??
        (response.status === 503 && ['/otp/request', '/otp/verify'].includes(path)
          ? 'Sign-in is temporarily unavailable. Please try again shortly.'
          : messages[response.status]) ??
        'Request failed. Please try again.',
      conflict?.code,
    );
  }
  if (response.status === 204) return undefined;
  const body: unknown = await response.json();
  return body;
}
