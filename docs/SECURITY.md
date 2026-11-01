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
tested. The required v12 fallback provider and provider acceptance remain pending.
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

Verified with `npm audit` on Node 24 after the glob/minimatch remediation:
the production-only audit (`--omit=dev`) reports zero advisories, and the full
audit reports zero high or critical findings and 15 moderate findings, all in
the development tree. `npm run security:check` runs both audits with a high
threshold and must keep doing so; no suppression or threshold change was made.

Fixed by scoped overrides in `package.json` (verified by
`scripts/ci/dependency-remediation.test.mjs`, which fails CI if the lockfile
regresses to glob below 14.0.2 or an unpatched minimatch outside the lint path):

- `@fastify/static` uses `glob ^14.0.3` (GHSA-3g3m-2fjr-6pw4, AbortSignal
  bypass) with a nested `minimatch 11.x` (GHSA-g3hv-75wg-m249).
- `@typescript-eslint/typescript-estree` uses `minimatch ^11.0.3`.

Accepted advisory, development only: GHSA-g3hv-75wg-m249 (minimatch below
11.0.1) through `minimatch 3.1.5` required by `eslint`, `@eslint/eslintrc`,
`@eslint/config-array`, `eslint-plugin-import`, `eslint-plugin-react` and
`eslint-plugin-jsx-a11y`. These packages call `require("minimatch")` as a
function (the 3.x API), which minimatch 11 no longer exports, so forcing 11
would break linting; 3.1.5 is the final 3.x release and has no fix. The path
is a lint tool with no runtime, request-handling or production-image exposure.
Owner decision needed: wait for upstream eslint and plugin releases that use
minimatch 11 (preferred), or accept this advisory indefinitely.

Review: Dependabot (`.github/dependabot.yml`) opens weekly npm, GitHub Actions
and Docker update pull requests into `dev`. The nightly CI audit and
`npm run security:check` are re-read at each release, and this list is
re-checked when eslint or the listed plugins publish a release.

Local tests are separate from live TLS/firewall validation, hosted staging
password acceptance, restore drills and manual screen-reader review. No current
live-security certification is asserted by this document.
