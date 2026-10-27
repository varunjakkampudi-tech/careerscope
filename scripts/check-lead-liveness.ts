/**
 * CS-27 (part 1 of 2): "postings never expire or get re-checked."
 *
 * Periodically re-verifies a saved lead's applyUrl against the real world -
 * distinct from age, and never guessed. A lead is marked 'stale' only on an
 * unambiguous 404/410, 'live' only on a clear 2xx, and stays 'unknown' for
 * every other outcome (timeout, 5xx, DNS failure, a redirect loop) - the
 * same "nulls are honest" rule the discovery pipeline already applies to
 * normalization: an absent fact stays absent rather than becoming a guess.
 *
 * Invoked by careerscope-liveness.timer (host-native systemd, matching
 * CS-24/25/26) via `docker exec` into the api container.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { Database, LeadRepository, configuration, logger } from '@careerscope/core';

const BATCH_LIMIT = Number(process.env.LIVENESS_BATCH_LIMIT ?? 200);
const REQUEST_TIMEOUT_MS = Number(process.env.LIVENESS_TIMEOUT_MS ?? 10_000);
const STALE_AFTER_HOURS = Number(process.env.LIVENESS_RECHECK_HOURS ?? 24);
const MAX_REDIRECTS = 5;

/**
 * If `ip` is an IPv4-mapped IPv6 literal (::ffff:a.b.c.d, in either its
 * standard dotted-quad or fully-hex form), returns the embedded IPv4
 * address so it can be checked by the exact same rule as a native IPv4
 * address, instead of duplicating (and under-covering) that rule in hex.
 * Security review (P1) finding: the previous version only string-matched
 * `::ffff:127.` and `::ffff:10.`, silently letting `::ffff:172.16.x`,
 * `::ffff:192.168.x` and `::ffff:169.254.169.254` (the cloud metadata
 * endpoint) straight through.
 */
function unwrapIpv4MappedIpv6(ip: string): string | null {
  const lower = ip.toLowerCase();
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (dotted) return dotted[1]!;
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const [a, b] = [hex[1]!, hex[2]!].map((part) => parseInt(part, 16));
    return [(a! >> 8) & 0xff, a! & 0xff, (b! >> 8) & 0xff, b! & 0xff].join('.');
  }
  return null;
}

/**
 * Blocks the private/loopback/link-local ranges a resolved applyUrl must
 * never be allowed to reach - applyUrl is provider-sourced data (HTTPS-only,
 * credential-free per collectedJobSchema, but not restricted to public
 * hosts), and this script runs from inside the same private network the API
 * and database share. Without this check, a malicious or malformed applyUrl
 * could turn a routine liveness check into a probe of internal services.
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const mapped = unwrapIpv4MappedIpv6(ip);
  if (mapped) return isPrivateOrReservedIp(mapped);

  const version = isIP(ip);
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 10 ||
      a === 127 ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      a === 0
    );
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    return (
      lower === '::1' ||
      lower.startsWith('fe80:') ||
      lower.startsWith('fc') ||
      lower.startsWith('fd')
    );
  }
  return true; // Not a recognizable IP at all - refuse rather than guess safe.
}

export type CheckResult = 'live' | 'stale' | 'unknown';
export type LookupFn = (hostname: string) => Promise<{ address: string; family: number }>;

/**
 * Resolves `hostname` (via an injectable lookup, so this is unit-testable
 * without a real DNS query), validates the address, and returns an undici
 * Agent whose own `connect.lookup` always answers with that exact, already
 * validated address for this exact hostname - the request that follows is
 * physically unable to connect anywhere else, regardless of what a second,
 * independent DNS query might return by then.
 *
 * Security review (P1) finding: the previous version resolved and validated
 * a hostname, then handed the *hostname* (not the validated address) to
 * fetch(), which re-resolves independently for the real connection. A
 * classic DNS-rebinding TOCTOU: an attacker controlling the applyUrl's
 * domain can answer the validation lookup with a public address and the
 * real connection's lookup - moments later - with a private one. Pinning
 * the resolved address into the dispatcher closes that window entirely;
 * there is no second, independent resolution left to race.
 */
export async function pinnedDispatcher(
  hostname: string,
  lookupFn: LookupFn = lookup,
): Promise<Agent | 'blocked' | 'unresolvable'> {
  let resolved: { address: string; family: number };
  try {
    resolved = await lookupFn(hostname);
  } catch {
    return 'unresolvable';
  }
  if (isPrivateOrReservedIp(resolved.address)) {
    logger.warn({ hostname }, 'Liveness check refused: applyUrl resolves to a private address');
    return 'blocked';
  }
  return new Agent({
    connect: {
      lookup: (_host, _options, callback) => {
        callback(null, [{ address: resolved.address, family: resolved.family as 4 | 6 }]);
      },
    },
  });
}

/**
 * Follows redirects by hand, one hop at a time, so every hop - not just the
 * first request - gets its own fresh DNS-resolve-then-pin validation. A
 * library-driven `redirect: 'follow'` would otherwise let a first, benign
 * hostname redirect to a second, unvalidated one.
 */
export async function classifyResponse(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof undiciFetch = undiciFetch,
  lookupFn: LookupFn = lookup,
): Promise<CheckResult> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let hostname: string;
    try {
      hostname = new URL(currentUrl).hostname;
    } catch {
      return 'unknown';
    }
    const dispatcher = await pinnedDispatcher(hostname, lookupFn);
    if (dispatcher === 'blocked' || dispatcher === 'unresolvable') return 'unknown';
    try {
      // manual redirect handling (see above); HEAD first, GET only on a 405
      // some ATSes return for HEAD - same URL, same per-hop pinning either way.
      let response = await fetchImpl(currentUrl, {
        method: 'HEAD',
        redirect: 'manual',
        dispatcher,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 405) {
        response = await fetchImpl(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          dispatcher,
          signal: AbortSignal.timeout(timeoutMs),
        });
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return 'unknown';
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }
      if (response.status === 404 || response.status === 410) return 'stale';
      if (response.ok) return 'live';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }
  return 'unknown'; // Too many redirects - ambiguous, not stale.
}

async function main() {
  const env = configuration();
  const database = new Database(env.DATABASE_URL);
  const leads = new LeadRepository(database);
  try {
    const due = await leads.dueForLivenessCheck(BATCH_LIMIT, STALE_AFTER_HOURS);
    logger.info({ count: due.length }, 'Liveness check batch starting');
    let live = 0;
    let stale = 0;
    let unknown = 0;
    for (const lead of due) {
      const result = await classifyResponse(lead.applyUrl, REQUEST_TIMEOUT_MS);
      await leads.recordLivenessCheck(lead.ownerId, lead.id, result);
      if (result === 'live') live += 1;
      else if (result === 'stale') stale += 1;
      else unknown += 1;
      // Spread requests out rather than hammering many different third-party
      // ATSes back-to-back within the same second.
      await delay(200);
    }
    logger.info({ live, stale, unknown }, 'Liveness check batch complete');
  } finally {
    await database.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logger.error({ error: String(error) }, 'Liveness check run crashed');
    process.exitCode = 1;
  });
}
