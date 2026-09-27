import type { NextConfig } from 'next';

// The dev server needs its hot-reload websocket; a deployed build must not
// advertise loopback websocket origins in its policy.
const connectSources =
  process.env.NODE_ENV === 'production'
    ? "'self'"
    : "'self' ws://127.0.0.1:5280 ws://localhost:5280";

// CS-54: `script-src 'unsafe-inline'` is a real, disclosed weakness and it is
// STILL HERE — deliberately, with the reason measured rather than assumed.
//
// A nonce-based policy was implemented in `src/middleware.ts` on 2026-09-25,
// worked perfectly against the dev server, and BROKE THE APPLICATION ENTIRELY
// against a production build. Measured, not inferred: `next build` prerenders
// these routes as static HTML (`○ (Static)`), that HTML is generated at build
// time and therefore cannot carry a per-request nonce, and Next did not stamp
// one onto the scripts it had already emitted. `curl` against `next start`
// returned 10 `<script>` tags and 0 `nonce=` attributes, while the response
// header advertised a nonce. Because `'strict-dynamic'` makes the nonce
// authoritative and causes `'self'` to be ignored on any browser implementing
// it, none of those ten scripts could execute — `npm run test:ui` went red
// against the production server, the first element never appearing. The
// middleware was removed.
//
// So removing `'unsafe-inline'` is not a header edit.
//
// MEASURED 2026-09-25 against the production build in `.next`, which REVISES
// the sentence that used to sit here ("requires giving up static prerendering
// or moving to build-time hashes"). All 13 app routes are prerendered and ZERO
// render per request, so every inline script IS known at build time: 26 inline
// scripts across 13 pages, only 12 distinct SHA-256 hashes. A build-time hash
// policy can cover the whole surface and STATIC PRERENDERING DOES NOT HAVE TO
// BE GIVEN UP.
//
// What still blocks it is ORDERING, not feasibility: this `headers()` runs
// DURING the build, before the HTML containing those scripts exists, so the
// hashes cannot be computed and consumed in one pass. That needs a two-pass
// build or the policy served at the edge from a generated manifest - a build
// pipeline change, not a web-tier edit.
//
// The failure mode is a BLANK PAGE, not a weaker policy: a missing hash means
// React's hydration payload does not execute, exactly as the nonce attempt
// failed. Full measurement and the two traps in docs/CSP-STRICT-SCRIPT-SRC.md.
//
// Compensating controls meanwhile: session cookies are `httpOnly`, so a script
// cannot read them; `sameSite: 'strict'`; the API sets its own strict policy
// (`default-src 'none'`); there is no `dangerouslySetInnerHTML` anywhere in the
// app; and every rendered value goes through React's automatic escaping. The
// residual risk is recorded in `docs/KNOWN-LIMITATIONS.md`; CS-54 stays OPEN.
const nextConfig: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: 'http://127.0.0.1:5390/api/:path*' }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Cache-Control', value: 'no-store' },
          {
            key: 'Content-Security-Policy',
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
              `img-src 'self' data:; connect-src ${connectSources}; font-src 'self'; object-src 'none'; ` +
              "base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
