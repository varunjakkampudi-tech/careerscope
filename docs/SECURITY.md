# Security

What protects CareerScope, where the boundaries are, and what is left open.

---

## Authentication

- **Argon2id** password hashing. The cost parameters are a security control.
  Never lower them to make a test faster — raise the test's timeout instead.
  Two auth tests already carry explicit 30 s timeouts for exactly this reason.
- **Opaque session tokens**, stored hashed. The cookie carries a random token,
  not a JWT, so a session can be revoked server-side immediately.
- Session cookie attributes, verified against the live origin:

  | Attribute  | Value    | Why                                  |
  | ---------- | -------- | ------------------------------------ |
  | `HttpOnly` | set      | `document.cookie` cannot read it     |
  | `Secure`   | set      | never sent over plaintext            |
  | `SameSite` | `Strict` | no cross-site transmission at all    |
  | `Path`     | `/api`   | not sent to the web app's own routes |

- **Revocation**: logout, and revoke-other-sessions. A revoked session's next
  request is a 401.
- **Password change** requires the current password, is rate limited to 5/hour,
  and clears the session cookie on success.

There is **no** email verification, forgot-password or reset flow. See
[KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md).

## Request-level controls

Enforced globally; see [API-SURFACE](API-SURFACE.md#global-request-contract).

- Every mutating request requires `Origin` **exactly** equal to the app origin.
  A missing `Origin` fails.
- Every mutating authenticated request requires `x-csrf-token` matching the
  session.
- `trustProxy: false`. Forwarded headers are never believed, so a spoofed
  `X-Forwarded-For` cannot influence anything.
- `Cache-Control: no-store` on every response.

## Owner isolation

`ownerId` always comes from the session, never from the request. The database
enforces it independently through composite foreign keys — `lead_history` and
`resume_results` key on `(ownerId, id)` of the owning row, so a cross-owner
reference is not representable. Guessed identifiers return 404.

## Transport and headers

Verified live on `https://careerscope.tech`:

| Header                         | Value                                                                                                        |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `Strict-Transport-Security`    | `max-age=31536000; includeSubDomains`                                                                        |
| `Content-Security-Policy`      | `default-src 'self'`, `object-src 'none'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'` |
| `X-Frame-Options`              | `DENY`                                                                                                       |
| `X-Content-Type-Options`       | `nosniff`                                                                                                    |
| `Referrer-Policy`              | `no-referrer`                                                                                                |
| `Cross-Origin-Opener-Policy`   | `same-origin`                                                                                                |
| `Cross-Origin-Resource-Policy` | `same-origin`                                                                                                |
| `Permissions-Policy`           | geolocation, microphone, camera, payment all `()`                                                            |
| `Server`                       | suppressed                                                                                                   |

- HTTP → HTTPS 301. `www` → apex 301.
- A foreign `Host` header gets **421**, not a response.
- Certificates and the ACME account key persist on a volume, so restarts do not
  re-request them.

## Network boundary

Defence in depth, strongest layer last:

1. Hostinger managed firewall — **not configured**, see
   [KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md).
2. nftables `inet careerscope`, input policy `drop`.
3. fail2ban SSH jail.
4. **Network namespace.** Every service except the proxy binds loopback inside
   the proxy's namespace. Postgres, Redis, LocalStack and the API have no
   routable address at all.

See [OPERATIONS/FIREWALL](OPERATIONS/FIREWALL.md).

## Container hardening

Applied to every service: `read_only`, `cap_drop: [ALL]`,
`no-new-privileges:true`, `pids_limit: 256`, non-root user `1000:1000`, bounded
logs, `tmpfs` for `/tmp`. The proxy alone adds back `NET_BIND_SERVICE`, solely
so an unprivileged process can bind 80 and 443.

## Logging

The API logger redacts `req.headers.cookie`, `req.headers.authorization`,
`password` and `token`. Framework request logging is disabled in favour of a
hand-written record containing only: request id, method, **route template**,
status, duration and whether the request was authenticated. URLs, query strings
and bodies are never logged, so a resume filename or a search term cannot leak
into the log.

## Threat model

| Threat                       | Mitigation                                                                  | Residual risk                                           |
| ---------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------- |
| Anonymous attacker           | 401 on every route but health/session/login/register; registration disabled | —                                                       |
| Cross-owner access           | Session-derived `ownerId` plus composite FKs                                | —                                                       |
| CSRF                         | Strict `Origin` **and** token; `SameSite=Strict`                            | —                                                       |
| Session theft via XSS        | `HttpOnly`, strict CSP, no `unsafe-eval`                                    | `unsafe-inline` styles/scripts remain in CSP            |
| Host header / proxy spoofing | 421 on foreign `Host`; `trustProxy: false`                                  | —                                                       |
| Malicious resume             | Type and size validated; parsing runs in a **child process**                | Parser crash is contained, not eliminated               |
| Malicious provider payload   | Per-source deadlines, failure isolation, normalization                      | A source can return plausible-but-wrong data            |
| Storage exhaustion           | `statfs` reservation, typed `ResumeStorageLimit`/507                        | Single-writer only; see limitations                     |
| Duplicate queue delivery     | Fenced executions, idempotency keys                                         | —                                                       |
| Stale worker                 | Lease expiry plus fence mismatch rejection                                  | —                                                       |
| SSH brute force              | Key-only auth; fail2ban                                                     | —                                                       |
| Compromised container        | Read-only, all capabilities dropped, no new privileges                      | Shares the proxy network namespace                      |
| Leaked secret                | Gitignored, redacted, never in docs                                         | `infra/v3/.env` is the only copy of the DB password     |
| Accidental operator action   | Scripts validate prerequisites and refuse unsafe input                      | —                                                       |
| Malicious GitHub change      | Actions pinned to SHAs; Dependabot                                          | Repository is **public**; no branch protection verified |

## Rules that must not be relaxed

1. Never weaken Argon2id parameters.
2. Never run `nft flush ruleset`.
3. Never publish an internal container port.
4. Never set `trustProxy: true` without a verified header-overwriting proxy.
5. Never log a URL, body, cookie or token.
6. Never disable a lint, type or test rule to get CI green.
7. AI stays off. Auto-apply stays on hold.
