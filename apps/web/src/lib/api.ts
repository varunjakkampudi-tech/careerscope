export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    // CS-35 AC2: the stable machine code the API emits with a 409, carried
    // through to consumers so a caller can offer the recovery action that
    // actually fits the conflict. `undefined` whenever the response did not
    // carry a code this client knows about - callers must treat that as the
    // generic conflict, never as a new kind of success.
    readonly code?: string,
  ) {
    super(message);
  }
}

// CS-35: the client's own allowlist of the codes the API is contracted to
// emit, each mapped to the message this client shows. Deliberately a
// client-side table rather than the server's `error` string: the server text
// is not a client-facing contract and echoing it would put server-chosen
// content on screen. An unknown code - a newer server, a proxy, a hostile
// response - is not in this table, so it falls back to the generic conflict
// message below and leaves `code` undefined. A Map rather than an object
// literal because the lookup key arrives off the wire: `{}['__proto__']` is
// Object.prototype, not undefined, and a plain object would hand that back as
// though it were a message.
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
 * recognise (an older or newer server, or a malformed body) - that is the
 * pre-CS-35 behaviour and stays the safe fallback, because a stale record is
 * the only conflict a reload can repair. False for every other known code, so
 * unsaved profile or lead edits are not offered for destruction over a
 * conflict that has nothing to do with staleness.
 */
export function offersDiscardAndReload(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 409) return false;
  return error.code === undefined || REVISION_CONFLICT_CODES.includes(error.code);
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

// A single, real place a 401 is announced, rather than each route deciding
// for itself whether to react (Independent Reviewer finding 2, 2026-09-23:
// three different, inconsistent 401-handling implementations existed across
// seven routes, and two routes — Resume and Settings — had none at all, so
// an expired session there showed an unrecoverable inline error with a Retry
// button that could only ever fail again). AuthenticatedShell is the one
// listener, matching CS-6's "single auth boundary" design.
export const SESSION_EXPIRED_EVENT = 'careerscope:session-expired';

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(`/api${path}`, {
    ...options,
    cache: 'no-store',
    credentials: 'same-origin',
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
      : AbortSignal.timeout(15_000),
    headers,
  });
  if (!response.ok) {
    const messages: Record<number, string> = {
      400: 'Check the fields and try again.',
      401: path === '/login' ? 'Invalid email or password.' : 'Please sign in again.',
      409: 'This record changed in another session. Your edits have not been saved.',
      413: 'The submitted data is too large.',
      429: 'Too many requests. Try again shortly.',
      507: 'Resume storage capacity reached. Remove an unneeded completed resume or try again later.',
    };
    if (response.status === 401 && path !== '/login' && typeof window !== 'undefined') {
      window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    }
    const conflict = response.status === 409 ? await readConflict(response) : undefined;
    // A non-409 error has no structured body contract in this client. Cancel
    // it before throwing so the underlying connection is not left with an
    // unread response stream when callers immediately retry or navigate away.
    if (response.status !== 409) await response.body?.cancel();
    throw new ApiError(
      response.status,
      conflict?.message ?? messages[response.status] ?? 'Request failed. Please try again.',
      conflict?.code,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
