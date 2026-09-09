/**
 * Telling "nothing matched" apart from "we were turned away".
 *
 * This is the reason the scrape tier is worth trusting at all. Every other kind
 * of failure in this app is loud — a 500 throws, a timeout throws, a malformed
 * payload throws. Being blocked is the one failure that arrives looking like
 * success: a 200 with a challenge page in it, or a login wall rendered where the
 * results were, parses to zero jobs and reports "0 postings matched". The user
 * reads that as a quiet market and searches again tomorrow.
 *
 * So a block is detected explicitly and named, and the provider says which of
 * the two happened. That is the same discipline the company enricher already
 * follows when it writes "Not yet verified" instead of guessing an address:
 * where the app does not know, it says so rather than producing a confident
 * empty answer.
 *
 * The signatures below are matched to *report* a wall, never to get around one.
 */

import type { SourceId } from '@job-radar/shared';

/** Why a request did not produce results, when the reason was not an error. */
export type BlockKind =
  /** A bot-management interstitial — Cloudflare, PerimeterX, DataDome. */
  | 'challenge'
  /** An explicit human-verification step. */
  | 'captcha'
  /** The content exists but requires an account. */
  | 'login-wall'
  /** Asked to slow down: HTTP 429, or the site's own throttle page. */
  | 'rate-limited'
  /** A refusal with no further explanation. */
  | 'forbidden';

export interface BlockDetection {
  kind: BlockKind;
  /** One sentence for the run log, written for the user. */
  message: string;
}

/**
 * Substrings that identify each wall, lowercased.
 *
 * Deliberately specific. A generic search for "captcha" matches any job
 * description that happens to mention the word — and a false positive here is
 * worse than a false negative, because it would report a healthy source as
 * blocked and send someone debugging a network they cannot see.
 */
const SIGNATURES: ReadonlyArray<{ kind: BlockKind; needles: readonly string[] }> = [
  {
    kind: 'captcha',
    needles: ['g-recaptcha', 'hcaptcha.com', 'recaptcha/api.js', 'px-captcha', 'solve this puzzle'],
  },
  {
    kind: 'challenge',
    needles: [
      'just a moment...',
      'cf-browser-verification',
      'cf_chl_opt',
      // Not the bare string "challenge-platform": Cloudflare serves
      // `/cdn-cgi/challenge-platform/scripts/jsd/main.js` on ordinary pages that
      // are working perfectly — a healthy Indeed results page carries it — while
      // a real interstitial uses the `/h/<b|g>/orchestrate/` path and also sets
      // `cf_chl_opt` above. Matching the broad form would report a live source as
      // walled, which is the failure this module exists to prevent.
      '/challenge-platform/h/',
      'checking your browser before',
      'enable javascript and cookies to continue',
      '_incapsula_resource',
      'datadome',
      'perimeterx',
    ],
  },
  {
    kind: 'rate-limited',
    needles: ['too many requests', 'rate limit exceeded', 'unusual traffic from your'],
  },
  {
    kind: 'login-wall',
    needles: [
      '/authwall',
      'sign in to continue',
      'join linkedin to see',
      'please log in to continue',
      'session_redirect',
    ],
  },
];

/** Human-readable reason per kind, with the source named. */
const MESSAGES: Record<BlockKind, (source: SourceId) => string> = {
  challenge: (source) =>
    `${source} served a bot-check page instead of results. This is not "no jobs found" — the search never ran. Try again later, or leave this source off and rely on the boards that answer.`,
  captcha: (source) =>
    `${source} asked for a captcha, so no results could be read. Nothing was submitted or bypassed.`,
  'login-wall': (source) =>
    `${source} required a signed-in account for this page, so it returned no public results.`,
  'rate-limited': (source) =>
    `${source} asked us to slow down. Requests are already paced; this run stopped this source early rather than push.`,
  forbidden: (source) =>
    `${source} refused the request outright (HTTP 403). The search did not run — this is a refusal, not an empty result.`,
};

/**
 * Identify a wall in a response, or return null when the page looks real.
 *
 * `status` is consulted first because it is unambiguous, then the body, which is
 * where a 200-with-a-challenge hides. Only the head of the body is scanned: every
 * signature above lives in the document head or the first screen of markup, and
 * scanning a 12 MB board for them on every page would be a real cost for no gain.
 */
export function detectBlock(
  source: SourceId,
  input: { status?: number | null; body?: string | null; url?: string | null },
): BlockDetection | null {
  const status = input.status ?? null;

  if (status === 429) return { kind: 'rate-limited', message: MESSAGES['rate-limited'](source) };

  const haystack = `${(input.body ?? '').slice(0, 20_000)}\n${input.url ?? ''}`.toLowerCase();

  for (const { kind, needles } of SIGNATURES) {
    if (needles.some((needle) => haystack.includes(needle))) {
      return { kind, message: MESSAGES[kind](source) };
    }
  }

  // Checked after the body so a 403 that *is* a challenge is named as one — the
  // specific reason is more useful than the generic status.
  if (status === 401 || status === 403) {
    return { kind: 'forbidden', message: MESSAGES.forbidden(source) };
  }

  return null;
}

/**
 * The line a source logs when it finishes having found nothing.
 *
 * Split out so "0 results" is never printed without saying which of the *three*
 * things it means, and so every branch reads the same way in the run log.
 *
 * The third branch is the one that is easy to miss. A thrown error is loud right
 * up until `createScrapeProvider` catches it — which it must, because a source
 * that dies on page four should still deliver pages one to three. But having
 * swallowed the throw to keep those results, the shell would then fall through
 * to "the source answered normally", and that sentence is the one the user
 * reads as the conclusion. A live run surfaced exactly that: a warning naming a
 * crash, followed immediately by a line asserting the source was healthy and
 * the market was quiet.
 */
export function describeEmptyOutcome(
  source: SourceId,
  scanned: number,
  block: BlockDetection | null,
  /** True when the walk ended on a thrown error rather than on its own terms. */
  failed = false,
): string {
  if (block) return block.message;
  if (failed) {
    const point =
      scanned === 0
        ? 'before it could read any postings'
        : `after reading ${scanned} posting${scanned === 1 ? '' : 's'}, none of which matched`;
    return `${source} stopped ${point} — the reason is in the warning above. This is a fault, not an empty result.`;
  }
  if (scanned === 0) {
    return `${source} returned no postings for this query. The source answered normally — there was nothing to match.`;
  }
  return `${source} returned ${scanned} postings, none of which matched this query's filters.`;
}
