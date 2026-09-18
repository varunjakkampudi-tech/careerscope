export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

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
    throw new ApiError(
      response.status,
      messages[response.status] ?? 'Request failed. Please try again.',
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}
