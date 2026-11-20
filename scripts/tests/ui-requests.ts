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
 * The same happens to the Next image optimiser request (`/_next/image`) behind the brand logo in the
 * shell: when a navigation replaces the document before the optimiser answers, Chromium cancels it
 * and Playwright never reports a finish. Reproduced with a bare page that loads `/` and navigates
 * away as soon as the image request starts (about 3 of 4 tries; it is not specific to a cold server).
 * Only that one path is dropped among images.
 *
 * In Chromium, a GET fetch or script (or the image optimiser path) from an earlier route is dropped.
 * Firefox also left one `/api/resumes/:id` fetch from an earlier route pending across 28 route
 * changes in CI; that narrow read is ignored only after its route has been replaced. Requests from
 * the current route, writes, documents and other images still count, so a real current-route hang is
 * still caught. A previous-route search-detail fetch is explicitly included; search-list reads use
 * `staleSearchRead`.
 *
 * The broad cancelled-fetch allowance applies only to Chromium. The one Firefox resume-detail
 * exception is limited to a GET fetch from a replaced route. All other Firefox and WebKit requests
 * remain in the settlement barrier.
 */
export function staleEarlierRouteRead(
  method: string,
  resourceType: string,
  startedEpoch: number,
  currentEpoch: number,
  engine: string,
  pathname = '',
): boolean {
  return (
    method === 'GET' &&
    startedEpoch !== currentEpoch &&
    ((engine === 'chromium' &&
      (resourceType === 'fetch' ||
        resourceType === 'script' ||
        (resourceType === 'image' && pathname === '/_next/image'))) ||
      (engine === 'firefox' &&
        resourceType === 'fetch' &&
        /^\/api\/resumes\/[^/]+$/.test(pathname)))
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
