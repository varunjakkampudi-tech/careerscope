/**
 * Block detection — the one thing in this tier that has to be right.
 *
 * Every other failure in the app is loud. Being turned away is the failure that
 * arrives looking like success, so the cost of the two mistakes here is wildly
 * asymmetric and neither is self-announcing:
 *
 *  - A **false negative** reports a wall as an empty market. The user reads "0
 *    postings matched", concludes hiring is quiet, and searches again tomorrow.
 *  - A **false positive** reports a healthy source as walled, and sends someone
 *    debugging a network they cannot see.
 *
 * The suite is built around real captured pages for that reason. The headline
 * case is the Cloudflare JSD beacon: `/cdn-cgi/challenge-platform/scripts/jsd/`
 * ships on ordinary, working Indeed pages, so the obvious substring to match on
 * — `challenge-platform` — would black out a live source. The fixture carries
 * that beacon on purpose, and the pair of tests below pins the boundary from
 * both sides.
 */

import { describe, expect, it } from 'vitest';
import { describeEmptyOutcome, detectBlock } from './block.js';
import { fixture } from './harness.fixtures.js';

const indeedSearch = fixture('indeed-search.html');

/* -------------------------------------------------------------------------- */
/* The false-positive boundary                                                */
/* -------------------------------------------------------------------------- */

describe('detectBlock — healthy pages', () => {
  it('passes a real Indeed results page that carries the Cloudflare JSD beacon', () => {
    // The regression this fixture exists for. `/cdn-cgi/challenge-platform/
    // scripts/jsd/main.js` is Cloudflare's passive telemetry, served on pages
    // that are working perfectly. Matching the bare "challenge-platform" would
    // report every Indeed search as blocked, for as long as nobody checked.
    expect(indeedSearch).toContain('/cdn-cgi/challenge-platform/scripts/jsd/');

    expect(detectBlock('indeed', { status: 200, body: indeedSearch })).toBeNull();
  });

  it('still catches the interstitial that uses the same path prefix', () => {
    const interstitial =
      '<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>';

    // `/h/` is the discriminator, and it is the whole reason the needle is
    // written the long way. Losing it fails the previous test; losing this one
    // means a real wall goes unnamed.
    expect(detectBlock('indeed', { status: 200, body: interstitial })).toEqual({
      kind: 'challenge',
      message: expect.stringContaining('the search never ran'),
    });
  });

  it('does not fire on a job description that talks about captchas', () => {
    const jd =
      'You will build accessible forms, including reCAPTCHA and captcha-free alternatives.';

    // The needles are specific for exactly this reason: a bare "captcha" search
    // matches real postings, and an anti-fraud team's JD is not a wall.
    expect(detectBlock('linkedin', { status: 200, body: jd })).toBeNull();
  });

  it('reports nothing when there is nothing to go on', () => {
    expect(detectBlock('naukri', {})).toBeNull();
    expect(detectBlock('naukri', { status: 200, body: null, url: null })).toBeNull();
  });

  it('reads only the head of the body', () => {
    // Every signature lives in the document head or the first screen of markup.
    // Scanning a multi-megabyte board for them on every page is a real cost, so
    // the scan is capped — and the cap is pinned here so nobody "fixes" a miss
    // by removing it.
    const buried = `${'x'.repeat(20_000)}Just a moment...`;

    expect(detectBlock('indeed', { status: 200, body: buried })).toBeNull();
    expect(
      detectBlock('indeed', { status: 200, body: `Just a moment...${buried}` }),
    ).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Naming the wall                                                            */
/* -------------------------------------------------------------------------- */

describe('detectBlock — walls', () => {
  it('answers 429 as rate-limited before it reads anything else', () => {
    const block = detectBlock('naukri', { status: 429, body: '<html>ordinary page</html>' });

    expect(block?.kind).toBe('rate-limited');
    // The message says what the app did about it, because "slow down" with no
    // statement of policy reads as an accusation the user cannot act on.
    expect(block?.message).toContain('Requests are already paced');
  });

  it('names a 403 that is really a challenge as a challenge', () => {
    const block = detectBlock('indeed', {
      status: 403,
      body: '<html><head><title>Just a moment...</title></head></html>',
    });

    // The body is checked before the status so the specific reason wins. A bare
    // "HTTP 403" tells the user nothing they can decide anything with.
    expect(block?.kind).toBe('challenge');
  });

  it('falls back to forbidden for a refusal with no explanation', () => {
    expect(detectBlock('linkedin', { status: 403, body: '' })?.kind).toBe('forbidden');
    expect(detectBlock('linkedin', { status: 401, body: '' })?.kind).toBe('forbidden');
  });

  it('reads a login wall out of the URL as well as the body', () => {
    // LinkedIn redirects rather than rendering: the body can be an empty shell
    // while the address bar is the whole story.
    const block = detectBlock('linkedin', {
      status: 200,
      body: '<html></html>',
      url: 'https://www.linkedin.com/authwall?sessionRedirect=%2Fjobs',
    });

    expect(block?.kind).toBe('login-wall');
    expect(block?.message).toContain('signed-in account');
  });

  it('matches case-insensitively', () => {
    expect(detectBlock('indeed', { status: 200, body: 'JUST A MOMENT...' })?.kind).toBe(
      'challenge',
    );
    expect(detectBlock('indeed', { status: 200, body: 'DataDome' })?.kind).toBe('challenge');
  });

  it('names the source in every message, because the run log interleaves them', () => {
    const captcha = detectBlock('naukri', { status: 200, body: '<div class="g-recaptcha">' });

    expect(captcha?.kind).toBe('captcha');
    expect(captcha?.message).toMatch(/^naukri /);
    // Stated because a captcha is the one wall a user might assume we worked
    // around on their behalf.
    expect(captcha?.message).toContain('Nothing was submitted or bypassed');
  });
});

/* -------------------------------------------------------------------------- */
/* The empty line                                                             */
/* -------------------------------------------------------------------------- */

describe('describeEmptyOutcome', () => {
  it('prefers the block over any count', () => {
    const block = { kind: 'forbidden' as const, message: 'indeed refused the request.' };

    expect(describeEmptyOutcome('indeed', 40, block)).toBe(block.message);
  });

  it('says the source answered when it genuinely had nothing', () => {
    const message = describeEmptyOutcome('linkedin', 0, null);

    // The distinction the whole module exists for, in the one line the user
    // actually reads.
    expect(message).toContain('answered normally');
    expect(message).toContain('nothing to match');
  });

  it('says how many it looked at when the filters did the rejecting', () => {
    // Different advice follows from each: this one means "loosen the filters",
    // the one above means "this query is dead".
    expect(describeEmptyOutcome('naukri', 60, null)).toBe(
      "naukri returned 60 postings, none of which matched this query's filters.",
    );
  });

  it('never claims the source answered normally when the walk threw', () => {
    // The branch a live run demanded. `base.ts` swallows a throw so a source
    // that dies on page four still delivers pages one to three — and having
    // done so, the shell used to fall through to the sentence above. The user
    // then read a stack trace followed by "there was nothing to match" and
    // believed the second one, because the last line is the conclusion.
    const message = describeEmptyOutcome('linkedin', 0, null, true);

    expect(message).toContain('This is a fault, not an empty result.');
    expect(message).toContain('before it could read any postings');
    expect(message).not.toContain('answered normally');
  });

  it('still says how far it got when it threw partway through', () => {
    expect(describeEmptyOutcome('naukri', 25, null, true)).toBe(
      'naukri stopped after reading 25 postings, none of which matched — the reason is in the warning above. This is a fault, not an empty result.',
    );

    // Singular, because "1 postings" is the kind of detail that makes a user
    // wonder what else the message is careless about.
    expect(describeEmptyOutcome('naukri', 1, null, true)).toContain('after reading 1 posting,');
  });

  it('lets a named block outrank a fault', () => {
    // Both are true when a walk hits a wall and then dies cleaning up, and the
    // block is the more specific, more actionable of the two.
    const block = { kind: 'rate-limited' as const, message: 'naukri asked us to slow down.' };

    expect(describeEmptyOutcome('naukri', 12, block, true)).toBe(block.message);
  });
});
