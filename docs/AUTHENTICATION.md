# Private test access

The application offers two configured test identities through the account
selector only in the explicitly configured non-production test boundary. Their
identifiers and roles are defined once in `packages/core/src/test-users.ts`.
These are test identities, not verified email addresses. Password-based account
registration is unavailable in every runtime. Production sign-in uses the
application-managed email identity and opaque server-side session described
below; no OAuth or hosted identity provider is used.

Local development defaults to loopback access. `TEST_ACCESS_MODE=local` is
refused with a public origin or production runtime. Public origins default to
disabled test access. Hosted testing requires all of:

- explicit `DEPLOYMENT_ENVIRONMENT=staging`, HTTPS and `TEST_ACCESS_MODE=proxy`;
- a shared staging password enforced by Caddy's `basic_auth`;
- `CAREERSCOPE_STAGING_USER` and a bcrypt
  `CAREERSCOPE_STAGING_PASSWORD_HASH`, supplied privately by the operator;
- a random 32-byte hexadecimal `CAREERSCOPE_STAGING_PROXY_KEY`, shared only
  by Caddy and the API (`TEST_PROXY_SECRET`).

Caddy replaces the private assertion header after checking the staging
password and removes the Authorization header before proxying. The API checks
the assertion using constant-time digest comparison and accepts it only from
a loopback proxy peer. Database, queue and API ports remain private. The health
endpoint checks PostgreSQL and the shared Redis limiter before reporting ready;
it exposes only coarse health and version information and does not require the
staging password. A failed critical dependency returns a safe 503.

Generate the password hash interactively using Caddy's password-hashing tool;
do not put plaintext passwords in command arguments, examples, source or logs.
Store the hash and assertion in the protected host environment. The repository
does not supply a default staging password or deploy this configuration.

Selecting a test identity or verifying an existing account's email creates a
random opaque session family. PostgreSQL stores only SHA-256 token digests. The
access cookie is HttpOnly, SameSite=Strict, Secure on HTTPS, scoped to `/api`,
and valid for 15 minutes. The separate HttpOnly refresh cookie is scoped to
`/api/session`, valid for 30 days absolute, and is never exposed to browser
JavaScript. Each successful refresh atomically consumes the current refresh
token, rotates both credentials and preserves the family's original absolute
expiry. Reuse of a consumed token revokes the entire family. Refresh also
requires an exact Origin match; normal mutations continue to require Origin and
CSRF validation.

The account security surface lists active sessions using bounded categorical
browser/platform labels rather than storing raw User-Agent strings. Owners can
revoke one of their own device sessions or all other sessions. A revoked or
expired family cannot refresh. Password change revokes all sessions. Account
switching revokes the previous cookie's family and clears private client caches.
Owner IDs always come from the authenticated server session. Expired session
families are removed on a later successful session establishment; periodic
cleanup is not currently configured.

The forward session migration preserves existing opaque sessions only until
their original `expires_at`; it does not extend legacy lifetime, infer a device
or start timestamp, or create a refresh token that the browser never received.
Such a legacy session requires a fresh sign-in after its existing expiry.

The admin test identity has its own workspace; it does not grant unrestricted
database access or implement an admin control plane. Conflicting pre-existing
account identities are refused instead of overwritten.

Password-account internals and their regression tests remain for compatibility
with existing stored accounts. The executable API always selects the explicit
test-access configuration, disables registration and refuses password changes.
This temporary testing arrangement is not public production authentication.

## Production prohibition

`DEPLOYMENT_ENVIRONMENT` accepts only `development`, `staging` or `production`.
If absent, a production Node runtime defaults to production; otherwise it defaults
to development. Unknown or empty values fail startup. Production permits only
disabled test access, even with a valid proxy assertion and loopback origin.
Staging never defaults to local selection. A production-built staging deployment
can explicitly select staging while retaining `NODE_ENV=production`; this is not
permission to activate test access in production.

The production Compose API pins deployment environment to production and test
access to disabled, independent of the operator's env file. It no longer consumes
the staging assertion for API login. Existing proxy password protection is not
removed. A separately reviewed private staging configuration must supply the
explicit staging environment and the existing password/assertion safeguards.
No hosted configuration or deployment was changed by this code update.

## Email one-time-code sign-in

When `EMAIL_OTP_ENABLED=true`, the unauthenticated sign-in page requests and
verifies a six-digit code through `POST /api/otp/request` and
`POST /api/otp/verify`. The API uses the existing PostgreSQL user identity and
opaque session table; successful verification marks the email verified and
creates a session only for an existing user. Requesting or verifying a code never
creates an account. Known and unknown valid addresses use the same request
response and delivery path; rate limits are shared through Redis by address and
source IP. Email-specific throttling also returns the generic accepted response.

Challenges store a domain-separated HMAC of the normalized address, an OTP HMAC,
attempt count and expiry only. Codes expire after five minutes, are single-use,
and are limited to five verification attempts. Redis failure is fail-closed.
Resend calls use a fixed HTTPS endpoint, short timeout, one bounded retry with a
stable idempotency key and sanitized errors. Email HTML and text contain no
marketing links or externally hosted images. Resend domain-level open/click
tracking cannot be disabled by the send-email payload; an owner/operator must
verify both settings are disabled on the configured sender domain before any
real authentication email is sent.

An authenticated owner can request an email change through
`POST /api/account/email-change/request`; the API derives ownership from the
server-side session and requires the normal Origin/CSRF checks. A five-minute
challenge is bound to both the current verified address and the normalized new
address. Separate, address-bound codes are sent to both addresses; the current
address's message also serves as notice that a change was requested. The email
is not updated until both codes are verified. The `email_change_requests` row
persists the normalized proposed address in `new_email` as ordinary PostgreSQL
text so it can be applied after both verifications. It also stores the current
address HMAC, challenge IDs and code HMACs, attempt counts, verification times,
and expiry; it does not store either OTP. There is at most one pending row per
owner. Replacement, cancellation, successful completion, conflict, exhausted
attempts, or an expiry observed during verification deletes the row. Expiry is
enforced after five minutes. The existing weekly host-native retention job also
deletes requests whose `expires_at` has passed and preserves unexpired requests.
If that job runs as configured, an abandoned address is removed by the next
weekly sweep after expiry; live host-timer operation has not been verified. A
target address already owned by
another account returns a generic conflict and does not change the account. A
failed delivery cancels the pending request; the owner must request a fresh one.
The pending address is personal data and is subject to the still-unapproved
legal retention/deletion policy; do not describe it as HMAC-only or claim it is
erased exactly at challenge expiry.
This is local implementation and synthetic-provider test evidence only; it is
not live delivery, domain verification, or independent security approval.

Set these server-only values in an approved environment: `EMAIL_OTP_ENABLED`,
`EMAIL_OTP_HMAC_SECRET` (an independent random secret of at least 32 bytes),
`RESEND_API_KEY`, and `RESEND_FROM_EMAIL` (the approved sender). The legal
policy values are `LEGAL_TERMS_VERSION`, `LEGAL_TERMS_URL`, `LEGAL_PRIVACY_VERSION`,
`LEGAL_PRIVACY_URL` and `LEGAL_MARKETING_VERSION`; registration and test access are
controlled by `REGISTRATION_ENABLED` and `TEST_ACCESS_MODE`. Production startup
fails closed unless OTP is enabled and its HMAC and provider configuration are
present. `npm run setup:local` creates only synthetic loopback service settings;
optional provider values belong in an approved environment. Do not copy or print
real `.env` values, send a live test email, or apply migrations to a shared
database as part of local development.

The provider-neutral fallback interface exists, but no second delivery provider
or credentials have been selected/configured. The application currently uses
Resend as the primary only; launch resilience requiring a real fallback remains
an owner/provider gate. A Resend API success is acceptance by the API, not proof
of inbox delivery. Domain verification, tracking settings, real-delivery smoke,
production secret configuration, and hosted migration/health validation remain
unverified until performed by an authorized operator.

## Registration and legal acceptance status

OTP registration is implemented as a guarded capability, but it remains
unavailable unless the operator explicitly enables `REGISTRATION_ENABLED` and
configures versioned Terms and privacy notice URLs. Startup requires HTTPS URLs,
email OTP, and non-empty versions; the API exposes the configured links and only
creates an account after the matching signup OTP is verified. Required Terms and
privacy acceptance records, optional marketing consent, and the initial session
are persisted in the same PostgreSQL transaction that consumes the OTP. A
concurrent request that loses the unique-email race is treated as an existing
identity and cannot rewrite its consent history. Marketing changes are append-only
and ordered by a database sequence; withdrawal is not silently inferred from
account deletion or an email-provider event.

The legal documents in `docs/legal/` remain counsel drafts, not approved or
effective policy text. They must not be published or configured as acceptance
versions. The OTP signup capability remains disabled by default. Do not set
`REGISTRATION_ENABLED=true` until the owner and qualified counsel approve
effective versioned text, its public HTTPS URLs, the marketing language if used,
retention/deletion terms, and the production release decision. The code cannot
establish that legal content is approved merely because an operator has
configured a version and URL. No real provider delivery, legal acceptance, or
production behavior was exercised by local tests. Email sending to opted-in users
is not implemented; the marketing preference is only a recorded preference.
