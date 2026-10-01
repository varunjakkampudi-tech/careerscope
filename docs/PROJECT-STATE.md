# Project State

The authoritative answer to "what is CareerScope, what actually exists, and what
is running right now". Every other document is scoped to one area; this one is
the map. If something here disagrees with another document, this file is wrong
and should be fixed — not worked around.

Last reconciled against repository state: 2026-10-01. Live production was not
changed during this reconciliation.

---

## What CareerScope is

A private, single-owner job-search workspace. It collects postings from public
job sources, scores them deterministically against a candidate profile, and
keeps the ones worth acting on as leads. It does not apply to jobs, and it does
not use AI to decide anything.

---

## Canonical architecture

CareerScope is one product and one root workspace. The production architecture
is Next.js App Router + React, Fastify, PostgreSQL/Drizzle, transactional
outbox, publisher/queue/workers, deterministic matching and encrypted resume
storage. Executable applications live under `apps/`, shared domain libraries
under `packages/`, operational code under `infra/` and `scripts/`, and
authoritative engineering records under `docs/` and `.ai/`.

The completed consolidation is recorded in the historical engineering record
[`SINGLE-CODEBASE-CONSOLIDATION.md`](SINGLE-CODEBASE-CONSOLIDATION.md) and its
original plan is retained under [`archive/`](archive/). Older
release notes may mention historical implementations, but no active build,
runtime, deployment or agent workflow depends on a second application stack.

---

## Branch semantics

Trunk-based. `main` is the integration branch. Nothing deploys automatically:
[deploy.yml](../.github/workflows/deploy.yml) is manual-only and ships the
current `main` HEAD after verifying that exact revision has a green CI run.
[publish-pages.yml](../.github/workflows/publish-pages.yml) separately performs
manual-only GitHub Pages publication with the same exact-revision CI gate.

| Branch                            | Meaning                       | Rule                                                                    |
| --------------------------------- | ----------------------------- | ----------------------------------------------------------------------- |
| `main`                            | integration branch            | Pushes run CI; they never deploy; manual Deploy ships current HEAD only |
| `feat/<ticket>-<slug>`            | one ticket's work             | Short-lived, rebased on `main`                                          |
| `fix/<ticket>-<slug>`             | defect fix                    | Short-lived                                                             |
| `chore/` `docs/` `infra/`         | cleanup, docs, infrastructure | Short-lived                                                             |
| `hotfix/<version>-<slug>`         | production emergency          | Straight to `main`, then tagged                                         |
| `feature/canonical-consolidation` | historical migration baseline | Superseded; `main` is canonical                                         |

Tags are `v<semver>`, applied to the deployed commit **after** the live version
check passes. Commits follow Conventional Commits and name their ticket, for
example `fix(api): reject unknown cursor (CS-2)`.

The release procedure is the `/ship-release` prompt in `.github/prompts`.

---

## What is deployed

Single Hostinger VPS, Ubuntu 24.04, 2 vCPU / 8 GB, behind Caddy, serving
`https://careerscope.tech`.

Nine containers, defined in [compose.production.yml](../infra/compose.production.yml):

| Container    | Role                                                         |
| ------------ | ------------------------------------------------------------ |
| `proxy`      | Caddy. **The only container that publishes ports** (80, 443) |
| `web`        | Next.js server                                               |
| `api`        | Fastify API                                                  |
| `postgres`   | PostgreSQL 17                                                |
| `redis`      | Rate limiting, and the optional BullMQ search transport      |
| `localstack` | SQS                                                          |
| `publisher`  | Drains the transactional outbox onto the queues              |
| `search`     | Runs discovery and matching                                  |
| `files`      | Parses uploaded resumes                                      |

Every service except the proxy uses `network_mode: service:proxy` and binds
loopback. Postgres, Redis, LocalStack and the API therefore have **no reachable
address from any network** — not merely a firewalled one.

The cost of that design is documented in
[KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md#restarting-the-proxy-alone-is-an-outage).

---

## Feature status

Use only these words. Do not invent new ones.

### IMPLEMENTED AND CURRENTLY DEPLOYED

- Email/password authentication, Argon2id, opaque server-side sessions
- CSRF tokens and strict `Origin` checking on every mutating request
- Session revocation, revoke-other-sessions, authenticated password change
- Candidate profile with optimistic-concurrency revisions
- Encrypted resume upload, parse, cancel, delete, with capacity reservation
- Job discovery across five sources with per-source deadlines and failure isolation
- Deterministic matching with a frozen profile snapshot
- Saved leads with notes, archive/reopen, revision history and export
- Career preparation (rules-v1)
- Server-sent events for live search progress
- Transactional outbox, fenced command execution, leases, DLQ reconciliation
- Proxy-level maintenance mode
- Deployment provenance checking

### IMPLEMENTED, NOT DEPLOYED

- Cognito-hosted passwordless sign-in using authorization-code + PKCE. Email
  OTP and verified phone OTP are accepted; the provider access token is
  exchanged server-side and ends in the same opaque CareerScope session cookie.
  Deployment still requires the Cognito environment values, hosted callback
  verification and AWS SMS delivery approval for phone sign-in.

### OPTIONAL

- BullMQ as the **search** queue transport (`SEARCH_QUEUE_TRANSPORT=bullmq`).
  SQS is the default and the only transport the files queue supports.

### DEFERRED — INTENTIONAL

- AI / LLM inference. Off. No external model calls.
- Auto-apply. On hold.
- Cross-process storage reservation. The current architecture is single-writer.

### DEFERRED — LATER RELEASE

- Naukri. If it is ever built, it must be legitimate-access only — never
  cookie or session scraping.

### NOT IMPLEMENTED

- Local-password email verification, forgot-password and password reset. There
  is no local email sender; Cognito-hosted OTP is the supported passwordless
  path when enabled. See [KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md).
- Admin console. See [FRONTEND-ADMIN-ROADMAP](FRONTEND-ADMIN-ROADMAP.md).
- Public job browsing, company pages, market/skills aggregates, saved searches
  and alerts. The data model does not currently support them.
- Public registration. Disabled on the deployed host (`REGISTRATION_ENABLED=false`).

### SKIPPED — OWNER DECISION

- Off-host backup. The owner declined it on cost. Local volumes are **not**
  disaster recovery and must never be described as such.

### OPEN — HUMAN VALIDATION

- Real screen-reader smoke test. Automated axe and accessibility-tree checks
  pass, but they are not a substitute.

---

## Where to go next

The documentation index is [docs/README](README.md). Use the links below for
the scoped contract that answers a specific question.

| Question                               | Document                                            |
| -------------------------------------- | --------------------------------------------------- |
| How is it built?                       | [ARCHITECTURE](ARCHITECTURE.md)                     |
| What endpoints exist?                  | [API-SURFACE](API-SURFACE.md)                       |
| What does the user see?                | [PRODUCT-SURFACE](PRODUCT-SURFACE.md)               |
| How is the frontend put together?      | [FRONTEND-ARCHITECTURE](FRONTEND-ARCHITECTURE.md)   |
| How is it secured?                     | [SECURITY](SECURITY.md)                             |
| How do I deploy?                       | [OPERATIONS/DEPLOYMENT](OPERATIONS/DEPLOYMENT.md)   |
| How do I roll back?                    | [OPERATIONS/ROLLBACK](OPERATIONS/ROLLBACK.md)       |
| What is the server?                    | [OPERATIONS/HOSTINGER](OPERATIONS/HOSTINGER.md)     |
| What is the firewall?                  | [OPERATIONS/FIREWALL](OPERATIONS/FIREWALL.md)       |
| Where do secrets live?                 | [OPERATIONS/SECRETS](OPERATIONS/SECRETS.md)         |
| What do I run to prove a change works? | [TESTING](TESTING.md)                               |
| What is broken or missing?             | [KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md)           |
| What is the next phase?                | [FRONTEND-ADMIN-ROADMAP](FRONTEND-ADMIN-ROADMAP.md) |
