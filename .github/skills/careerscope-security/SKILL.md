---
name: careerscope-security
description: 'Authentication, sessions, CSRF, origin and cookie rules, owner isolation, rate limits and private-data handling. Use before touching auth, sessions, cookies, headers, rate limiting, logging, or anything reachable without a session.'
---

# CareerScope Security

## Purpose

CareerScope holds one person's resume, salary expectations and job history. The
security posture is deliberately strict and several values below are load-
bearing. None of them may be weakened to make a test pass or a flow convenient.

## When to use

- Touching authentication, registration, sessions or password change
- Changing cookie attributes, CORS, CSP or security headers
- Changing rate limits or `APP_ORIGIN` handling
- Adding a route, especially an unauthenticated one
- Adding logging near credentials or personal data

## Where the code lives

| Concern                      | Path                                                            |
| ---------------------------- | --------------------------------------------------------------- |
| Auth, sessions, CSRF tokens  | `v2/packages/core/src/auth.ts`                                  |
| Hooks, routes, error mapping | `v2/apps/api/src/app.ts`                                        |
| Origin and config validation | `v2/packages/core/src/runtime.ts`                               |
| Proxy headers and TLS        | `infra/v3/Caddyfile.production`                                 |
| Live checks                  | `infra/v3/check-live-origin.sh`, `infra/v3/check-live-flow.mjs` |

## Verified live behaviour

These are measured against the deployed origin, not asserted:

```
Set-Cookie: careerscope_v2_session=…; Max-Age=28800; Path=/api; HttpOnly; Secure; SameSite=Strict
cross-origin write  -> 403
origin-less write   -> 403
missing CSRF token  -> 403
unauthenticated API -> 401
foreign Host + valid SNI -> 421
```

## Rules

- **`Secure` cannot silently drop.** `appOrigin()` rejects a non-loopback
  `APP_ORIGIN` that is not HTTPS, because the cookie's `secure` flag is derived
  from the origin protocol.
- **Every state-changing request is checked twice**: the `Origin` header must
  equal `APP_ORIGIN` exactly, and a CSRF token must match the session. `/api/login`
  and `/api/register` skip only the session check, never the origin check.
- **Owner isolation is per-query.** Every read and write filters on `owner_id`.
  Another owner requesting a run must get 404, not 403 — do not leak existence.
- **Argon2id parameters are not tunable for test speed.** If a test is slow,
  raise the test timeout. This has already been done deliberately for three auth
  tests.
- **Registration is disabled in the deployed stack.** The owner account is
  created interactively with `v2/scripts/setup-owner.ts`. Do not enable public
  registration as a convenience.

## Rate limits

| Action              | Limit                                            |
| ------------------- | ------------------------------------------------ |
| login (per IP)      | 10 / 60 s                                        |
| login (per account) | 20 / 60 s                                        |
| register (per IP)   | 5 / 3600 s                                       |
| resume upload       | 5 / 3600 s                                       |
| resume recover      | 10 / 3600 s                                      |
| profile update      | 30 / 60 s                                        |
| preparation         | 30 / 60 s                                        |
| leads               | 60 / 60 s                                        |
| search              | 10 / 60 s                                        |
| event streams       | 30 / 60 s, max 2 concurrent per owner, 32 global |

IP-keyed limits hash the IP before use. Limits may be cleared for a verification
run, but the configured values must not be lowered.

## Data handling

- Logs redact `cookie`, `authorization`, `password` and `token`, and record route
  templates only — never URLs or bodies.
- Career preparation output is asserted never to echo the candidate email.
- The matching snapshot deliberately excludes name, email, phone, current CTC and
  notice period.
- Resumes, databases, credentials, browser state and generated builds stay out of
  Git and out of any public artifact.

## Proxy boundary

The proxy strips `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto`
from inbound requests so a client cannot spoof them. A request whose `Host` is
not the configured domain is answered 421 before routing. Unknown SNI fails the
handshake because no certificate is issued for it. Only the proxy publishes
ports; Postgres, Redis, the queue, the API and the web server are unreachable
from outside the host.

## Forbidden shortcuts

- Lowering Argon2 cost, rate limits, header strictness or validation to pass a test
- Returning 403 instead of 404 for another owner's resource
- Logging a token, password, cookie, resume text or full URL
- Trusting a forwarded header
- Adding an unauthenticated route without an explicit reason and a rate limit
- Widening CSP with `unsafe-eval` or a wildcard origin

## Verification

```sh
npm test -- apps/api/src/routes/auth.test.ts
npm test -- apps/api/src/db/repo/auth.test.ts
npm --prefix v2 test
npm audit --omit=dev && npm --prefix v2 audit --omit=dev

bash infra/v3/check-live-origin.sh https://careerscope.tech
```
