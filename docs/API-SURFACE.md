# API Surface (CareerScope)

HTTP endpoints registered by the current API source. Derived by reading
[apps/api/src/app.ts](../apps/api/src/app.ts), which registers all of them
in one file. Source changes require deployment before they affect a hosted API.

## Interactive OpenAPI Documentation

The CareerScope source includes authenticated Swagger UI at `/api/docs/`, with the
OpenAPI 3.0.3 specification at `/api/docs/json` and `/api/docs/yaml`. This is
available only after running the updated API; adding it to source does not
deploy it. Sign in through the application first, then open `/api/docs/` on
that same origin. Expand an operation, select **Try it out**, supply its input,
and select **Execute**. These are real operations, not a sandbox: use synthetic
data for verification. Logout and password changes invalidate the current session.

The browser uses the existing HttpOnly cookie and fetches a fresh CSRF token
from `/api/session` before each authenticated mutation. Do not paste cookies or
tokens into Swagger's authorization controls. The browser supplies `Origin`;
the API still enforces its exact match. Idempotent operations require an
`Idempotency-Key`: reuse one only to retry the same input. Resume uploads use
raw `application/octet-stream`, not multipart form data. SSE output is buffered
by Try It Out until the connection closes, rather than displayed as live events.

The UI, redirects, JSON/YAML and local assets all require a valid session and
return `Cache-Control: no-store`. External validation, query-string UI
configuration and persistent authorization are disabled. Requests are limited to
same-origin `/api/` URLs. The docs-only CSP allows local scripts/styles and
inline style attributes; ordinary API security headers are unchanged.

Schemas are added only by Swagger's documentation transform, not to Fastify's
runtime validators or serializers. The regression in
[database.integration.test.ts](../tests/integration/database.integration.test.ts) compares the spec
to actual route registrations, including disabled resume capabilities. All
resume routes remain registered when storage is disabled: listing reports
`enabled: false`, while storage operations return 503. Cancellation depends on
the injected `cancelUpload` capability, which the current `main.ts` adapter
does not supply. The spec reports those configured capabilities and registration
availability rather than hiding their routes.

Dependencies are pinned to `@fastify/swagger` 9.8.1 and `@fastify/swagger-ui`
6.1.1. The latter's published plugin metadata supports Fastify 5 and resolves
a patched static server; older UI 5.x releases pull an affected static dependency.

---

## Global request contract

Applied by a single `onRequest` hook, in this order:

1. `Cache-Control: no-store` on every response.
2. `/api/health` short-circuits here. The auth hook (private-test-access gate, Origin,
   session, CSRF) does not apply to it, but the route is rate-limited per client
   address (60 per 60 seconds) and answers `429` beyond that.
3. **Origin check.** Any method other than `GET`, `HEAD` or `OPTIONS` must carry
   `Origin` exactly equal to the configured app origin, or the request is
   rejected `403 Origin denied`. A missing `Origin` fails this check.
4. `/api/login`, `/api/otp/request`, `/api/otp/verify` and
   refresh short-circuit here — unauthenticated mutations still require Origin,
   and step 3 has already run.
5. **Session.** The opaque token in the `careerscope_CareerScope_session` cookie is looked up.
   `/api/session` returns whatever it found, including "nothing".
6. Everything else requires a session, or `401 Authentication required`.
7. **CSRF.** Any non-`GET`/`HEAD`/`OPTIONS` request must carry `x-csrf-token`
   matching the session's token, or `403 CSRF check failed`.

Authenticated mutations require both a valid `Origin` and a valid CSRF token;
login and OTP request/verification require Origin but not CSRF. `ownerId` is taken from the
session, never from the request body or path.

### Server limits

| Setting             | Value                                                          |
| ------------------- | -------------------------------------------------------------- |
| `bodyLimit`         | 16 KiB (resume upload routes raise this to the resume maximum) |
| `requestTimeout`    | 15 s                                                           |
| `connectionTimeout` | 10 s                                                           |
| `trustProxy`        | `false` — forwarded headers are never believed                 |

### Error envelope

Every failure, from every route and from the framework itself, has one body shape
(`apps/api/src/errors.ts`, declared as `ErrorEnvelope` in the OpenAPI document):

```json
{ "code": "RATE_LIMITED", "message": "Too many requests", "requestId": "<uuid>", "details": {} }
```

| Field       | Meaning                                                                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`      | Stable machine code. Clients branch on this, never on `message`.                                                                                        |
| `message`   | Client-safe text. Never contains internal detail, submitted values or personal data.                                                                    |
| `requestId` | Correlates the response with the server log. Always present.                                                                                            |
| `details`   | Optional. Only a validation failure sets it: `{ "issues": [{ "path": "field.name", "code": "<zod issue code>" }] }`. Submitted values are never echoed. |

Default code per status:

| Condition                                                           | Status | `code`                                                                                               | `message`                                |
| ------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `ZodError`, `InvalidResumeUpload`, malformed JSON                   | 400    | `INVALID_REQUEST`                                                                                    | `Invalid request` (route text for some)  |
| missing or expired session, bad one-time code                       | 401    | `AUTHENTICATION_REQUIRED`                                                                            | route text                               |
| origin or CSRF check, private test access                           | 403    | `FORBIDDEN`                                                                                          | route text                               |
| unknown route (signed in), unavailable feature, record not owned    | 404    | `NOT_FOUND`                                                                                          | route text                               |
| method not allowed                                                  | 405    | `METHOD_NOT_ALLOWED`                                                                                 | `Method not allowed`                     |
| request timeout                                                     | 408    | `REQUEST_TIMEOUT`                                                                                    | `Request timeout`                        |
| `ProfileRevisionConflict`, `LeadRevisionConflict`, other `Conflict` | 409    | the `Conflict.code` (for example `PROFILE_REVISION_CONFLICT`); `CONFLICT` for a plain state conflict | mapped text, else `Idempotency conflict` |
| payload too large                                                   | 413    | `PAYLOAD_TOO_LARGE`                                                                                  | `Request too large`                      |
| unsupported content type                                            | 415    | `UNSUPPORTED_MEDIA_TYPE`                                                                             | `Unsupported media type`                 |
| rate limit exceeded                                                 | 429    | `RATE_LIMITED`                                                                                       | route text                               |
| dependency (Redis, database, provider) unavailable                  | 503    | `SERVICE_UNAVAILABLE`                                                                                | route text                               |
| `ResumeStorageLimit`                                                | 507    | `STORAGE_LIMIT_REACHED`                                                                              | `Resume storage capacity reached`        |
| anything unhandled                                                  | 500    | `INTERNAL_ERROR`                                                                                     | `Internal error`                         |

The 409 codes the web client maps (`apps/web/src/lib/api.ts`) are unchanged. The wire change
from the earlier `{ error, code?, requestId }` shape is that the text moved from `error` to `message` and
`code` is now present on every error. The web client reads only `code`, so it needed no change.

`DELETE /api/account/sessions/:id` answers 404 for an id that is not one of the caller's sessions. The
revocation is scoped to the caller's own sessions, so an unknown id and another user's id are
indistinguishable and no existence is revealed.

An unknown route answers `401 AUTHENTICATION_REQUIRED` to an anonymous caller, because the authentication
hook (step 6 above) runs before routing falls through to the not-found handler, and `404 NOT_FOUND` to a
signed-in caller. Anonymous callers therefore cannot probe which paths exist.

Coverage for each status: `apps/api/src/error-handler.test.ts` covers 400, 401, 403, 404, 405, 408, 413, 415,
429, 500 and 503. The 405 and 408 cases throw framework-shaped errors from throwaway routes (Fastify
sets `statusCode` on them) because a real 408 needs a stalled socket. 409 and 507 need real database
state and are covered by integration tests: 409 in `apps/api/src/resumes.integration.test.ts`,
`apps/api/src/interviews.integration.test.ts` and `tests/integration/database.integration.test.ts`;
507 in `apps/api/src/resumes.integration.test.ts` and `tests/integration/database.integration.test.ts`.

Route-family coverage: the same file sends an authenticated call with an invalid body to every route in the
OpenAPI document and checks that each failure is an envelope that echoes none of the submitted values. It
also fails when a registered route has no row in the tables below.

### Breaking changes

Recorded from commit `e4dad89` and the working tree after it. Clients written against the earlier API must change:

| Change                                                           | Before                                      | Now                                                                                                                      |
| ---------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Error body shape                                                 | `{ error, code?, requestId }`               | `{ code, message, requestId, details? }`; the text moved from `error` to `message` and `code` is always present          |
| Unknown routes                                                   | Fastify's default not-found body            | The envelope with `NOT_FOUND` (`401` for anonymous callers, see above)                                                   |
| `POST /api/register`                                             | Answered `404 Registration unavailable`     | Removed: anonymous callers get `401`, signed-in callers `404`. Accounts are created only by the email one-time-code flow |
| `DELETE /api/account/sessions/:id` with an unknown or foreign id | `204` for any id, whether or not it existed | `404 Session not found`; the web client treats it as "already gone" and refreshes the list                               |
| Unhandled-error text                                             | 500 said `Service unavailable`              | 500 says `Internal error` (changed after `e4dad89`; `apps/api/src/errors.ts`)                                            |

The 409 conflict codes and the `Conflict.code` to message mapping are unchanged.

`apps/api/src/error-handler.test.ts` checks the envelope for every status above, probes every documented
route unauthenticated and cross-origin, and checks the OpenAPI document declares the envelope for every
4xx and 5xx response. Internal error detail is never returned; 500s are logged against `requestId`.

---

## Endpoints

`Auth` = requires a session. `CSRF` = requires `x-csrf-token` and `Origin`.

### Health and session

| Method | Path                   | Auth | CSRF        | Notes                                                                                                                                                                                |
| ------ | ---------------------- | ---- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/api/health`          | no   | no          | Exempt from the auth hook, but rate-limited (429). Returns status only. Exempt from maintenance mode.                                                                                |
| GET    | `/api/session`         | no   | no          | Returns the current session or absence of one. Limited to 120 reads per minute per client address; users behind one shared address share that budget and get 429 `Too many requests` |
| POST   | `/api/login`           | no   | Origin only | Test-access account selection only                                                                                                                                                   |
| POST   | `/api/otp/request`     | no   | Origin only | Sign-in or explicitly configured signup challenge                                                                                                                                    |
| POST   | `/api/otp/verify`      | no   | Origin only | Verifies a challenge and establishes an opaque session                                                                                                                               |
| POST   | `/api/session/logout`  | no   | Origin only | Signs out with the refresh cookie after the access cookie has expired; revokes the session family. The web client uses this route                                                    |
| POST   | `/api/logout`          | yes  | yes         |                                                                                                                                                                                      |
| POST   | `/api/session/refresh` | no   | Origin only | Rotates the HttpOnly refresh cookie and returns `{ authenticated: true, csrf }`; reuse of a consumed token revokes the session family                                                |

### Account

| Method | Path                                  | Auth | CSRF | Success                                                                      |
| ------ | ------------------------------------- | ---- | ---- | ---------------------------------------------------------------------------- |
| GET    | `/api/account/sessions`               | yes  | no   | `200 { sessions: [{ id, createdAt, lastUsedAt, deviceLabel, current }] }`    |
| DELETE | `/api/account/sessions/:id`           | yes  | yes  | `204`; `404` for an unknown or foreign id                                    |
| POST   | `/api/account/sessions/revoke-others` | yes  | yes  | `204`                                                                        |
| POST   | `/api/account/email-change/request`   | yes  | yes  | `202 { message, expiresInSeconds }`; `404` when email sign-in is not enabled |
| POST   | `/api/account/email-change/verify`    | yes  | yes  | `200 { verified: "current" or "new", emailChanged }`                         |
| GET    | `/api/account/marketing-consent`      | yes  | no   | `200 { optedIn, version }`                                                   |
| POST   | `/api/account/marketing-consent`      | yes  | yes  | `200 { optedIn }`                                                            |

The executable test-access API returns 404 for registration and password changes,
regardless of REGISTRATION_ENABLED. The isolated legacy regression harness retains
password contracts; it is not a public signup integration. Hosted selection also
requires the staging password and private proxy assertion.

### Profile

| Method | Path                               | Auth | CSRF |
| ------ | ---------------------------------- | ---- | ---- |
| GET    | `/api/profile`                     | yes  | no   |
| PUT    | `/api/profile`                     | yes  | yes  |
| GET    | `/api/preparation`                 | yes  | no   |
| GET    | `/api/profile/accessibility`       | yes  | no   |
| PUT    | `/api/profile/scheduled-discovery` | yes  | yes  |

`GET /api/profile/accessibility` returns `{ reducedMotion }`. `PUT /api/profile/scheduled-discovery`
takes `{ enabled }` and returns `{ scheduledDiscoveryEnabled }`.

`PUT /api/profile` carries a revision. A stale revision is a 409, not a
last-write-wins overwrite.

The candidate profile may include the explicitly selected career segment
`student`, `fresher`, or `experienced`. It is optional for legacy profiles and
is not inferred from age or experience; it does not independently establish
education, identity, eligibility or verification.

Candidates may also save private, self-reported education entries, a graduation
year (1900–2100), and project summaries. Each list accepts up to 20 non-empty
entries of at most 200 characters. These claims are owner-scoped profile data;
they are neither independently verified nor inputs to deterministic matching.
Historical profile rows may omit these keys: profile reads preserve the stored
shape, while the profile editor displays absent lists/year as blank. The first
successful save writes the normalized empty lists if left blank. No data
backfill is performed.

Preparation is deterministic. External AI elaboration has been removed.

### Resumes

| Method | Path                       | Auth | CSRF | Rate limit  |
| ------ | -------------------------- | ---- | ---- | ----------- |
| GET    | `/api/resumes`             | yes  | no   | —           |
| POST   | `/api/resumes`             | yes  | yes  | 5 / hour    |
| GET    | `/api/resumes/:id`         | yes  | no   | —           |
| POST   | `/api/resumes/:id/recover` | yes  | yes  | 10 / hour   |
| POST   | `/api/resumes/:id/cancel`  | yes  | yes  | 20 / minute |
| DELETE | `/api/resumes/:id`         | yes  | yes  | 20 / minute |

`POST /api/resumes` takes `application/octet-stream`, requires an
`Idempotency-Key` header, and returns `202` with the upload id and status. It
returns `507` when storage capacity is exhausted, and `409` if the upload record
changed underneath it. A reused idempotency key with different content returns
`409` with code `IDEMPOTENCY_KEY_REUSED`. Client disconnect aborts the in-flight
write and leaves the upload `uploading`, where `recover` or a retry with the same
key can finish it.

`GET /api/resumes` returns up to 50 items. Each has `status` (`uploading`,
`queued`, `cancelling`, `cancelled`, `parsed` or `rejected`) and `cancellable`,
which is true only when the server has the storage cancel capability and the
status is `uploading` or `cancelling`. The response also carries
`cancellationEnabled`. The web panel shows the cancel control only when
`cancellable` is true.

`POST /api/resumes/:id/cancel` is synchronous and owner-scoped. It moves an
`uploading` upload to `cancelling`, writes the storage cancellation marker, then
sets `cancelled` and returns `200` with `{ id, status }`. Repeating it returns
`cancelled` again, and calling it on a `cancelling` upload finishes the cleanup.
No worker is involved. An unknown id or another owner's id returns `404`. A
`queued`, `parsed` or `rejected` upload returns `409` with code
`UPLOAD_NOT_CANCELLABLE`. If the cancellation marker quota or the storage volume
is full it returns `507`.

`cancel` and `delete` return `503` when the storage backend does not provide the
corresponding capability, rather than silently doing nothing. The API process
supplies both when private resume storage is configured.

### Leads

| Method | Path                       | Auth | CSRF |
| ------ | -------------------------- | ---- | ---- |
| GET    | `/api/leads`               | yes  | no   |
| POST   | `/api/leads`               | yes  | yes  |
| GET    | `/api/leads/by-job/:jobId` | yes  | no   |
| GET    | `/api/leads/:id`           | yes  | no   |
| GET    | `/api/leads/:id/history`   | yes  | no   |
| PUT    | `/api/leads/:id`           | yes  | yes  |

Leads are revisioned like profiles; `PUT` with a stale revision is a 409.
`lead_history` records every revision.

Updates may carry nullable candidate-reported `applicationEvidence`: method,
appliedAt (valid non-future ISO timestamp), confirmation, source and confidence.
Entering an application lifecycle stage requires a report; existing legacy rows
remain readable. Archive/restore preserves evidence, and history exposes the
previous status and whether notes/evidence changed. Evidence is the candidate's
claim, not an ATS event. Opening the application URL never mutates the status.

### Interviews, notifications, feedback and sources

| Method | Path                             | Auth | CSRF | Success                                                                    |
| ------ | -------------------------------- | ---- | ---- | -------------------------------------------------------------------------- |
| GET    | `/api/leads/:id/interviews`      | yes  | no   | `200 { items: InterviewRound[] }`                                          |
| POST   | `/api/leads/:id/interviews`      | yes  | yes  | `200 InterviewRound`                                                       |
| PUT    | `/api/interviews/:id`            | yes  | yes  | `200 InterviewRound`; a stale `revision` is a 409                          |
| GET    | `/api/notifications`             | yes  | no   | `200 { items: [{ id, roundId, leadId, createdAt, readAt }], unreadCount }` |
| GET    | `/api/notifications/preferences` | yes  | no   | `200 { interviewRemindersInAppEnabled }`                                   |
| PUT    | `/api/notifications/preferences` | yes  | yes  | `200 { interviewRemindersInAppEnabled }`                                   |
| PUT    | `/api/notifications/:id/read`    | yes  | yes  | `204`; `404` for an unknown or foreign id                                  |
| PUT    | `/api/search-jobs/:id/feedback`  | yes  | yes  | `200 { reason }`                                                           |
| GET    | `/api/job-sources`               | yes  | no   | `200 { items: [{ id, label, available, unavailableReason }] }`             |
| GET    | `/api/applications/export`       | yes  | no   | `200 text/csv`, privacy-scoped application records                         |

The full field list of every body is in the OpenAPI document (`/api/docs/json`, built from
`apps/api/src/openapi.ts`). `apps/api/src/error-handler.test.ts` fails when a registered route is
missing from the tables in this file.

### Searches

| Method | Path                       | Auth | CSRF |
| ------ | -------------------------- | ---- | ---- |
| POST   | `/api/searches`            | yes  | yes  |
| GET    | `/api/searches`            | yes  | no   |
| GET    | `/api/searches/:id`        | yes  | no   |
| POST   | `/api/searches/:id/cancel` | yes  | yes  |
| GET    | `/api/searches/:id/export` | yes  | no   |
| GET    | `/api/searches/:id/events` | yes  | no   |

`POST /api/searches` is idempotent per owner on `idempotencyKey`, enforced by the
`search_owner_key` unique index rather than by a read-then-write check.

`GET /api/searches/:id/events` is the SSE stream. See
[SSE](#server-sent-events).

---

## Owner isolation

Every repository query is scoped by `ownerId` taken from the session. The
database enforces this independently:

- `saved_leads` has a unique `(ownerId, id)` which is the target of
  `lead_history`'s composite foreign key, so history cannot reference another
  owner's lead.
- `resume_results` keys on `(ownerId, uploadId)` against `resume_uploads` for the
  same reason.

A guessed identifier belonging to another owner therefore returns 404, not the
record.

---

## Server-sent events

`GET /api/searches/:id/events`.

- Authorized by session and scoped to the owner, like every other route.
- Events carry a monotonic `sequence` from `run_events`, indexed by
  `(ownerId, runId, sequence)`.
- The client sends `Last-Event-ID` on reconnect and the server resumes after
  that sequence.
- Open streams are tracked in a `Map` and aborted on `preClose`, so a shutdown
  does not leak connections.

---

## Market And Pipeline

These are authenticated, owner-scoped, read-only routes derived from the owner's
search observations and saved leads:

| Method | Path                                | Input                                                             |
| ------ | ----------------------------------- | ----------------------------------------------------------------- |
| GET    | `/api/market/postings`              | Optional `limit`, default 50                                      |
| GET    | `/api/market/postings/:fingerprint` | Posting fingerprint, 1-256 characters                             |
| GET    | `/api/market/companies`             | Optional `limit`, default 25                                      |
| GET    | `/api/pipeline`                     | None                                                              |
| GET    | `/api/pipeline/stalled`             | Optional `days` (default 21, clamped 1-365), `limit` (default 50) |

Market page limits are coerced, floored and capped at 200; non-finite or
non-positive inputs use the default. These are observed owner data, not a
public job corpus or inferred market predictions.

## What is not here

No admin endpoints, public/unauthenticated job browsing, skills aggregates or
alerts. The owner-scoped market routes above do not provide a public company
directory.
