# CareerScope — Engineerin| Database | 65% | IN PROGRESS | 13 tables, 15 migrations, 18 checks; no recovery run recorded, n| Security | 66% | IN PROGRESS | DOWN from 72; census found 5 untracked issues, required scope grew, no control weakened un| Performance | 30% | IN PROGRESS | Live health 91-196ms measured; no workload, database, queue or browser measurement |

> **Re-baselined 2026-09-19.** The previous figures carried no evidence and
> seven areas claimed VERIFIED without any. Several numbers went **down**; none
> of the work regressed. A percentage now requires evidence, VERIFIED requires
> evidence, and an area with nothing behind it reports UNMEASURED and no number.
> Enforced by `scripts/check-progress.mjs`.

**Last Updated:** 2026-09-23 (this session's ticket work, appended after the 2026-09-19 reconciliation below)
**Current Task:** 44-ticket product backlog — CS-6/13/14/16/17/18/19/50 shipped to UAT this cycle
**Current Phase:** IN PROGRESS. The separate "Autonomous Engineering OS
continuation" objective referenced below remains its own, unrelated BLOCKED
record (implementation 3/3, code review 3/3 exhausted) - see review.txt's
2026-09-21 entry for why that counter is not touched by ticket work.
**Overall Status:** IN PROGRESS — deployed and working; product surface incomplete

Today's real evidence (2026-09-23), attributed to actual dispatches, not
narration: a real CareerScope Independent Reviewer found and this session fixed
a P1 (lead-status dropdown ignoring scope) and a P2 (inconsistent 401 handling,
now centralized); a real CareerScope QA run found and this session fixed
format:check failures and confirmed 1054/1055 root tests passing; a real
CareerScope Visual Designer (gpt-6-astra) produced the design spec now
implemented in the Saved/Applications lead-detail view. A CSS overflow
regression that redesign introduced (27px horizontal scroll at 320px) was
root-caused via live element-by-element bisection and fixed. Full detail in
review.txt's 2026-09-23 entry.

The paragraph below is the preserved 2026-09-19 reconciliation record for the
separate, exhausted engineering-framework objective; it is not this cycle's work.

Current local workflow evidence, attributed to actual parent-native specialist
invocations: Senior Engineer completed three attempts; final independent QA
passed 20/20 runner tests and 209/209 across four suites under pinned Node
26.8.1, with no fail/skip/cancel/todo, plus ESLint/Prettier on eight files.
Independent Reviewer loop 3 APPROVED; IR01-IR03 are closed with no blocking
code findings. Documentation completed two passes, ending with two documents,
Prettier and 15 retained links/anchor passing; no source changed after final QA.
The earlier nested-tool limitation is not a session-wide blocker. This final
coordinator call reconciles records only; it did not invoke those specialists.

Overall completion remains BLOCKED by exhausted bounds and incomplete canonical
evidence/gates. Actual SessionStart, Agent Sessions UI/model selection, host
provenance and final audit remain unverified. Historical baseline is unchanged
and invalid for strict schema-2 contracts. No app checks or production readiness
claim; no fabricated percentage increase or schema migration.
See [execution state](engineering.json) and [review log](../review.txt).
The percentages in the table below are this cycle's (2026-09-23), synced with
`.ai/progress.json` and re-verified by `scripts/check-progress.mjs`. The
repository/deployment snapshot line is still the 2026-09-19 one below and has
not been re-checked from this Windows session.

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

| Area           | Progress | Status      | Evidence                                                                                                                                            |
| -------------- | -------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product        | 55%      | IN PROGRESS | CS-6/13/14/16/17/18/19/50 shipped to UAT with real evidence; CS-15/CS-11 and public-surface work remain open                                        |
| Frontend       | 48%      | IN PROGRESS | Real routing (CS-6), all 6 lead statuses (CS-14), real /applications route (CS-50), redesigned lead-detail view; check-ui.ts E2E suite still broken |
| Backend        | 70%      | IN PROGRESS | root 1047/1047, v2 unit 33/33; six integration files run nowhere (CS-9)                                                                             |
| Database       | 65%      | IN PROGRESS | 13 tables, 13 migrations, 18 checks; no recovery run, no scheduled dump                                                                             |
| Infrastructure | 65%      | IN PROGRESS | Live at 3.0.0; firewall not attached, no proxy self-healing (CS-3)                                                                                  |
| Security       | 66%      | IN PROGRESS | DOWN from 72: no control weakened; a census found 5 untracked issues (CS-53..CS-57), enlarging required scope                                       |
| Performance    | 30%      | IN PROGRESS | Live health 91-196ms; no workload, database, queue or browser figure                                                                                |
| Testing        | 58%      | IN PROGRESS | check-ui repaired + wired + WCAG 2.2; integration now in CI. Only +3: four checks-that-cannot-fail found, 11 still unwired                          |
| System Design  | 78%      | IN PROGRESS | Documented; CS-6's route-per-page architecture now real, not just diagrammed                                                                        |
| UX/UI          | 39%      | IN PROGRESS | Real design pass + accessibility baseline on Dashboard/Jobs/Saved/lead-detail; rest of the app untouched                                            |
| Documentation  | 71%      | IN PROGRESS | Extensive and current; drift demonstrated on 2026-09-19, not hypothetical                                                                           |
| Code Quality   | 70%      | IN PROGRESS | lint/format/typecheck green; one reviewed file yielded three findings                                                                               |

**Overall: ~68%.** Dominated by the frontend and UX gap, not by backend debt.

---

## Frontend

| Item              | Status      | Evidence                                                                                                           |
| ----------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Application shell | IMPLEMENTED | `AuthenticatedShell` wraps every real route (CS-6)                                                                 |
| Routing           | IMPLEMENTED | 9 real Next.js routes under `app/(app)/` (CS-6), replacing the single `view`-state `page.tsx`                      |
| Layouts           | IMPLEMENTED | Shared shell layout; per-route content                                                                             |
| Design system     | IN PROGRESS | `--dash-*` CSS custom-property tokens exist (spacing, status colors, focus); not yet applied everywhere            |
| Components        | IMPLEMENTED | 7+ components, functional; `SavedLeads` now serves both `/saved` and `/applications` via a `scope` prop            |
| Pages             | IMPLEMENTED | `/`, `/dashboard`, `/jobs`, `/saved`, `/applications`, `/resume`, `/settings`, `/career-resources`, `/preparation` |
| Forms             | IMPLEMENTED | Profile and account forms work                                                                                     |
| State management  | IMPLEMENTED | Local state per route; no global store, not yet needed                                                             |
| API integration   | VERIFIED    | `lib/api.ts`, CSRF + revisions handled; centralized `SESSION_EXPIRED_EVENT` for 401s                               |
| Authentication UI | IMPLEMENTED | `account-form.tsx`; no dedicated route                                                                             |
| Job search        | IMPLEMENTED | Search + SSE progress                                                                                              |
| Job details       | IMPLEMENTED | `match-evidence.tsx`; redesigned lead-detail view with real Job Details/Timeline/Actions grid                      |
| Profiles          | IMPLEMENTED | `profile-editor.tsx` with revision conflicts                                                                       |
| Dashboards        | IMPLEMENTED | `/dashboard` route real; visual parity with owner reference still only 66.32% (CS-11 open)                         |
| Responsive design | IN PROGRESS | Verified 320/390/1440 on what exists                                                                               |
| Accessibility     | VERIFIED    | axe clean WCAG 2.0/2.1 A+AA, 3 browsers                                                                            |
| Loading states    | IN PROGRESS | Present in some surfaces, not systematic                                                                           |
| Empty states      | IN PROGRESS | Ad-hoc; no shared empty-state treatment                                                                            |
| Error states      | IN PROGRESS | 409/507 handled; not consistent everywhere                                                                         |
| Performance       | IN PROGRESS | Live health measured; no bundle or render figure yet                                                               |
| Tests             | IN PROGRESS | Browser + axe checks; no component tests                                                                           |

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

| Item                     | Status      | Evidence                                                                                                                          |
| ------------------------ | ----------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Information architecture | IN PROGRESS | Real nav with 9 routes (CS-6); no IA review beyond what's built                                                                   |
| Navigation               | IMPLEMENTED | Real sidebar/topbar nav across all routes, not `view` state                                                                       |
| Visual hierarchy         | IN PROGRESS | Designed on Dashboard/Jobs/Saved/lead-detail; default elsewhere                                                                   |
| Design system            | IN PROGRESS | `--dash-*` tokens (spacing, status colors, focus) exist; not applied to every route                                               |
| Typography               | IN PROGRESS | Real `next/font/google` Inter everywhere; no full type scale                                                                      |
| Spacing                  | IN PROGRESS | Token-based spacing scale on redesigned routes; ad-hoc elsewhere                                                                  |
| Responsiveness           | IN PROGRESS | Verified 320/768/1440 with zero overflow on Dashboard/Jobs/Saved/lead-detail                                                      |
| Mobile                   | IN PROGRESS | Verified 320px zero-overflow on redesigned routes (a real 27px regression found and fixed this cycle); not designed for elsewhere |
| Desktop                  | IN PROGRESS | Verified 1440px on redesigned routes; no large-screen layout elsewhere                                                            |
| Accessibility            | VERIFIED    | Lighthouse accessibility 100/100 on /dashboard, /jobs, /saved; axe clean WCAG2A/AA on Dashboard at 320/1440px                     |
| Forms                    | IMPLEMENTED | Profile and account forms work                                                                                                    |
| Interactions             | IN PROGRESS | Basic; no considered interaction model                                                                                            |
| Loading                  | IN PROGRESS | Present in some surfaces                                                                                                          |
| Empty states             | IN PROGRESS | Ad-hoc                                                                                                                            |
| Errors                   | IN PROGRESS | Handled, not consistent                                                                                                           |
| Success states           | IN PROGRESS | Inconsistent confirmation                                                                                                         |
| Animations               | NOT STARTED | None                                                                                                                              |
| Usability                | NOT STARTED | No usability testing performed                                                                                                    |
| Consistency              | IN PROGRESS | Single page, so little chance to diverge                                                                                          |

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
