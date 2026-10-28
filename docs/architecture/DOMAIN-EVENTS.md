# Domain event contracts

This document lists every event or message kind the code can emit today: its payload, producer,
consumers and delivery guarantee. It describes current behaviour only. A kind that is declared but has
no producer is listed as such so nobody assumes it works.

`scripts/tests/domain-events-doc.test.ts` reads the source and fails if a kind below is missing from
the table of its section (a mention in prose does not count). When you add a command type, run event type, notification kind or template, SSE event name
or sign-in email purpose, add it here in the same change.

For the transactional outbox model and queue guarantees behind section 1, see
[OUTBOX](OUTBOX.md).

Common rules:

- Every message is owner-scoped. `ownerId` is carried in the message or the row and every consumer
  checks it against the stored record, never trusting the queue body alone.
- Payloads carry identifiers, never free text from the user (no job titles, notes, contacts or
  resume text).
- There are four separate mechanisms: durable commands (outbox plus queue), run events (a
  per-search progress log), notification events (a delivery outbox) and in-app interview reminders.
  They do not share tables.

## 1. Durable commands (command outbox)

Producers insert a row in `outbox_events` in the same transaction as the state change. The publisher
(`apps/workers/search/src/publisher.ts`) reads unpublished rows, sends each to a Redis queue and then
marks it published (`publishPending` in `packages/core/src/dispatch.ts`).

Envelope (`commandSchema` in `packages/core/src/commands.ts`, strict, `version` is always 1):

| Field           | Type           | Meaning                                            |
| --------------- | -------------- | -------------------------------------------------- |
| `id`            | uuid           | Command id and `command_executions` key            |
| `type`          | enum           | One of the kinds below                             |
| `version`       | literal 1      | Schema version                                     |
| `aggregateId`   | uuid           | The search run or resume upload the command is for |
| `ownerId`       | uuid           | Owning user                                        |
| `occurredAt`    | ISO datetime   | Creation time                                      |
| `correlationId` | uuid           | Equals `aggregateId` for current producers         |
| `causationId`   | uuid, optional | Not set by any current producer                    |

Delivery guarantee for all commands: at least once. A crash between send and "mark published"
repeats the send. Consumers are made safe by a lease and fence in `command_executions`: a consumer
claims the command (60 second lease, renewed every 15 seconds), only the holder of the current fence
can settle it, and settling is a single transaction. A duplicate message is a no-op (`duplicate` or
`busy`). After five attempts the command is failed and the queue message is dead-lettered; the
publisher reconciles dead letters by failing the stored command (`reconcileDeadLetter`).

| Kind                  | Status        | Payload (beyond the envelope)                                        | Producer                                                                                                                  | Consumers                                                                                               |
| --------------------- | ------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `search.collect`      | Emitted       | None. The run's request is read from `search_runs` by `aggregateId`. | `Database.createSearch` (`packages/core/src/database.ts`), called by `POST /api/searches` and the scheduled discovery job | Search worker `apps/workers/search/src/main.ts` (queue `careerscope-search`, BullMQ or local transport) |
| `resume.parse`        | Emitted       | None. The upload is read from `resume_uploads` by `aggregateId`.     | `ResumeUploadRepository.queueStoredUpload` in `packages/core/src/resumes.ts`, called by `POST /api/resumes`               | Files worker `apps/workers/search/src/files.ts` (queue `careerscope-files`)                             |
| `job.rank`            | Declared only | Not defined                                                          | No producer                                                                                                               | No consumer                                                                                             |
| `company.enrich`      | Declared only | Not defined                                                          | No producer                                                                                                               | No consumer                                                                                             |
| `email.process`       | Declared only | Not defined                                                          | No producer                                                                                                               | No consumer                                                                                             |
| `export.generate`     | Declared only | Not defined                                                          | No producer (exports are generated synchronously in the API)                                                              | No consumer                                                                                             |
| `application.prepare` | Declared only | Not defined                                                          | No producer                                                                                                               | No consumer                                                                                             |

`publishPending` only routes `search.collect` and `resume.parse`; a record of any other type is not
published. A declared-only kind needs a producer, a queue route, a handler and a row here before use.

## 2. Run events (search progress log)

Rows in `run_events` (`id`, `runId`, `ownerId`, `type`, `createdAt`, `sequence`). `sequence` is a
`bigserial` that orders the events of a run. There is no free-form payload: the event is its type plus
the run it belongs to. The event is written in the same transaction as the run status change.

Delivery guarantee: the log is the source of truth and is read, not pushed. The API serves it as a
Server-Sent Events stream (section 5) and as a list, both resumable from a `sequence` cursor, so a
client that misses an event reads it later. Events are exactly once per state transition because the
status update and the insert commit together and a transition only applies from `queued` or
`running`. Retention deletes events with their run (`scripts/jobs/enforce-search-retention.ts`).

| Event type        | Written when                                                   | Producer (`packages/core/src/database.ts`) | Consumers                                                  |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------- |
| `SearchQueued`    | A search run and its `search.collect` command are created      | `createSearch`                             | `GET /api/searches/:id/events` and the run detail timeline |
| `SearchStarted`   | A worker claims the command and the run moves to `running`     | `startSearch`                              | Same                                                       |
| `SearchCompleted` | The run settles with every source accepted                     | `settle` (via `completeCollection`)        | Same; also ends the SSE stream                             |
| `SearchPartial`   | The run settles with some sources failed or limited            | `settle` (via `completeCollection`)        | Same; also ends the SSE stream                             |
| `SearchFailed`    | The run settles as failed, or its command exhausts its retries | `settle` (via `fail`)                      | Same; also ends the SSE stream                             |
| `SearchCancelled` | The owner cancels a queued or running run                      | `cancelSearch`                             | Same; also ends the SSE stream                             |

## 3. Notification events (delivery outbox)

`NotificationOutbox.enqueue` (`packages/core/src/notification-delivery.ts`) writes one
`notification_events` row and one `notification_deliveries` row per distinct channel in a single
transaction. `deliverNext` claims one due delivery with `FOR UPDATE SKIP LOCKED` and a two minute
lease, sends it through an injected transport and records the result.

Payload (`NotificationEvent`):

| Field      | Type                              | Notes                                                                  |
| ---------- | --------------------------------- | ---------------------------------------------------------------------- |
| `id`       | uuid                              | Assigned by `enqueue`                                                  |
| `ownerId`  | uuid                              | Row cascades on user deletion                                          |
| `kind`     | `NotificationKind`                | Constrained by `notification_events_kind_check`                        |
| `template` | string                            | Must be a template below; unknown templates throw at render time       |
| `locale`   | `en`, `te` or `hi`                | Constrained in the database                                            |
| `payload`  | object of strings, max 4096 bytes | Never rendered into the message; copy is fixed per template and locale |

Notification kinds. Sign-in codes are not a kind and are refused by `enqueue` and `notificationChannels`.

| Kind          | Channel rule (`notificationChannels`)                 |
| ------------- | ----------------------------------------------------- |
| `security`    | Always sent; always includes email and never web push |
| `application` | Dropped when the owner disables it                    |
| `interview`   | Dropped when the owner disables it                    |
| `marketing`   | Needs an explicit opt-in; dropped when disabled       |

Templates (fixed copy in en, te and hi):

| Template             | Notes                                            |
| -------------------- | ------------------------------------------------ |
| `interview_reminder` | Fixed copy per locale; payload is never rendered |
| `account_security`   | Fixed copy per locale; payload is never rendered |
| `application_update` | Fixed copy per locale; payload is never rendered |
| `digest`             | Fixed copy per locale; payload is never rendered |

Channels:

| Channel    | Notes                                                   |
| ---------- | ------------------------------------------------------- |
| `in_app`   | Chosen from the owner's preferences                     |
| `email`    | Chosen from preferences; always included for `security` |
| `web_push` | Chosen from preferences; never used for `security`      |

Delivery guarantee: at least once per channel. A failed send retries with exponential backoff (one
minute doubling, capped at six hours), at most five attempts, then the delivery is dead-lettered into
`notification_dead_letters`. Only a fixed "delivery failed" message is stored, never the error text.
A crashed worker's claim is retried after two minutes, so a transport must tolerate a repeat.

Producer and consumers today: the outbox, templates, channel selection and retry logic are
implemented and tested, but no production code calls `enqueue` and no process calls `deliverNext`.
There are no live producers and no registered transports. Treat this section as the contract new
producers must meet, not as running behaviour.

## 4. In-app interview reminders

Rows in `in_app_notifications` hold `id`, `roundId`, `leadId`, `createdAt`, `readAt` and the
reminder time. They contain identifiers only: no interview title, contact or note text is copied.

| Kind                                            | Payload                           | Producer                                                                                           | Consumers                                                       | Delivery guarantee                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | --------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interview reminder (`in_app_notifications` row) | `roundId`, `leadId`, `reminderAt` | `publishDueInterviewReminders` (`packages/core/src/notifications.ts`), run on every publisher pass | `GET /api/notifications`, the notification panel in the web app | Exactly once per (owner, round, scheduled time): a unique key makes repeated and concurrent publisher passes idempotent. A rescheduled, cancelled or started round retires its notification (`retired_at`). The schedule in the database is the retry source, so a failed scan is retried on the next pass. |

## 5. Server-Sent Events on the search stream

`GET /api/searches/:id/events` (`apps/api/src/app.ts`) turns run events into a stream. It is a
view of section 2, not a separate source. Each stream lives at most 25 seconds and the client
reconnects with `Last-Event-ID`.

| SSE event         | Payload                          | Sent when                                                               |
| ----------------- | -------------------------------- | ----------------------------------------------------------------------- |
| `progress`        | `{ cursor, type, createdAt }`    | A new run event exists after the cursor; the SSE `id` is the cursor     |
| `reset`           | `{ "reason": "cursor-expired" }` | The cursor predates the retained events; the client resynchronises      |
| `settled`         | `{}`                             | The run reached a terminal status and no events remain; the stream ends |
| `session-expired` | `{}`                             | The session ended while the stream was open                             |
| `unavailable`     | `{}`                             | The stream failed on the server; the client reconnects with its cursor  |

Delivery guarantee: at least once and in order per run; a reconnect with the last cursor replays
anything missed. At most two streams per user and 32 overall.

## 6. Sign-in and email-change codes (direct provider sends)

These are not outbox messages. `EmailOtpProvider.send` is called inline by the API
(`packages/core/src/email-otp-delivery.ts`) and the challenge is stored beforehand. The `purpose`
selects the template.

| Purpose                | Payload                                      | Producer                                 | Delivery guarantee                                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sign-in`              | `email`, `code`, `idempotencyKey`            | `POST /api/otp/request`                  | At most once from the API. If the provider fails the challenge is invalidated and the caller gets 503; the user requests a new code. The idempotency key is the challenge id so a provider retry cannot double-send. |
| `email-change-current` | `email`, `code`, `idempotencyKey`, `purpose` | `POST /api/account/email-change/request` | Same. Both codes are sent together; if either fails the whole request is cancelled.                                                                                                                                  |
| `email-change-new`     | `email`, `code`, `idempotencyKey`, `purpose` | `POST /api/account/email-change/request` | Same.                                                                                                                                                                                                                |
