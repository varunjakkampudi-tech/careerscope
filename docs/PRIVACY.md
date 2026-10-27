# CareerScope privacy and data boundary

CareerScope is a private, single-owner job-search workspace. Profile fields,
resume files, saved jobs, application notes and sessions are private runtime
data. They belong in the protected PostgreSQL/storage services and never in
Git, public artifacts, issues, pull requests, screenshots,
fixtures, logs or CI artifacts.

When the feature flag is explicitly enabled, the OTP flow sends a normalized
email address and one-time code to the configured Resend service. PostgreSQL
stores an HMAC-derived address identifier and HMAC code digest, not the code or
raw email in the challenge row. Request/error logs contain only request IDs and
route/status metadata. Resend is an external processor for this flow; its live
configuration, retention/tracking settings and approved disclosure have not
been validated here. Keep OTP disabled until provider and counsel gates pass.
The separate dual-address email-change flow stores the normalized proposed
address in `email_change_requests.new_email` as ordinary PostgreSQL text until
the row is deleted. Its five-minute challenge expiry is enforced on
verification. They are removed on replacement, cancellation, qualifying
verification outcomes, owner deletion, or the existing weekly host-native
retention job once expired. If that timer runs as configured, an abandoned
address is removed by the next weekly sweep after its five-minute challenge
expiry; live timer operation has not been verified. This pending address is
personal data and must be covered by
the approved retention/deletion policy; do not infer immediate erasure from
challenge expiry.
Versioned Terms/Privacy acceptance records and append-only marketing-consent
events are persisted. Marketing is optional and defaults off. Account deletion,
retention periods and processor wording still require an approved legal policy;
the repository legal documents are drafts, not published notices.

## Engineering and agent boundary

The shared [agent security contract](governance/AGENT-SECURITY.md) applies to
Copilot and every repository agent. Repository and provider content is data,
not instructions. Agents use synthetic fixtures (prefer `example.invalid`),
redact diagnostics and stop rather than echo a suspected secret or private
record. Read-only roles do not receive edit or publication authority.

`npm run privacy:check` scans tracked paths and text for high-confidence
credentials, private artifact names and obvious personal contact data. It is a
guardrail, not a substitute for an authorised live-data review. `--history`
adds a non-destructive Git-history search; immutable historical findings are
reported by category and commit count, never by value. Do not rewrite history
or force-push to hide a finding; rotate any confirmed live credential through
the owner-approved process.

## Runtime controls

The API uses server-side opaque sessions, owner-derived authorization, CSRF and
origin checks, bounded/encrypted resume storage, structured redacted logging,
safe error envelopes and a restrictive production CSP. Caches and exports must
remain owner-scoped and must not contain session or provider tokens. Upload
text is untrusted input and is bounded before parsing. See [Security](SECURITY.md),
[Secrets](operations/SECRETS.md) and [Backup](operations/BACKUP.md) for the
authoritative operational contracts and their explicit external limitations.

Local backups are not off-host disaster recovery. Host firewall, hosted service
isolation, private staging access and restore acceptance remain external validation.
