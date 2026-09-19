# CareerScope — Engineerin| Database | 65% | IN PROGRESS | 13 tables, 13 migrations, 18 checks; no recovery run recorded, n| Security | 72% | IN PROGRESS | All ten areas implemented; never reviewed until 2026-09-19, live origin un| Performance | 30% | IN PROGRESS | Live health 91-196ms measured; no workload, database, queue or browser measurement |

> **Re-baselined 2026-09-19.** The previous figures carried no evidence and
> seven areas claimed VERIFIED without any. Several numbers went **down**; none
> of the work regressed. A percentage now requires evidence, VERIFIED requires
> evidence, and an area with nothing behind it reports UNMEASURED and no number.
> Enforced by `scripts/check-progress.mjs`.

**Last Updated:** 2026-09-18
**Current Task:** none — awaiting the first task through the multi-agent workflow
**Current Phase:** RECON
**Overall Status:** IN PROGRESS — deployed and working; product surface incomplete

**Repository:** `main` @ `3bee7b2` · **Deployed:** `3bee7b2` (provenance 4/4) ·
**Live:** `https://careerscope.tech` → `{"status":"ok","version":"3.0.0"}`

---

## How these percentages are calculated

Verified scope divided by scope required for the product objective. Not
confidence, not effort spent, not how recently something was worked on.

An area only moves up when there is evidence — a passing command, a live
response, a reviewed diff. Code existing moves nothing on its own.

**The frontend and UX figures are low on purpose.** The backend is mature and
the product surface is one page; averaging that away would hide the single most
important fact about this repository.

---

## Overall Progress

| Area           | Progress | Status      | Evidence                                                                      |
| -------------- | -------- | ----------- | ----------------------------------------------------------------------------- |
| Product        | 25%      | IN PROGRESS | Deployed loop works; the core user journey CS-16..CS-19 is not built          |
| Frontend       | 20%      | IN PROGRESS | Builds clean; no shared loading/empty/error states, phone layout unusable     |
| Backend        | 70%      | IN PROGRESS | root 1047/1047, v2 unit 33/33; six integration files run nowhere (CS-9)       |
| Database       | 65%      | IN PROGRESS | 13 tables, 13 migrations, 18 checks; no recovery run, no scheduled dump       |
| Infrastructure | 65%      | IN PROGRESS | Live at 3.0.0; firewall not attached, no proxy self-healing (CS-3)            |
| Security       | 72%      | IN PROGRESS | Ten areas implemented; first review 2026-09-19, live origin untested          |
| Performance    | 30%      | IN PROGRESS | Live health 91-196ms; no workload, database, queue or browser figure          |
| Testing        | 55%      | IN PROGRESS | Unit and gate suites proven; no database, queue or browser coverage in CI     |
| System Design  | 75%      | IN PROGRESS | Documented; no independent review this cycle, CS-6 open                       |
| UX/UI          | 15%      | IN PROGRESS | No design pass on the public surface, no accessibility baseline ever measured |
| Documentation  | 70%      | IN PROGRESS | Extensive and current; drift demonstrated on 2026-09-19, not hypothetical     |
| Code Quality   | 70%      | IN PROGRESS | lint/format/typecheck green; one reviewed file yielded three findings         |

**Overall: ~65%.** Dominated by the frontend and UX gap, not by backend debt.

---

## Frontend

| Item              | Status      | Evidence                                             |
| ----------------- | ----------- | ---------------------------------------------------- |
| Application shell | NOT STARTED | No shared layout beyond `layout.tsx`                 |
| Routing           | NOT STARTED | **One** `page.tsx`; `view` state simulates pages     |
| Layouts           | NOT STARTED |                                                      |
| Design system     | NOT STARTED | No tokens, no primitives, ad-hoc styling             |
| Components        | IMPLEMENTED | 7 components, functional                             |
| Pages             | NOT STARTED | No `/login`, `/leads`, `/profile` routes             |
| Forms             | IMPLEMENTED | Profile and account forms work                       |
| State management  | IMPLEMENTED | Local state lifted into `page.tsx`; no store         |
| API integration   | VERIFIED    | `lib/api.ts`, CSRF + revisions handled               |
| Authentication UI | IMPLEMENTED | `account-form.tsx`; no dedicated route               |
| Job search        | IMPLEMENTED | Search + SSE progress                                |
| Job details       | IMPLEMENTED | `match-evidence.tsx`                                 |
| Profiles          | IMPLEMENTED | `profile-editor.tsx` with revision conflicts         |
| Dashboards        | NOT STARTED |                                                      |
| Responsive design | IN PROGRESS | Verified 320/390/1440 on what exists                 |
| Accessibility     | VERIFIED    | axe clean WCAG 2.0/2.1 A+AA, 3 browsers              |
| Loading states    | IN PROGRESS | Present in some surfaces, not systematic             |
| Empty states      | IN PROGRESS | Ad-hoc; no shared empty-state treatment              |
| Error states      | IN PROGRESS | 409/507 handled; not consistent everywhere           |
| Performance       | IN PROGRESS | Live health measured; no bundle or render figure yet |
| Tests             | IN PROGRESS | Browser + axe checks; no component tests             |

**Blocked, not merely unbuilt:** `/companies`, `/market`, `/skills`, `/alerts`
and public `/jobs` have **no backing data**. `CollectedJob` carries 11 fields —
no salary, tech stack, employment type or remote flag. Building them would mean
inventing data.

## Backend

| Item             | Status      | Evidence                                               |
| ---------------- | ----------- | ------------------------------------------------------ |
| API architecture | VERIFIED    | Single `app.ts`, global hook chain                     |
| Routes           | VERIFIED    | 26 routes on `main`                                    |
| Controllers      | VERIFIED    | No separate controller layer by design; handlers thin  |
| Services         | VERIFIED    | Domain logic in `packages/core`, not in handlers       |
| Repositories     | VERIFIED    | `MarketRepository` and peers own all SQL               |
| Validation       | VERIFIED    | Zod at every boundary                                  |
| Authentication   | COMPLETE    | Argon2id, opaque sessions, revocation                  |
| Authorization    | COMPLETE    | Session-derived `ownerId` + composite FKs              |
| Database         | IN PROGRESS | PostgreSQL 17, Drizzle, 13 migrations; recovery unrun  |
| Transactions     | VERIFIED    | Outbox written in the business transaction             |
| Queues           | VERIFIED    | SQS default; BullMQ search-only, legacy names rejected |
| Workers          | VERIFIED    | publisher, search, files                               |
| Outbox           | COMPLETE    | Fencing, leases, DLQ reconciliation, crash matrix 4/4  |
| Retries          | VERIFIED    | Bounded attempts, backoff, DLQ on exhaustion           |
| Idempotency      | VERIFIED    | Unique index enforced, not read-then-write             |
| Error handling   | VERIFIED    | Stable codes, sanitized messages, `requestId`          |
| Logging          | VERIFIED    | Redacted; route templates only, never URLs or bodies   |
| Observability    | IN PROGRESS | Correlation chain complete; no dashboard               |
| Tests            | VERIFIED    | 49/49                                                  |
| Performance      | IN PROGRESS | Earlier figure; no run recorded in the evidence trail  |
| Security         | IN PROGRESS | Reviewed 2026-09-19; live origin not observed          |

**Not implemented:** transactional email (no provider), admin endpoints (exist
on `feature/frontend-pages-admin-console`, not deployed), company/market/skills
domain.

## Infrastructure

| Item                    | Status      | Evidence                                                |
| ----------------------- | ----------- | ------------------------------------------------------- |
| Docker / Compose        | VERIFIED    | 9 containers, hardened, read-only, cap-drop             |
| Networking              | VERIFIED    | All services loopback in proxy namespace                |
| Ports                   | VERIFIED    | Only the proxy publishes 80/443                         |
| Environment config      | VERIFIED    | `.env.example`; real `.env` host-only                   |
| Secrets handling        | VERIFIED    | `gh secret set` from file; none committed               |
| Service startup         | VERIFIED    | Dependency ordering; `--wait` blocks on unhealthy       |
| Health checks           | VERIFIED    | Compose `--wait` gates deploys                          |
| Logging                 | VERIFIED    | json-file, 10m × 5                                      |
| Persistent storage      | VERIFIED    | 6 volumes; certificates survive restart                 |
| Database                | IN PROGRESS | Volume-backed; recovery not re-run this cycle           |
| Cache                   | NOT STARTED | Redis deployed for BullMQ only; no cache layer          |
| Queue                   | VERIFIED    | SQS in production, LocalStack locally                   |
| Reverse proxy           | VERIFIED    | Caddy, TLS to 17 Dec 2026, no cert churn                |
| Development environment | VERIFIED    | `run.mjs` launcher; port 5435 avoids reserved range     |
| CI/CD                   | VERIFIED    | 3 consecutive green auto-deploys                        |
| Recovery                | IN PROGRESS | `restart-stack.sh` works; **no automatic self-healing** |
| Production environment  | VERIFIED    | Provenance 4/4                                          |

**Open:** Hostinger managed firewall configured in hPanel but **not attached**.
Off-host backup **SKIPPED — owner decision**.

## System Design

| Item                      | Status      | Evidence                                          |
| ------------------------- | ----------- | ------------------------------------------------- |
| Architecture              | VERIFIED    | Documented with Mermaid diagrams                  |
| Component boundaries      | VERIFIED    | Workspace ownership enforced by project refs      |
| Frontend/backend boundary | VERIFIED    | Typed client, CSRF + Origin, no shared runtime    |
| API design                | VERIFIED    | 26 routes, stable codes, revision conflicts       |
| Database architecture     | VERIFIED    | Composite owner FKs, 13 migrations                |
| Asynchronous architecture | VERIFIED    | Transactional outbox, fenced execution            |
| Queue architecture        | VERIFIED    | SQS default; BullMQ search-only                   |
| Data flows                | VERIFIED    | Discovery → normalize → dedupe → score → pipeline |
| Failure modes             | VERIFIED    | Crash matrix 4/4, full-disk, database recovery    |
| Scaling                   | IN PROGRESS | Single 2 vCPU host; namespace design prevents it  |
| Caching                   | NOT STARTED | No cache layer anywhere in the stack              |
| Security boundaries       | VERIFIED    | Owner isolation, session-derived identity         |
| Observability             | IN PROGRESS | Correlation chain complete; no dashboard          |
| Disaster / recovery       | IN PROGRESS | Restore verified; off-host backup skipped         |

**One open defect:** restarting the proxy alone strands every other container
behind a 502 while they still report healthy. Operational recovery exists;
automatic self-healing does not.

## UX/UI

| Item                     | Status      | Evidence                                    |
| ------------------------ | ----------- | ------------------------------------------- |
| Information architecture | NOT STARTED | No IA; one route                            |
| Navigation               | NOT STARTED | `view` state, not navigation                |
| Visual hierarchy         | IN PROGRESS | Readable, not designed                      |
| Design system            | NOT STARTED | No tokens or primitives                     |
| Typography               | IN PROGRESS | Defaults, no scale                          |
| Spacing                  | IN PROGRESS | Ad-hoc, no rhythm                           |
| Responsiveness           | IN PROGRESS | Works at tested widths on existing surfaces |
| Mobile                   | IN PROGRESS | Verified 320/390; not designed for          |
| Desktop                  | IN PROGRESS | Verified 1440; no large-screen layout       |
| Accessibility            | VERIFIED    | axe clean, 3 browsers, 3 widths             |
| Forms                    | IMPLEMENTED | Profile and account forms work              |
| Interactions             | IN PROGRESS | Basic; no considered interaction model      |
| Loading                  | IN PROGRESS | Present in some surfaces                    |
| Empty states             | IN PROGRESS | Ad-hoc                                      |
| Errors                   | IN PROGRESS | Handled, not consistent                     |
| Success states           | IN PROGRESS | Inconsistent confirmation                   |
| Animations               | NOT STARTED | None                                        |
| Usability                | NOT STARTED | No usability testing performed              |
| Consistency              | IN PROGRESS | Single page, so little chance to diverge    |

**This is the weakest area and the highest-value next work.**

---

## IMPLEMENTED vs VERIFIED vs COMPLETE

- **IMPLEMENTED** — the code exists.
- **VERIFIED** — it was actually tested or reviewed, with evidence.
- **COMPLETE** — it satisfies requirements _and_ passes every applicable gate.

Nothing is marked COMPLETE because code exists. Example:

```
Authentication:  IMPLEMENTED yes · VERIFIED yes · SECURITY PASS · TESTS PASS
                 DOCS PASS  →  COMPLETE
```

---

## Open items

| Item                       | Status                                                     |
| -------------------------- | ---------------------------------------------------------- |
| Transactional email        | OPEN — EXTERNAL (no provider; no password recovery exists) |
| Screen-reader smoke test   | OPEN — HUMAN VALIDATION                                    |
| Off-host backup            | SKIPPED — OWNER DECISION                                   |
| Hostinger managed firewall | OPEN — not attached                                        |
| Proxy self-healing         | KNOWN LIMITATION                                           |
| Admin feature deployment   | ON BRANCH — not deployed, `is_admin` false for all         |
| Trivy version discrepancy  | OPEN — UNEXPLAINED                                         |
| AI / auto-apply / Naukri   | DEFERRED — INTENTIONAL                                     |

---

## Regression policy

If a change breaks something previously marked COMPLETE, the percentage **goes
down** in the same cycle, with the reason recorded. This file represents reality,
not desired progress. A number that only ever rises is a number nobody can use.
