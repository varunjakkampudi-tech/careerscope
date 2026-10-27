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
and the mandatory shared Redis limiter and returns only a generic status/version
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
The latest full dependency audit exits 1 with five high and seven moderate
findings; the production-only audit has three moderate findings in the DOCX
parser chain (`mammoth`/`argparse`/`sprintf-js`). The configured production
security command exits 0 only because its threshold is high; that is not a clean
all-severity audit or security waiver. These findings remain unresolved. No
force-fix, suppression, threshold change or waiver was applied.

Local tests are separate from live TLS/firewall validation, hosted staging
password acceptance, restore drills and manual screen-reader review. No current
live-security certification is asserted by this document.
