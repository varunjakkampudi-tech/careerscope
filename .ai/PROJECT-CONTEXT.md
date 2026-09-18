# Project context

Stable context for any agent working on CareerScope. Task-specific detail
belongs in `ACTIVE-TASK.md`, not here.

The repository is the source of truth. Where this file and the code disagree,
the code is right and this file is a bug.

## What CareerScope is

A private, single-owner career-intelligence workspace at
`https://careerscope.tech`. It collects postings from public job sources,
scores them deterministically against a candidate profile, and tracks the ones
worth acting on.

It is **not** an auto-apply bot and **not** an AI decision engine. Matching is
fully deterministic and makes no external model calls.

Its wedge is being on the candidate's side: a job board is paid by the employer
and will never tell you a role has been open four months or was quietly
re-posted. CareerScope records that.

## Stack

Two stacks live in this repository, which is the most common source of
confusion.

|          | V1               | V2 — deployed                     |
| -------- | ---------------- | --------------------------------- |
| Location | repository root  | `v2/`                             |
| API      | Fastify + SQLite | Fastify + PostgreSQL 17 + Drizzle |
| Web      | React + Vite SPA | Next.js 16 App Router, React 19   |
| Tests    | Vitest           | `node:test`                       |

Deployed: single Hostinger VPS, Docker Compose, Caddy, PostgreSQL, Redis,
LocalStack SQS, plus publisher/search/files workers. Node >= 24.

V2 commands run through the Windows launcher:
`node data/windows-v2/run.mjs run <script>`.

## Architecture principles

- **PostgreSQL is authoritative.** The queue is delivery, not truth. Durability
  comes from the transactional outbox.
- **Deterministic over clever.** Same inputs, same score, always.
- **Observe, do not infer.** Report what was measured. "Reposted" is a fact;
  "ghost job" is an opinion and is never written.
- **Bounded everything.** Deadlines, retries, page sizes, date ranges.
- Reuse existing validators, repositories and UI primitives before adding new
  ones.

## Constraints that look like ordinary code

Breaking any of these is a P0. Full list in `.github/copilot-instructions.md`.

- `ownerId` always comes from the session, never from a request value. The
  database enforces it independently through composite foreign keys.
- Every mutation requires CSRF **and** an exact `Origin` match.
- Never weaken Argon2id cost, rate limits or security headers to make something
  pass.
- Outbox, fencing, leases and idempotency semantics are load-bearing.
- Resume storage is single-writer; cancellation markers are authoritative and
  are never deleted by age.
- AI off. Auto-apply on hold. Naukri deferred, legitimate access only.
- `main` is the release line and carries V2 as of v3.0.0.

## Known gaps

Stated so no agent plans around imaginary capability:

- The V2 frontend is **one route** with seven components. No route
  architecture, no deep linking, no admin UI.
- `CollectedJob` has 11 fields — no salary, tech stack, employment type or
  remote flag. Pages needing those are blocked on schema work, not UI work.
- No email sender, so no forgot-password or verification flow.
- Restarting the proxy alone strands every other container; use
  `infra/v3/restart-stack.sh`.

More in `docs/KNOWN-LIMITATIONS.md`.
