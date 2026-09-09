/**
 * The HTTP client.
 *
 * One function — {@link request} — behind a small set of typed wrappers. It
 * exists so three decisions are made once rather than at every call site:
 *
 *  1. **Where the API is.** `VITE_API_BASE_URL` is baked in at build time. Empty
 *     means "same origin", which is both the dev-proxy case and the EC2
 *     single-origin case. The Pages build sets it to the API's absolute origin.
 *  2. **How the key travels.** In the `x-api-key` header, never in the URL. A
 *     query-string key would be written to nginx's access log, the browser's
 *     history, and the `Referer` of every subsequent request from the page. The
 *     API refuses it for the same reason (see `runs.ts`).
 *  3. **What an error is.** The API answers failures with a consistent
 *     `{ error: { code, message, details } }` body. {@link ApiError} carries all
 *     three, so a component can branch on `code` — `profile_missing`,
 *     `run_in_progress` — instead of pattern-matching English.
 */

import type { ApiError as ApiErrorBody } from '@job-radar/shared';
import { getApiKey } from './auth';

/**
 * Trailing slash trimmed so `${BASE}/api/leads` cannot become `//api/leads`,
 * which some proxies normalise and others 404.
 */
export const API_BASE_URL: string = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');

/** A failed request, with the API's own error code attached. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** True when the key is missing or wrong — the settings screen prompts on this. */
  get isAuthFailure(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Serialised as JSON. Use `form` for multipart. */
  body?: unknown;
  form?: FormData;
  query?: QueryInput;
  signal?: AbortSignal;
}

export type QueryValue = string | number | boolean | null | undefined | readonly string[];
export type QueryInput = Record<string, QueryValue>;

/** Builds a fully-qualified API URL. Exported for the SSE reader, which needs one. */
export function apiUrl(path: string, query?: QueryInput): string {
  const search = buildQuery(query);
  return `${API_BASE_URL}/api${path}${search}`;
}

/** The headers every request carries, including the key when one is stored. */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...extra };
  const key = getApiKey();
  if (key) headers['x-api-key'] = key;
  return headers;
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, form, query, signal } = options;

  const headers = authHeaders();
  // Deliberately not set for `form`: the browser has to append the multipart
  // boundary itself, and setting the header by hand strips it, producing a body
  // the server cannot parse.
  if (body !== undefined) headers['content-type'] = 'application/json';

  const response = await fetch(apiUrl(path, query), {
    method,
    headers,
    body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    signal: signal ?? null,
    credentials: 'include',
  });

  if (!response.ok) throw await toApiError(response);

  // 204, and 200 with an empty body, are both legitimate — DELETE returns the
  // former. `T` is `void` at those call sites.
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

/**
 * Downloads a file that needs the API key.
 *
 * A plain `<a download href>` cannot carry a header, so the file is fetched,
 * turned into a blob and handed to a synthetic anchor. The object URL is revoked
 * afterwards — without that, an XLSX export sits in memory until the tab closes.
 */
export async function downloadFile(path: string, query?: QueryInput): Promise<void> {
  const response = await fetch(apiUrl(path, query), {
    headers: authHeaders(),
    credentials: 'include',
  });
  if (!response.ok) throw await toApiError(response);

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filenameFrom(response.headers.get('content-disposition')) ?? 'download';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // A tick of grace: revoking synchronously races the download in Safari.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function buildQuery(query?: QueryInput): string {
  if (!query) return '';
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    // Arrays are comma-joined, not repeated — `leadQuerySchema` splits on commas
    // (`sources`, `statuses`), and `?sources=a&sources=b` would arrive as an
    // array Zod's `.string()` would reject.
    if (Array.isArray(value)) {
      if (value.length > 0) params.set(key, value.join(','));
      continue;
    }
    params.set(key, String(value));
  }

  const search = params.toString();
  return search ? `?${search}` : '';
}

async function toApiError(response: Response): Promise<ApiError> {
  let code = `http_${response.status}`;
  let message = response.statusText || 'Request failed';
  let details: unknown;

  try {
    const body = (await response.json()) as Partial<ApiErrorBody>;
    if (body.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
      details = body.error.details;
    }
  } catch {
    // A proxy timeout or an nginx error page is HTML, not JSON. The status line
    // is all there is, and it is enough to say what happened.
    if (response.status === 0) message = 'Could not reach the API';
  }

  return new ApiError(response.status, code, message, details);
}

/** Pulls the server's suggested filename out of `Content-Disposition`. */
function filenameFrom(header: string | null): string | null {
  if (!header) return null;
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(header);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
