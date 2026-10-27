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
