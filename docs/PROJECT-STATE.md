# Project State

The authoritative answer to "what is CareerScope, what actually exists, and what
is running right now". Every other document is scoped to one area; this one is
the map. If something here disagrees with another document, this file is wrong
and should be fixed — not worked around.

Last reconciled against the running system: 2026-09-18.

---

## What CareerScope is

A private, single-owner job-search workspace. It collects postings from public
job sources, scores them deterministically against a candidate profile, and
keeps the ones worth acting on as leads. It does not apply to jobs, and it does
not use AI to decide anything.

---

## The V1 / V2 split

The repository contains two complete stacks. This is deliberate and is the
single most common thing a newcomer gets wrong.

|          | V1                                      | V2                                     |
| -------- | --------------------------------------- | -------------------------------------- |
| Location | repository root (`apps/`, `packages/`)  | `v2/`                                  |
| Package  | `job-radar`                             | `careerscope-v2`                       |
| API      | Fastify + **SQLite**                    | Fastify + **PostgreSQL**               |
| Web      | React + Vite SPA (React Router)         | Next.js App Router                     |
| Tests    | Vitest                                  | `node:test`                            |
| Branch   | `main`                                  | `feature/v2-local-migration`           |
| Status   | **IMPLEMENTED** — last release `v1.3.4` | **IMPLEMENTED AND CURRENTLY DEPLOYED** |

`https://careerscope.tech` runs **V2**. `main` still carries V1 and has not been
promoted. Tag `v1.3.4` marks the V1 release point.

V1 is not dead code: it holds the GitHub Pages publishing pipeline, the mobile
site, the browser-import tooling and the `packages/providers`, `packages/matching`
and `packages/resume` libraries that V2 builds against (`v2 build:domain`).

---

## Branch semantics

| Branch                                 | Meaning                  | Rule                                        |
| -------------------------------------- | ------------------------ | ------------------------------------------- |
| `main`                                 | V1 release line          | Do not move without explicit release intent |
| `feature/v2-local-migration`           | current V2 baseline      | Reviewed platform work lands here           |
| `feature/frontend-pages-admin-console` | next frontend/admin line | Cut from the V2 baseline, never from `main` |

---

## What is deployed

Single Hostinger VPS, Ubuntu 24.04, 2 vCPU / 8 GB, behind Caddy, serving
`https://careerscope.tech`.

Nine containers, defined in [compose.production.yml](../infra/v3/compose.production.yml):

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

- V1 in its entirety, including GitHub Pages publishing and the mobile site

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

- Email verification, forgot-password, password reset. There is no email
  sender. See [KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md).
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

| Question                               | Document                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| How is it built?                       | [ARCHITECTURE](ARCHITECTURE.md) (V1), [v2/ARCHITECTURE](../v2/ARCHITECTURE.md) (V2) |
| What endpoints exist?                  | [API-SURFACE](API-SURFACE.md)                                                       |
| What does the user see?                | [PRODUCT-SURFACE](PRODUCT-SURFACE.md)                                               |
| How is the frontend put together?      | [FRONTEND-ARCHITECTURE](FRONTEND-ARCHITECTURE.md)                                   |
| How is it secured?                     | [SECURITY](SECURITY.md)                                                             |
| How do I deploy?                       | [OPERATIONS/DEPLOYMENT](OPERATIONS/DEPLOYMENT.md)                                   |
| How do I roll back?                    | [OPERATIONS/ROLLBACK](OPERATIONS/ROLLBACK.md)                                       |
| What is the server?                    | [OPERATIONS/HOSTINGER](OPERATIONS/HOSTINGER.md)                                     |
| What is the firewall?                  | [OPERATIONS/FIREWALL](OPERATIONS/FIREWALL.md)                                       |
| Where do secrets live?                 | [OPERATIONS/SECRETS](OPERATIONS/SECRETS.md)                                         |
| What do I run to prove a change works? | [TESTING](TESTING.md)                                                               |
| What is broken or missing?             | [KNOWN-LIMITATIONS](KNOWN-LIMITATIONS.md)                                           |
| What is the next phase?                | [FRONTEND-ADMIN-ROADMAP](FRONTEND-ADMIN-ROADMAP.md)                                 |
