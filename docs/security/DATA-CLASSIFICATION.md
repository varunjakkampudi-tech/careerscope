# Data classification

Scope: every sensitive field CareerScope stores, where it lives, how it is
protected and how long it is kept. Verified against `packages/core/src/schema.ts`,
`auth.ts`, `email-otp*.ts`, `file-storage.ts`, `failure.ts` and the tests named
in the last section. Retention periods marked "policy pending" are the technical
behaviour today; the legal retention policy is not approved (see
[PRIVACY](../PRIVACY.md) and [KNOWN-LIMITATIONS](../KNOWN-LIMITATIONS.md)).

Classes: **Secret** (compromise grants access), **Personal** (identifies or
describes a person), **Private content** (user-authored or user-uploaded),
**Operational** (no personal content, but not public).

## Credentials and secrets

| Field                                                                                                 | Class  | Stored in                                                                                      | Protection                                                                                                                                                                                       | Retention                                                                      |
| ----------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Access token (random 32 bytes, hex)                                                                   | Secret | `sessions.token_hash` only                                                                     | SHA-256 digest; the raw token exists only in the HttpOnly Secure SameSite cookie and is never stored or logged                                                                                   | 15 min access window; row lives 30 days or until revoked, deleted once expired |
| Refresh token (random 32 bytes, hex, single use)                                                      | Secret | `session_refresh_tokens.token_hash` only                                                       | SHA-256 digest; consumed rows are kept for replay detection until the session expires                                                                                                            | 30 days, deleted with the session                                              |
| Password (legacy and test-harness accounts only)                                                      | Secret | `users.password_hash`                                                                          | Argon2id (19 MiB, 2 passes); never logged                                                                                                                                                        | Life of the account                                                            |
| Email one-time code (six digits)                                                                      | Secret | `email_otp_challenges.digest`, `email_change_requests.current_digest` and `new_digest`         | HMAC-SHA-256 keyed with `EMAIL_OTP_HMAC_SECRET`, bound to the challenge id; the code is only handed to the mailer; attempts are capped                                                           | 5 min expiry; consumed or replaced rows are deleted; expired ones are swept    |
| `EMAIL_OTP_HMAC_SECRET`, `RESEND_API_KEY`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `TEST_PROXY_SECRET` | Secret | Host environment files (root-only, 0600), never the database                                   | Not in the repository; compose requires them with a hard error when unset; see [SECRETS](../operations/SECRETS.md)                                                                               | Until rotated                                                                  |
| Resume encryption key (64 hex characters)                                                             | Secret | `/private/encryption.key` in the `private` volume, a separate file from the objects, mode 0600 | Created once by `bootstrap.mjs` with exclusive create; loaded only if private, a regular file and not a symlink; zeroed on close. Backed up to a different directory from the ciphertext archive | Life of the installation                                                       |

## Personal data

| Field                                                 | Class                     | Stored in                                                                               | Protection                                                                                       | Retention                                                                              |
| ----------------------------------------------------- | ------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Account email address                                 | Personal                  | `users.email` (plaintext; needed to log in and deliver codes)                           | Owner-scoped queries; unique index; never copied into challenge rows; scrubbed from error logs   | Life of the account (deletion policy pending)                                          |
| Address while signing in                              | Personal                  | `email_otp_challenges.email_hash`                                                       | HMAC-SHA-256 of the lower-cased address, domain-separated; the raw address is not stored         | 5 min, then deleted                                                                    |
| Proposed new address during an email change           | Personal                  | `email_change_requests.new_email` (plaintext, applied after both codes verify)          | Owner-scoped; the current address is stored as an HMAC only                                      | Deleted by the retention job after `expires_at`                                        |
| Age-screen result, consent versions, marketing opt-in | Personal                  | `users.age_screen_passed`, `account_acceptances`, `email_otp_challenges` until consumed | Append-only consent log; owner reference only                                                    | Life of the account (policy pending)                                                   |
| Session device label                                  | Personal                  | `sessions.device_label`                                                                 | Owner-scoped                                                                                     | With the session                                                                       |
| Candidate profile (titles, skills, preferences)       | Personal, private content | `candidate_profiles.data`; snapshot in `search_runs.matching_profile`                   | Owner-scoped queries (every repository takes the owner id); the snapshot is removed with its run | Profile: life of the account. Snapshot: 30 days with the run (`SEARCH_RETENTION_DAYS`) |
| Interview contacts, checklist, notes                  | Personal, private content | `interview_rounds.contacts`, `checklist`, `notes`                                       | Owner-scoped                                                                                     | Until the owner deletes the round (policy pending)                                     |
| Saved-job notes, tags, application evidence           | Private content           | `saved_leads.notes`, `tags`, `application_evidence`, `lead_history`                     | Owner-scoped; evidence is the candidate own report and is never presented as an employer receipt | Until the owner deletes the lead (policy pending)                                      |
| Employer acknowledgement reference                    | Personal                  | `employer_application_acknowledgements.reference`                                       | Owner-scoped                                                                                     | With the lead                                                                          |

## Resume content

| Field                                        | Class                     | Stored in                                                                | Protection                                                                                                                                                                                                                                      | Retention                                                                           |
| -------------------------------------------- | ------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Resume file bytes                            | Personal, private content | `/private/objects/<owner>_<resume>_<sha256>.bin` in the `private` volume | AES-256-GCM with a fresh 96-bit nonce per object. Owner id, resume id, digest, size, type and version are authenticated data, so a copied or tampered file fails to open. Directory mode 0700, no symlinks. The key is held in a different file | Until the owner deletes the upload; a cancelled upload leaves a 36-byte HMAC marker |
| Upload metadata (size, type, object version) | Operational               | `resume_uploads`                                                         | Owner-scoped; contains no content                                                                                                                                                                                                               | With the upload                                                                     |
| Parsed resume text and derived skills        | Personal, private content | `resume_results.parsed` (JSONB, plaintext in the database)               | Owner-scoped; only the derived sub-document is read into search snapshots. Protected by database access control and host disk controls, not by field encryption                                                                                 | With the upload                                                                     |

Known gap: parsed text lives unencrypted in PostgreSQL, so database dumps hold
resume content. Dumps are therefore treated as Personal data: 0600 files in a
0700 directory, root only.

## Work data and logs

| Field                                  | Class       | Stored in                                                                   | Protection                                                                                                                                 | Retention                                                        |
| -------------------------------------- | ----------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Search query, request, source outcomes | Personal    | `search_runs`                                                               | Owner-scoped; an idempotency hash is used only for comparison                                                                              | 30 days after creation for settled runs                          |
| Collected jobs (public postings)       | Operational | `search_jobs.data`, `job_sightings`                                         | Owner-scoped                                                                                                                               | 30 days for `search_jobs`; sightings are kept                    |
| Queue commands                         | Operational | `outbox_events.command`, Redis queue                                        | Identifiers only (owner, aggregate, correlation), no content. Redis is loopback-only, password-protected, AOF with noeviction              | Outbox rows kept; Redis completed jobs 24 h, failed jobs 14 days |
| Notification events and deliveries     | Personal    | `notification_events.payload`, `notification_deliveries.last_error`         | Owner-scoped                                                                                                                               | Until delivered or dead-lettered (policy pending)                |
| Application and worker logs            | Operational | Container stdout (JSON), rotated 10 MB x 5                                  | See log rules below                                                                                                                        | Bounded by rotation, about 50 MB per service                     |
| Backups                                | Personal    | `/var/backups/careerscope` (dump, resume archive) and its `keys/` directory | Root-only 0700/0600; the resume archive is ciphertext; the key copy is kept in a separate directory; see [BACKUP](../operations/BACKUP.md) | 14 days (`BACKUP_RETENTION_DAYS`)                                |

Log rules: `scrubMessage` removes emails, URL credentials, bearer tokens,
cookies, JWTs, key=value secrets, one-time codes written after their name and
opaque strings of 32 or more characters. Only the error name and the scrubbed
message are logged, never the stack, cause, request body or headers. Fastify
redacts the cookie, authorization and staging-key headers and per-request
logging is disabled.

## Separation rules

1. Credentials are stored as digests only. The raw value exists in the browser
   cookie, in memory, or in the one outbound email.
2. The resume key is never in the database, the repository, an object file or a
   log, and the ciphertext archive never contains it.
3. Every personal-data table carries an owner id and every read is filtered by
   it in the repository, not in the route.
4. Logs carry identifiers (command, execution, fence, attempt) and scrubbed
   error text, not user data.

## What the tests assert

- `packages/core/src/file-storage.test.ts`: the stored envelope is ciphertext
  with no plaintext or key bytes, a different key cannot open it, a flipped bit
  or a copy under another identity is rejected, malformed or group-readable key
  files are refused.
- `packages/core/src/sensitive-data.integration.test.ts`: after a real login and
  OTP challenge, the session and refresh token hashes equal the SHA-256 of the
  tokens, the password is Argon2id, the OTP row holds only an address hash and a
  digest, and no token, password or code appears in the text of any row of any
  table. The account address appears only in `users`.
- `packages/core/src/failure.test.ts`: the scrubber removes addresses, bearer
  tokens, cookies, JWTs, credentials in URLs and one-time codes, and
  `describeError` never exposes stack, cause or error fields.

Not verified: disk-level encryption of the host volume, the live retention
timers and the legal retention periods.
