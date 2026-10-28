/** A read left behind by an unmounted saved-job view cannot settle a new view. */
export function staleSavedRead(
  method: string,
  pathname: string,
  startedEpoch: number,
  currentEpoch: number,
): boolean {
  return (
    method === 'GET' &&
    (pathname === '/api/leads' || /^\/api\/leads\/[^/]+\/history$/.test(pathname)) &&
    startedEpoch !== currentEpoch
  );
}

/** A search read left behind by an unmounted search/dashboard view is stale. */
export function staleSearchRead(
  method: string,
  pathname: string,
  startedEpoch: number,
  currentEpoch: number,
): boolean {
  return (
    method === 'GET' &&
    (pathname === '/api/searches' || /^\/api\/searches\/[^/]+$/.test(pathname)) &&
    startedEpoch !== currentEpoch
  );
}

/**
 * A read left behind by an earlier route is stale.
 *
 * A full navigation replaces the document, and Chromium cancels that document's in-flight fetches
 * and script loads without reporting a failure or a finish (the server sees the abort; Playwright
 * and the DevTools protocol only ever report "request started"). Playwright then keeps the request
 * "in flight" for the rest of the run and the settlement barrier would wait on it until its
 * deadline. Measured for the shell and settings reads (session, notifications, account sessions,
 * consent, preferences) and for router prefetches of other routes.
 *
 * Only a GET fetch or script from an earlier route is dropped. A request from the current route, a
 * write, an HTML document or an image still counts, so a real hang on the current route is still
 * caught. This generalises `staleSavedRead` and `staleSearchRead`.
 *
 * The cancelled-fetch behaviour was measured only in Chromium, so the allowance applies to the
 * `chromium` engine alone. Firefox and WebKit report aborted requests as failed, so there nothing
 * is dropped and a request that never settles still fails the barrier.
 */
export function staleEarlierRouteRead(
  method: string,
  resourceType: string,
  startedEpoch: number,
  currentEpoch: number,
  engine: string,
): boolean {
  return (
    engine === 'chromium' &&
    method === 'GET' &&
    (resourceType === 'fetch' || resourceType === 'script') &&
    startedEpoch !== currentEpoch
  );
}

/** Return a same-origin pathname only; never retain query strings or foreign URLs. */
export function sameOriginBrowserPath(value: string, origin: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.origin !== new URL(origin).origin) return null;
    const pathname = parsed.pathname
      .replace(/\/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '/:id')
      .replace(/\/[0-9a-f]{24,}/gi, '/:id');
    if (/^\/_next\/static\/chunks\/[A-Za-z0-9._~-]+$/.test(pathname)) return pathname;

    // This is diagnostic output, not a general-purpose URL logger. Preserve
    // known route segments and redact any dynamic or unknown path segment.
    const knownRouteSegments = new Set([
      'account',
      'applications',
      'auth',
      'career-resources',
      'dashboard',
      'email',
      'jobs',
      'login',
      'matching',
      'notifications',
      'otp',
      'preparation',
      'profile',
      'resume',
      'saved',
      'security',
      'session',
      'settings',
      'signup',
      'verify',
    ]);
    return pathname
      .split('/')
      .map((segment, index) =>
        index === 0 || segment === '' || knownRouteSegments.has(segment) ? segment : ':segment',
      )
      .join('/');
  } catch {
    return null;
  }
}

/** Summarize browser warning text without retaining or returning its raw contents. */
export function browserWarningPaths(text: string, locationUrl: string, origin: string): string[] {
  const paths = new Set<string>();
  const locationPath = sameOriginBrowserPath(locationUrl, origin);
  if (locationPath?.startsWith('/_next/static/chunks/')) paths.add(locationPath);

  // Console messages can mention a requested resource while location() points
  // at the script that emitted the warning. Parse only same-origin Next chunks.
  for (const candidate of text.match(/https?:\/\/[^\s"'<>]+/g) ?? []) {
    const path = sameOriginBrowserPath(
      candidate.replace(/[),.;\u2018\u2019\u201c\u201d]+$/, ''),
      origin,
    );
    if (path?.startsWith('/_next/static/chunks/')) paths.add(path);
  }
  return [...paths];
}

/** Return a small fixed category; never persist or print the browser message. */
export function browserWarningCategory(text: string): string {
  if (/preload/i.test(text) && /not used/i.test(text)) return 'unused-preload';
  if (/preload/i.test(text)) return 'preload-warning';
  if (/NS_BINDING_ABORTED|ERR_ABORTED/i.test(text)) return 'aborted-request';
  if (/blocked/i.test(text)) return 'blocked-resource';
  if (/loading failed/i.test(text)) return 'loading-failed';
  if (/failed to load resource/i.test(text)) return 'failed-resource';
  return 'other';
}

/** Reduce browser network failures to fixed non-sensitive categories. */
export function browserRequestFailureCategory(errorText: string): string {
  if (/NS_BINDING_ABORTED|ERR_ABORTED/i.test(errorText)) return 'aborted';
  if (/timed?\s*out|ERR_TIMED_OUT/i.test(errorText)) return 'timeout';
  if (/ERR_(?:CONNECTION|NETWORK|INTERNET|ADDRESS)_/i.test(errorText)) return 'network-failure';
  return 'unclassified';
}
