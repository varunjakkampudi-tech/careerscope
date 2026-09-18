# The project

What CareerScope does, how it is built, and how data moves through it.

---

## The problem it solves

One person is looking for work. Job boards are noisy, duplicated across sources,
and optimised for the employer. CareerScope collects postings from several
sources, removes duplicates, scores each against a fixed profile, and tracks the
ones worth pursuing — so the owner reads a short ranked list instead of five
sites.

**One user. No public signup.** Every design decision follows from that.

## Two stacks

|          | V1 (legacy)                  | V2 (current, deployed)   |
| -------- | ---------------------------- | ------------------------ |
| Line     | `main`                       | `main`, `v2/`            |
| API      | Fastify                      | Fastify                  |
| Database | SQLite                       | PostgreSQL 17 + Drizzle  |
| UI       | React + Vite                 | Next.js 16 / React 19    |
| Queue    | in-process                   | SQS (LocalStack locally) |
| Also     | static GitHub Pages artifact | —                        |

V2 at `3.0.0` is what serves https://careerscope.tech. V1 still exists, still
has tests, and still ships the public Pages artifact.

## Features, and their real state

| Feature                                                                 | State                                  |
| ----------------------------------------------------------------------- | -------------------------------------- |
| Job discovery from multiple sources                                     | working                                |
| Fingerprint deduplication                                               | working                                |
| Deterministic matching against a profile snapshot                       | working                                |
| Saved-lead pipeline (saved → applied → interviewing → offer → rejected) | working                                |
| Resume upload, encrypted private storage                                | working                                |
| Market evidence (reposted, long-open, persistent signals)               | working                                |
| Authentication, sessions, owner isolation                               | working, verified                      |
| Admin console                                                           | on a branch, **not deployed**          |
| Password recovery                                                       | **does not exist** — no email provider |
| AI generation                                                           | **off, deliberately**                  |
| Auto-apply                                                              | **on hold, deliberately**              |

## How a search flows

```
owner triggers search
   ↓
source adapters run with per-source deadlines, failures isolated
   ↓
normalise → fingerprint → deduplicate
   ↓
score against the frozen profile snapshot (deterministic, no AI)
   ↓
persist to PostgreSQL          ← authoritative
   ↓
outbox row written in the SAME transaction
   ↓
publisher leases the row, dispatches to the queue (fenced, idempotent)
   ↓
worker executes, result persisted
   ↓
UI streams progress over SSE
```

The load-bearing idea: **PostgreSQL is authoritative, the queue is only
delivery.** The outbox row is written inside the business transaction, so a
crash cannot leave work committed-but-unqueued or queued-but-uncommitted.

## Matching

Deterministic and explainable. Weighted dimensions, hard exclusion gates, and a
ceiling on low-confidence matches. It scores against a **frozen snapshot** of
the profile, so a result can always be explained by the profile as it was when
the search ran — editing the profile does not silently rewrite history.

No model is involved. The same inputs always produce the same score.

## Security model

- Argon2id password hashing; opaque session tokens with revocation
- `ownerId` derived from the session and **re-enforced by composite foreign
  keys**, so a route that forgets to filter still cannot cross owners
- CSRF plus Origin checks; a foreign `Host` gets 421; no public registration
- Resume storage encrypted, single-writer, with cancellation markers that are
  authoritative and never deleted by age
- Logs redacted: no credentials, tokens, resume content, full URLs or bodies

Verified live: unauthenticated `401`, cross-origin `403`, origin-less `403`,
foreign Host `421`, register `404`, bad credentials `401`.

## Deployment

One Hostinger VPS, Ubuntu 24.04, 2 vCPU / 7.8 GiB. Caddy terminates TLS. **Every
service joins the proxy's network namespace, and only the proxy publishes
ports.** That is why restarting the proxy alone strands everything else behind a
502 while healthchecks stay green — a known open defect, mitigated by
`infra/v3/restart-stack.sh` but not yet self-healing.

CI and Deploy both run on push to `main`.

## Repository layout

```
apps/api, apps/web      V1 application
v2/                     V2 application (apps + packages/core)
packages/               shared, matching, providers, resume
infra/v3/               provisioning, deploy, restart, provenance
scripts/                tooling, checks, control center, backup
.github/agents/         16 specialist agents
.ai/                    durable engineering state (JSON canonical)
START-HERE/             this folder
review.txt              append-only engineering audit log
data/                   gitignored: database, resumes, .env, backups
```

## Known limitations, stated plainly

- The frontend is one route; everything user-facing is blocked behind that
- No password recovery, because there is no transactional email provider
- Proxy restart is operator-recovered, not self-healing
- `/companies`, `/market`, `/skills`, `/alerts` have **no backing data model** —
  building them means designing data, not just UI
- Single host; no horizontal scaling story, and the namespace design prevents one

More: [`docs/KNOWN-LIMITATIONS.md`](../docs/KNOWN-LIMITATIONS.md).
