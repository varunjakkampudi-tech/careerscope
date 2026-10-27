# Data model

PostgreSQL is the production database and Drizzle owns migrations. Core data
includes owner-scoped profiles/preferences, encrypted resume metadata and
processing state, provider jobs/provenance, saved jobs, searches, and explicit
application lifecycle/history records.

Candidate application records are stored in `saved_leads`. The optional
`application_evidence` JSON value records a candidate's own method, reported
timestamp, confirmation, source and confidence; it is not an employer/ATS
receipt. Status and evidence changes are recorded in `lead_history` under the
same owner and revision. Evidence is append-preserved across archive/restore
actions rather than treated as proof or deleted by those organizational
changes. New application lifecycle changes require a candidate-entered report;
legacy status records without evidence remain readable.

OTP authentication uses `email_otp_challenges` with a unique HMAC-derived email
key, HMAC code digest, expiry, attempt count and consumed timestamp. It does not
store the OTP or raw email in the challenge row. New-account acceptance is
versioned in `account_acceptances`; optional marketing consent changes are an
append-only sequence in that same table. These records contain owner
references and consent timestamps and must follow account deletion/retention
policy once that policy has been approved. `users.email_verified_at` is nullable
and set only in the same transaction that successfully consumes an OTP. Password
login and local/protected-staging test-account selection do not establish it.
The signal applies to the account email, and the email-change flow verifies both
current and proposed addresses before updating it. A pending email change stores
the normalized proposed address as ordinary text in
`email_change_requests.new_email` so it can be applied after verification; the
row also stores address/code HMACs, challenge metadata and expiry, never either
OTP. Challenge expiry makes a request unusable; the existing weekly host-native
retention job deletes rows whose `expires_at` has passed and preserves unexpired
requests. If that timer runs as configured, an abandoned address is removed by
the next weekly sweep after its five-minute challenge expiry. Live timer
operation and the legal retention policy remain unverified. Migrations 0020–0025 preserve
the canonical OTP/session/consent/email-change schema. Migration
`0026_application_evidence.sql` adds application evidence and history without
reusing the conflicting unpublished migration numbers from the earlier branch.
The schema does not itself constitute legal approval.

Ownership is derived from the authenticated server session, never from a
client-supplied owner identifier. Transactional outbox rows publish work to
isolated Redis queues; workers are idempotent and fenced. Retention and
deletion behavior is documented in [PRIVACY.md](PRIVACY.md).
