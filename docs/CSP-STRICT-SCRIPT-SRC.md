# Removing `script-src 'unsafe-inline'` from the web policy (CS-54)

**Status: MEASURED, NOT IMPLEMENTED.** This records what a strict `script-src`
would actually cost, measured against a real production build rather than
estimated. It supersedes the assumption — written into `next.config.ts` after
the failed nonce attempt — that the only routes forward were _"give up static
prerendering or move to build-time hashes"_, by establishing that **the hash
route does not require giving up static prerendering** and is far smaller than
feared.

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

Against the production build in `v2/apps/web/.next` (`BUILD_ID`,
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

## The remaining obstacle is ordering, not feasibility

`headers()` in `next.config.ts` is evaluated **during** the build, before the
HTML that contains those scripts exists. The hashes cannot be computed and
consumed in the same pass. That is the same class of problem as the nonce — a
static header trying to describe content it has not seen — and it is why this is
still not a header edit.

Two workable shapes, both of which need a change to the build pipeline:

- **Two-pass build.** Build, compute the hashes from the emitted HTML, write
  them to a generated file, then build again with `headers()` reading that file.
  Viable only if the second pass produces byte-identical HTML — **this is the
  one assumption below that has NOT been verified here**, because rebuilding
  would overwrite `.next` underneath a running dev server.
- **Emit the header at the edge.** Generate a hash manifest at build time and
  have the reverse proxy serve the policy. This removes the ordering problem
  entirely, because the proxy reads the manifest after the build has finished.

Both touch build or infrastructure files. Neither belongs to the web tier alone,
and neither should be attempted as a drive-by edit.

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

The residual risk stays recorded in
[KNOWN-LIMITATIONS.md](KNOWN-LIMITATIONS.md). **CS-54 stays open.**
