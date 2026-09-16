# CareerScope v2

Local architecture migration, version 2.0.0-alpha.1. This is a working authenticated
search vertical slice, **not the complete v1 feature migration or a release**.
The original v1 application, data and Pages publication remain separate.

## Revised Architecture Target

The [v2 specification](ARCHITECTURE.md) now targets Docker Compose, PostgreSQL,
BullMQ with dedicated persistent Redis, private S3-compatible storage, configurable local-only Ollama,
Nginx and optional bounded observability. No paid infrastructure or hosted inference
service is required by the design. Hardware, electricity and independent backups
still have costs; this is not a high-availability or production-readiness claim.

This is a target specification, **not a completed runtime migration**. The setup
below still runs the verified LocalStack/SQS-based implementation. Do not replace
its disposable throttle Redis with queue traffic or remove existing volumes.
Native Ollama with Metal is preferred on this Mac; container CPU inference is an
alternative to benchmark. No model is enabled for application inference.

Latest September 15 verification: 31 V2 tests, static/build/format gates, isolated queue
restart/AOF restore, and Chromium/Firefox/WebKit workflows at 320/390/1440px passed.
The root regression suite has 1,043 passing tests. These checks cover implemented
workflows only, not the missing resume/AI/recovery/cutover gates. The current Fastify
request-logging option emits a deprecation warning for its future major release.

## Implemented

- Next.js 16 / React 19 private workspace with TanStack Query and Lucide.
- Fastify 5 API: opaque PostgreSQL sessions, Argon2id passwords, origin and CSRF
  enforcement, Redis login/search throttling, bounded owner-scoped reads.
- PostgreSQL 17 / Drizzle migrations: users, sessions, searches, normalized search
  results, transactional outbox, fenced executions and durable run events.
- Separate publisher and search-worker processes. Search submission returns 202
  with a run ID; collection never runs inside the request handler.
- Local SQS-compatible queues and dead-letter queues. Send-before-mark publication,
  durable duplicate detection, bounded jitter, renewable leases, fenced result
  commits, retry exhaustion and dead-letter reconciliation.
- Remote OK and Himalayas collection reuse the existing repository providers and normalization
  packages. Source warnings/errors produce failed source outcomes, retaining
  validated jobs; cancellation still aborts the attempt. Select either or both;
  duplicate/unknown source selections are rejected. Shared deduplication keeps the
  richer normalized record before deterministic matching. Limits: 100 candidates
  per source, 100 final results, 30-day window, 25 seconds per source and a
  60-second combined deadline.
  Himalayas scans at most 20 pages (2,000 recent postings), not its full inventory.
  Source failures persist a `partial` run when validated jobs or a successful source
  remain; all failed sources without retained jobs persist a `failed` run. Outcomes
  include accepted counts, limits and fixed error codes. API/UI/export preserve the
  distinction; targeted retry creates a new run. Detailed live source progress
  remains pending. Remotive is not enabled until
  a restart-safe shared fetch budget/cache can honor its low request allowance.
  The UI preserves selected sources per run and links each result to its source.
  September 14 live Himalayas smoke returned four jobs in about seven seconds;
  it used a generic query without a profile and did not persist jobs.
- Real PostgreSQL, Redis and LocalStack integration checks plus browser checks.
- Opt-in BullMQ search transport with a dedicated AOF/noeviction Redis service.
  It reuses durable outbox publication, fenced completion and attempt budgets;
  integration tests cover transport loss, duplicates, failed-job repair, lock-loss
  notification cancellation and sanitized failures. SQS remains the default.
- Owner-scoped candidate profiles and preferences, strict input validation and
  revision-based updates. Conflicts retain local edits until an explicit reload.
- Searches capture a minimal immutable matching profile and its revision.
  Deterministic matching reuses the existing engine with exclusions, description
  confidence ceilings, company flags and visible dimension evidence. Searches
  without a profile remain unscored; no AI reranking is connected yet.
- Confirmed search cancellation through `POST /api/searches/:id/cancel`, with
  owner, origin, CSRF and rate-limit enforcement. One transaction marks the search
  cancelled, fences existing execution and emits one durable `SearchCancelled` event.
  The command is marked handled (`completed`) for transport acknowledgement, not
  successful search completion. Both transports skip it on redelivery. Active
  provider work receives cancellation when its next 15-second heartbeat fails;
  stale workers cannot commit after cancellation. A completion that wins the race
  remains completed. Repeated cancel requests are idempotent.
- Completed/partial-search JSON downloads through `GET /api/searches/:id/export` and the
  result toolbar. The authenticated, owner-scoped endpoint is limited to 30 requests
  per minute and 100 jobs, with `no-store` and an attachment filename based on the
  validated run ID. Version 1 contains `schemaVersion`, `runId`, `status`, `sourceOutcomes`, `request` and
  allowlisted normalized `jobs`, ordered like the result view. Empty completed runs
  export an empty array; other run states return 409. Downloads include all results
  from the run regardless of the local text filter. Profiles, matching snapshots,
  sessions and unexpected stored fields are excluded; job descriptions and derived
  match evidence are included, so downloads remain private. JSON preserves literal
  text without interpreting spreadsheet formulas. This bounded synchronous read
  does not need a queue or object store; background/bulk exports, CSV, saved-lead
  exports and backup/import workflows remain pending.
  Browser checks verify downloaded contents, pending state, failure/keyboard retry
  and expired-session reauthentication in Chromium, Firefox and WebKit.

## Search Outcomes And Live Events

Migration `0007` adds bounded source outcomes and the `partial` terminal state;
`0008` indexes owner/run/cursor replay. Fenced settlement validates the selected
sources and source-specific counts before persisting jobs, outcomes and one terminal
event. Recorded provider failures are handled commands, not transport failures;
the search stays visibly failed or partial. Infrastructure exceptions retain their
existing retry/DLQ policy. Matching snapshots remain immutable. Partial jobs can be
saved without changing existing notes or lead statuses.

`GET /api/searches/:id/events` accepts a validated `Last-Event-ID` header (preferred)
or `after` query cursor. It replays 50 events per batch, with two streams per owner,
32 per API process and 30 opens/minute. Connections last 25 seconds; the one-second
loop sends heartbeats and rechecks sessions. Disconnect/shutdown cancels streams;
terminal events end replay. Invalid/foreign cursors return400. There is no event
retention yet; implement a reset/snapshot protocol before deleting event history.
Payloads contain event cursors, types and timestamps, not job/profile content.
Native EventSource uses a two-second reconnect hint, with ten-second detail polling
as fallback. SearchStarted is fenced/idempotent; state/event writes serialize per
run, so replay does not depend on global cross-run allocation/commit order.

Tests cover populated `0006` upgrades, fresh/repeat migrations, competing start/
terminal writes, partial/total source failure through SQS and BullMQ execution
policy, duplicate suppression, rollback, owner isolation, replay/reconnect, bad
cursors, concurrent stream limits and live-session revocation. Three browsers verify
SSE-driven running state, targeted retry, partial exports and saved leads. Normal
V2 data is not migrated by the tests. Apply reviewed migrations and complete owner
setup before owner use. Nginx/TLS, retention and mixed-load acceptance remain pending.

## Private Storage Foundation

The user selected upstream-only runtimes on September15. Patched RustFS evaluation
is not authorized; current rc6/SeaweedFS4.47 remain rejected under the unchanged
contract. Storage-dependent owner activation remains blocked.

`PrivateResumeStorage` is a tested S3-compatible adapter, not an enabled upload
feature. It requires an explicitly configured loopback endpoint and private
credentials (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`). Complete
legacy `MINIO_*` configurations remain compatible; partial canonical configuration
and conflicting aliases are rejected rather than mixing endpoints and credentials.
No new dependency, bucket, secret or production configuration
is installed automatically. Keep credentials in ignored owner-only files.

Initialization checks versioning, owner-only ACL grants and absence of a bucket
policy. Configure least-privilege identity policies externally; the runtime never
creates buckets or grants public access. The adapter bounds PDF/DOCX objects to
**5 MiB (5,242,880 bytes)**, validates UUID-scoped keys and SHA-256, uses conditional immutable writes,
checks exact read versions/length/type/checksum, and deletes only a supplied object
version. Operations have a 15-second deadline, cancellation and no automatic retries.
The authenticated repository must supply owner identity; a key prefix is not an
authorization system. MIME allowlisting is not content validation or safe parsing.
This V2 limit intentionally differs from V1's 10 MiB; future V2 API/UI upload
controls must share the 5 MiB bound, not copy the legacy limit.

Tests use synthetic HTTP responses and an isolated LocalStack S3 bucket. They
cover private/versioned readiness, tampering, ownership-key separation, duplicate
writes (including an eight-writer race with exactly one version), cancellation and
deletion. They do **not** validate a production runtime, malicious-file
parsing, durable orphan recovery, retention or database/object restoration.

On September 15, 2026, the [upstream MinIO repository](https://github.com/minio/minio)
was verified as archived and explicitly unmaintained; it describes source-only
distribution. The attempted versioned Docker Hub image pull was denied. Do not
work around this with an unreviewed mirror or assume old images receive security
updates. A maintained S3-compatible implementation or explicitly accepted
source-maintenance plan must be selected and tested before enabling uploads.
AIStor licensing/account requirements are not implicitly accepted. Durable parsing,
review and matching integration remain pending.

The required abstraction is private S3-compatible storage, not MinIO. Local ARM64
candidate evaluation found two blockers: SeaweedFS 4.47 passes the object lifecycle
and anonymous/wrong-secret denial but rejects empty-bucket deletion with
nonempty-bucket deletion disabled; RustFS
1.0.0-rc.6 omits the ACL grantee ID and fails private readiness. Neither is accepted.
Pinned digests and selection requirements are in [ARCHITECTURE.md](ARCHITECTURE.md#storage-acceptance-blocker-2026-09-15).
Do not weaken either guard to make a candidate pass. Persistence/restart and isolated
version-preserving backup/restore remain unverified for both candidates.

The existing integration test can target a disposable local candidate using
`S3_CONTRACT_ENDPOINT`, `S3_CONTRACT_ACCESS_KEY` and `S3_CONTRACT_SECRET_KEY`.
Provide all three through the local environment; do not use owner credentials or
an owner bucket. It creates and deletes its own unique synthetic bucket, briefly
tests a public policy on that bucket, and additionally checks anonymous/wrong-secret
denial for real candidates. Without a candidate endpoint it uses `LOCAL_AWS_ENDPOINT`
for emulator compatibility; emulator execution is not authentication acceptance.
From `v2`, run `node --env-file=.env --import tsx --test packages/core/src/storage.integration.test.ts`.

### Upload Metadata And Outbox

Migration `0005_resume_upload_reservations` adds owner-scoped metadata reservations.
`ResumeUploadRepository.reserve` accepts a trusted owner ID, an idempotency key,
the configured bucket and strictly validated checksum/size/MIME metadata. Concurrent
retries return the same reservation; different metadata or bucket under the same
owner/key returns a conflict. Binary content and filenames are not stored in PostgreSQL.

`queueStoredUpload` locks the owner's reservation and atomically binds an immutable
object version plus one ID-only `resume.parse` command. Same-version retries are
idempotent; a conflicting version is rejected. This is an internal persistence
operation, not object validation: a trusted coordinator must verify the exact stored
object before calling it. No API exposes this operation, and no parser route has
been enabled in the publisher or worker. Queued means durably scheduled, not parsed.

The publisher filters supported command types before its 20-row limit, preventing
unsupported resume backlogs from starving search commands. Tests cover eight-way
reservation/finalization races, cross-owner denial, strict metadata, database
constraints, failures before/after outbox insertion and retry recovery. The full
V2 suite now has 31 passing tests; static/build/format and queue restart/AOF checks
also pass. Browser checks from the previous UI pass were not rerun for this slice.

Migration `0005` was applied only to disposable fresh test databases and rerun for
idempotency, not to the normal owner database. It is additive; rollback means using
the previous application without dropping reservations or outbox data. Populated
upgrade/restore, unattended orphan recovery, retention/deletion,
container resource isolation and owner review remain acceptance gates. Storage configuration
must remain stable for reserved objects; moving endpoints/buckets needs a migration
and restore procedure, not an environment-only switch.

### Internal Upload And Parsing Pipeline

`ResumeUploadCoordinator` now computes SHA-256, length and the container signature
from a copied, bounded body, reserves the owner/idempotency key, checks storage
readiness and verifies the exact stored object before queuing parsing. A PDF/ZIP
signature permits quarantine only; it is not document validation. No filename,
client checksum, MIME claim or client version determines the stored metadata.
The configured bucket comes from the storage adapter, avoiding a second independent
bucket setting. Conflicting retries fail; already queued retries return the durable
record. Caller cancellation and a 45-second storage-operation deadline are propagated.

`recoverVersion` discovers a version with HEAD and verifies it by exact-version
GET and SHA-256. It distinguishes missing objects from other errors. Lost PUT
responses are reconciled without overwriting or deleting existing objects. An
explicit owner-scoped `reconcile` call can finish a reservation left behind by a
database failure without requiring another upload. Missing objects remain pending;
there is no unattended sweeper or destructive orphan cleanup yet.

`resumeParseHandler` validates the durable command and stored owner/version before
reading the object. Parsing runs in a separate child process using the existing
resume extraction/derivation package. The child receives no inherited environment
or credentials, has read access only to code/dependencies, and is denied network,
filesystem writes, native addons and child-process spawning. It fails closed when
the host lacks Node's network permission capability (verified here on Node 26.8.1;
the repository's Node >=24 declaration alone does not prove parser compatibility).
The 30-second deadline kills the child and waits for process closure; one parse is
admitted per worker process. V8 old-space is limited to 192 MiB, **not a total RSS or
OS sandbox guarantee**. Container CPU/RSS/egress acceptance remains required.

DOCX preflight uses `yauzl`: at most 200 entries, 20 MiB expanded data, 100:1
per-entry expansion, consistent streamed sizes, required document parts, and no
encrypted entries, macro projects or embedded objects. PDF preflight bounds pages
to 50. Text is limited to 160,000 characters and IPC output to 1 MiB. The MIT
`@thednp/dommatrix` implementation supplies PDF text extraction's matrix dependency
without native canvas permissions. `jszip` is test-only for synthetic documents.
Parser errors use fixed codes; raw document text and internal diagnostics are not logged.

Migration `0006_amazing_ares` adds owner-scoped `resume_results`. Parsed output or a
fixed rejection code commits in the same transaction as fenced command completion.
Expired/stale fences, altered commands and duplicate completions cannot replace a
result. Invalid documents are durably handled; exhausted infrastructure retries use
`processing_failed`. The queue consumer accepts an explicit resume failure callback
instead of invoking search completion. Real local SQS delivery/duplicate/exhaustion
checks and a synthetic DOCX upload-to-result test pass, as do rollback, cross-owner,
lost-response, corruption, cancellation, macro/archive and PDF page-limit checks.

**This is internal implementation, not an enabled owner upload feature.** Migration
0006 ran only on disposable databases (fresh and repeat migration), not the normal
V2 database. No persistent files-worker process, publisher route, upload API/UI or
review action is enabled. Parsed facts do not modify the candidate profile or
matching snapshot. Maintained storage acceptance and restore, worker deployment,
owner approval, retention/deletion and the remaining workflows still block release.

## Saved Leads Workflow

Save a job from a completed search to retain its normalized snapshot independently
of search navigation. Saved Leads supports notes (up to 10,000 characters),
archive/restore, source links, matching evidence and paginated revision history.
It does not submit applications or accept an Applied status. Archived leads are
not deleted, and saving a duplicate does not restore them or overwrite notes,
status or the original snapshot. Snapshot refresh is not implemented.

The API exposes `POST /api/leads` with `{ jobId }`, `GET /api/leads` with optional
`status=saved|archived`, `limit=1..50` and UUID `before`, `GET /api/leads/:id`,
`PUT /api/leads/:id` with `{ revision, notes, status }`, and
`GET /api/leads/:id/history` with optional revision `before`. Lists default to 25
records and return `nextCursor`; cursors use immutable creation order, including
timestamp ties. History pages contain at most 25 revisions, newest first.
All routes enforce owner access and no-store; writes additionally enforce
origin/CSRF and 60 updates per minute. Repeated saves are idempotent by owner/job
fingerprint. Stale updates return 409 and retain the user's unsaved notes.

Migration `0004` adds `saved_leads` and `lead_history` without changing existing
records. Save/update and their audit row commit together. Composite ownership
constraints reject cross-owner history references. Audit records capture status
and whether notes changed, not historical copies of private notes. The generated
migration creates the owner/id unique index before its dependent foreign key.
It was tested on fresh databases and applied to the local v2 database; no v1 data
was imported. Roll back application code without dropping these additive tables
or discarding saved data. Versioned destructive rollback is not provided.

Browser acceptance covers save failure/retry, note persistence after reload,
unsaved-navigation confirmation, stale-edit recovery, archive confirmation,
restore and 320/390/1440px layouts in Chromium, Firefox and WebKit.

Profile edits now also block accidental header navigation/sign-out and register
an unload warning until saved or explicitly discarded. Failed sign-out retains
dirty-state protection. The workspace has a keyboard skip link with hidden/focused
rendering assertions. Browser checks exercise dismissed navigation, retained input,
and unload-handler removal after saving. Browser unload prompts remain subject to
platform policy and cannot guarantee preservation after a crash or forced close.

## Local Inference Benchmark

The local-only client and synthetic benchmark harness are implemented, but are
not connected to API/search execution. The dedicated durable AI worker is still
pending. The client requires an explicit 9B/4B model, fixes context at 4096 tokens,
bounds input/output, rejects redirects, validates JSON results and admits one
request per process. `keep_alive: 0` requests unloading after each call. A single
worker deployment and Ollama's own limits are still required across processes.

After explicit model-download approval, start native Ollama in its own terminal:

```sh
OLLAMA_NO_CLOUD=1 OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MAX_LOADED_MODELS=1 OLLAMA_NUM_PARALLEL=1 OLLAMA_CONTEXT_LENGTH=4096 ollama serve
```

With an already installed model, run from the repository root:

```sh
OLLAMA_MODEL=qwen3.5:4b npm --prefix v2 run benchmark:llm
OLLAMA_MODEL=qwen3.5:9b npm --prefix v2 run benchmark:llm
```

The command does not pull models, load private environment files, use owner data,
or activate AI. It checks explicit skills, absent facts and injected instructions;
reports per-fixture latency/tokens per second; stops on runtime failure; and exits
nonzero when checks fail. This cold-load smoke harness is not a warm p95, ranking
quality, license or mixed-workload acceptance gate. Host suspension can delay timer
delivery; late responses are rejected, but this is not a hard real-time deadline.

Observed native trial: Ollama 0.33.3 detected Apple M1 Pro Metal; authorized 4B
download completed (3.4 GB, manifest prefix `2a654d98e6fb`). The 9B download timed
out and is incomplete. The 4B runner failed to load for all three initial fixtures;
no valid output or throughput measurement was obtained. Wall-clock durations were
approximately 1032/1041/943 seconds despite a 300-second configured timeout, so
they are invalid performance samples. Host swap was about 9.1 GB at inspection;
the cause of the scheduling/load delays is not established. The benchmark server
was stopped, downloaded files preserved, and neither model approved for activation.
Resolve load failures and host resource/suspend conditions before retrying 9B.

Follow-up on 2026-09-14: native Ollama 0.34.0 with Metal and cloud disabled passed
all three 4B fixtures in 7.20/3.96/4.70 seconds at approximately 32/41/32 output
tokens per second. The Mac had no swap in use before the run; after concurrent
build/test workloads it had about 2.1 GB in use. This is a successful synthetic
smoke check, not sustained-memory or ranking-quality acceptance. The 9B download
was not resumed, neither model was activated, and the benchmark server was stopped.

## Local Setup

Requirements: Node >=24, npm, Docker, and the root repository dependencies.
No new Node installation is required on the current host. Use `npm --prefix v2`
from the repository root to avoid host directory-switch runtime-manager hooks.

```sh
npm ci
npm --prefix v2 ci --ignore-scripts
npm --prefix v2 run build:domain
npm --prefix v2 run setup:local
npm --prefix v2 run services
npm --prefix v2 run build
npm --prefix v2 run db:migrate
npm --prefix v2 run setup:owner
```

`setup:local` refuses to overwrite its private, mode-0600 environment file. On an
already configured checkout, skip it. `setup:owner` must be run in your own
interactive terminal: all input is hidden and an existing owner is never replaced.
Do not paste credentials into chat, command arguments or environment files.
Dependency scripts remain disabled; review any package-specific requirement before
approving lifecycle scripts on another host.

After schema and owner setup, start the four application processes together:

```sh
npm --prefix v2 start
```

The supervisor stops siblings if any process exits. It does not restart failed
processes or keep the app running after closing its terminal or sleeping the Mac.
It does not start Docker, run migrations, create an owner or enable inference.
Alternatively, for diagnostics, start these in separate terminals:

```sh
npm --prefix v2 run start:api
npm --prefix v2 run start:publisher
npm --prefix v2 run start:worker
npm --prefix v2 run start:web
```

Open **http://localhost:5280**. Use that hostname consistently because the
configured origin check is exact. All services bind only to loopback:

| Service           | Port  | Persistence                     |
| ----------------- | ----- | ------------------------------- |
| Next.js           | 5280  | No private browser storage      |
| Fastify           | 5390  | PostgreSQL                      |
| PostgreSQL        | 55433 | `careerscope-v2_postgres-data`  |
| Redis             | 56479 | Disposable throttle state       |
| LocalStack SQS/S3 | 54566 | Disposable local emulator state |

The S3 service is available in the emulator, but **resume/object workflows are not
implemented**. No real AWS credentials are used. Local endpoint validation rejects
non-loopback hosts. Nothing here provisions AWS, publishes Pages or migrates v1 data.

## Optional BullMQ Transport

Start the separate queue service without restarting other services:

```sh
npm --prefix v2 run services:queue
```

Queue Redis binds to loopback port 56480 and persists in
`careerscope-v2_queue-data`. The existing throttle Redis on 56479 is disposable
and must not host BullMQ. Adapter initialization rejects Redis without AOF and
noeviction. Producer commands have finite timeouts; workers reconnect with capped
delay and retain database fencing as the completion authority.

After database/owner setup and a deliberate transport cutover, use these settings
in **both** publisher and worker terminals before their existing start commands:

```sh
export QUEUE_TRANSPORT=bullmq
export QUEUE_REDIS_URL=redis://127.0.0.1:56480
```

No private environment file is changed automatically. Stop old SQS publishers and
consumers, quiesce submissions and reconcile outstanding commands before switching.
Do not run both transports against the same workload. Existing LocalStack settings
are still required by the shared configuration while compatibility is retained.
No owner-data cutover or rollback rehearsal has been performed. The isolated
`test:queue-runtime` check verifies real publisher/worker lifecycle, graceful Redis
restart, offline AOF restoration into a fresh volume, duplicate acknowledgement
and bounded unavailable-Redis startup. Prolonged outage/soak, sudden power-loss
and PostgreSQL/object disaster recovery remain unverified.
Cancellation tests cover queued/claimed runs, completion races, duplicate events,
both transport redeliveries and the authenticated API. Browser checks cover cancel
confirmation dismissal, request failure/retry, persisted cancellation and mobile UI.

## Verification

```sh
npm --prefix v2 run services:queue
npm --prefix v2 run typecheck
npm --prefix v2 run lint
npm --prefix v2 test
npm --prefix v2 run test:queue-runtime
npm --prefix v2 run build
npm --prefix v2 run format:check
```

Integration checks require the v2 local services including queue Redis and create unique synthetic
databases/queues/Redis keys. They never connect to the owner's v1 database.
Queue-runtime additionally requires Docker and redis:7.4.5-alpine already present;
it cleans only its uniquely named temporary containers, volumes and database.
`test:unit` runs command, profile and matching/provider fixtures without local services.

For `test:ui`, start the built v2 web server on 5280 and leave API port 5390 free.
The test starts its own real API with a temporary database and verifies Chromium,
Firefox and WebKit at 320, 390 and 1440 pixels. It checks authentication, result
rendering and score ordering, matching evidence, profile persistence and revision
conflicts, filtering, asynchronous submission, cancellation and logout. Restart the preview after
rebuilding so it serves the current asset manifest. The check does not call live
providers or exercise real application submission. Screenshots are ignored.

## Source Layout

```text
v2/
  apps/api/src/                 Fastify boundary and API process
  apps/web/src/app/             Next.js private search workspace
  apps/workers/search/src/      Provider handler, consumer and publisher processes
  packages/core/src/            Contracts, auth, repositories, queue and runtime
  migrations/                  Generated SQL and Drizzle metadata
  scripts/                     Local bootstrap, migration and UI checks
  compose.yml                  Isolated local PostgreSQL, Redis and LocalStack
  ARCHITECTURE.md               Ownership, failure semantics and migration status
```

The search worker deliberately imports the existing provider and matching packages'
built entry points; profile and score contracts reuse the shared schemas.
This monorepo bridge prevents duplicate domain implementations;
it requires root dependencies and `build:domain` on a fresh checkout. The API and
core do not import the v1 API or its SQLite repositories.
