# Removing `script-src 'unsafe-inline'` from the web policy (the relevant regression)

**Status: IMPLEMENTED.** The measurements below informed the hash-based
production script policy. `apps/web/scripts/build-with-csp.mjs` performs a
discovery build, rebuilds with the discovered hashes, and repeats until the
generated inline script hashes are covered. `apps/web/next.config.ts` refuses
a standalone production build without the hash input. The counts below are a
historical measurement, not a claim about the current build output.

## What was already known, and cost a production outage to learn

A nonce middleware was implemented on 2026-09-25, worked against the dev server,
and **broke the application entirely** against a production build: `next build`
prerenders the routes as static HTML, that HTML cannot carry a per-request
value, and Next did not stamp the nonce onto scripts it had already emitted.
`curl` returned 10 `<script>` tags and **zero** `nonce=` attributes while the
response header advertised a nonce. Because `'strict-dynamic'` makes the nonce
authoritative and causes `'self'` to be ignored, none of those scripts could
execute. It was reverted.

**Do not retry the middleware approach.** The constraint is structural.

## What is now measured

Against the production build in `apps/web/.next` (`BUILD_ID`,
`prerender-manifest.json` and `routes-manifest.json` all present; no dev static
directory — confirmed a real build, not a dev artefact):

| Measurement                                   | Value   |
| --------------------------------------------- | ------- |
| App routes declared                           | 13      |
| **Prerendered at build time**                 | **13**  |
| **Rendered per request**                      | **0**   |
| Prerendered HTML files                        | 13      |
| Inline `<script>` elements with a body        | 26      |
| Inline scripts carrying a nonce               | 0       |
| **Distinct SHA-256 hashes**                   | **12**  |
| Distinct scripts shared by more than one page | 3 of 12 |

Two conclusions follow, and the first is the one that matters:

**1. Every app route is prerendered, so every inline script is known at build
time.** There are no per-request routes whose scripts could not be enumerated. A
build-time hash policy can therefore cover the entire surface — **static
prerendering does not have to be abandoned.**

**2. The hash set is small.** Twelve entries, not hundreds. One is the
`(self.__next_f=self.__next_f||[]).push([0])` bootstrap shared by all 13 pages;
the rest are per-page React Flight payloads.

## How the build resolves ordering

`npm run build` runs the web workspace's `build-with-csp.mjs`. It first builds
with hash discovery enabled, extracts hashes from generated static HTML, then
rebuilds with `CSP_SCRIPT_HASHES`. It compares the next output with the policy
and adds newly generated hashes to the union for another pass, failing after
four enforcement passes if the set does not converge. A normal production
build without the wrapper fails closed in `next.config.ts`.

The build is also exercised by the browser acceptance suite against a production
server; the recorded browser checks require a rendered page and verify the
script policy. The measurement table above remains historical evidence and
must not substitute for validation of the current build.

## Cost of getting it wrong, stated plainly

The failure mode is not a weaker policy — it is **a blank page**. Any inline
script whose hash is missing from the policy does not execute, and because these
are React's hydration and Flight payloads, a single missing hash breaks the
application exactly as the nonce attempt did. So the change must be proven the
same way that failure was found: **against a production server in a real
browser**, never against the dev server and never by reading the config.

Two specific traps:

- **A hash policy that is merely present proves nothing.** Asserting that
  `script-src` contains `sha256-` would pass while `'unsafe-inline'` is still
  there beside it — and `'unsafe-inline'` is _ignored_ when hashes are present,
  so the policy would look strict and behave strictly while the assertion
  measured neither. The assertion must be that `'unsafe-inline'` is **absent**,
  paired with a positive that the page actually rendered.
- **The stale-hash failure is silent in CI and loud in production.** If the
  build pipeline forgets to regenerate the manifest, the policy still parses and
  the site still returns 200 — with nothing executing.

## Compensating controls that remain in force meanwhile

Unchanged and still true: session cookies are `httpOnly` so a script cannot read
them; `sameSite: 'strict'`; the API sets its own strict policy
(`default-src 'none'`); there is no `dangerouslySetInnerHTML` anywhere in the
app; and every rendered value passes through React's automatic escaping.
`style-src 'unsafe-inline'` is a separate and substantially harder problem and
is not in scope here.

The remaining style policy and the need to validate each candidate build remain
recorded in [KNOWN-LIMITATIONS.md](../KNOWN-LIMITATIONS.md). The strict
production `script-src` implementation is in place; this document does not
certify a build or deployment that has not been tested.
