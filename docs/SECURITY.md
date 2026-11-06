# Security controls and validation boundaries

CareerScope currently supports private local/hosted testing. Hosted access is
protected by a staging password at Caddy and a private assertion checked by the
API. Test selection accepts only the two server-defined identities. Read
[Authentication](AUTHENTICATION.md) before configuring a hosted test site.

The following controls remain in source:

- opaque random sessions stored hashed, HttpOnly/SameSite cookies and HTTPS Secure cookies;
- session-derived ownership, owner-scoped queries and composite ownership constraints;
- strict Origin checks, CSRF validation and bounded request/rate budgets;
- private encrypted resume files, bounded isolated parsing and typed capacity errors;
- transactional outbox delivery and fenced, idempotent worker effects;
- private persistent Redis queues with AOF and `noeviction`, independent of cache eviction;
- strict CSP, frame/object/base restrictions and redacted structured request logs;
- private network topology with only the intended edge ports published.

The optional email OTP implementation is disabled by default and fails closed
when enabled without a Resend key, fixed sender or dedicated 32-byte HMAC key.
Challenge rows contain only HMAC-derived identifiers/digests, have expiry and
attempt bounds, and are consumed transactionally. Request/verification have
shared Redis limits and generic responses; if the limiter is unavailable,
authentication is unavailable rather than unthrottled. The Resend adapter uses
a fixed HTTPS endpoint, disables redirects, bounds requests and uses a stable
idempotency key for its bounded retry. No live delivery/provider behavior was
tested. The second email provider was removed from scope by owner decision; Resend provider acceptance remains pending.
The consolidated local implementation includes refresh-token family/reuse checks,
session listing/revocation and dual-address email-change verification; these do
not constitute production or live provider acceptance.

`GET /api/health` checks PostgreSQL
and the mandatory shared Redis limiter and returns only a generic status
or generic 503, not dependency details. No live proxy topology, firewall or
external-port scan was performed in this change.

## Webhook ingress

Source review found no inbound provider webhook/callback handler in the API,
packages, or operational scripts. `scripts/jobs/run-scheduled-discovery.ts` has an
optional outbound HTTPS monitoring notification; it is not an inbound event
acceptance path. Any future inbound integration must validate authenticity and
freshness before processing, enforce schema/replay/idempotency controls, persist
durably before acknowledging, and return a retryable failure if durable
acceptance fails. No webhook integration or live notification was exercised.

The proxy removes Basic Authorization before forwarding and overwrites the
staging assertion header. Cookie, Authorization, assertion, password and token
fields are redacted. Never log provider bodies, resumes or environment values.
Do not weaken the secret scanner when removing an integration: credential
detectors remain useful even when the corresponding cloud SDK is absent.

Historical SQL migrations remain because existing databases depend on their
ordered journal. Their identity-related columns do not reactivate a provider.
Do not replace applied migrations with a new baseline on a deployed database.

Run `npm run gates:test`, `npm run test:integration`, `npm run test:domain`,
browser checks and `npm run security:check` against the current source.

## Dependency advisories

Verified on 2026-11-06 with `npm run security:check`: both the production-only
audit (`--omit=dev`) and full dependency-tree audit reported zero vulnerabilities.
The gate continues to run both audits at the high-severity threshold; no
suppression or threshold change was made.

Fixed by scoped overrides in `package.json` (verified by
`scripts/ci/dependency-remediation.test.mjs`, which fails CI if the lockfile
regresses to glob below 14.0.2 or an unpatched minimatch outside the lint path):

- `@fastify/static` uses `glob ^14.0.3` (GHSA-3g3m-2fjr-6pw4, AbortSignal
  bypass) with a nested `minimatch 11.x` (GHSA-g3hv-75wg-m249).
- `@typescript-eslint/typescript-estree` uses `minimatch ^11.0.3`.

The previously accepted development-only minimatch advisory is closed in
[DEPENDENCY-EXCEPTIONS](security/DEPENDENCY-EXCEPTIONS.md): the current lockfile
audit no longer reports it. The resolved tree may still contain minimatch 3.x
for ESLint compatibility, so dependency scanning remains enabled and must be
rechecked at each release gate.

Review: Dependabot (`.github/dependabot.yml`) opens weekly npm, GitHub Actions
and Docker update pull requests into `dev`. The nightly CI audit and
`npm run security:check` are re-read at each release; closed exceptions are
reopened if a later scan reports the advisory again.

Local tests are separate from live TLS/firewall validation, hosted staging
password acceptance, restore drills and manual screen-reader review. No current
live-security certification is asserted by this document.
