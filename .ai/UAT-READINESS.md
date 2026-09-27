# UAT readiness — every ticket, its status, and its one unlock

**Generated:** 2026-09-25 (refreshed 03:30) · **Branch:** `main` · **HEAD:** `5239b0a` · **Tickets:** 58
**Working tree:** dirty by design (~189 entries). Working-tree bytes are canonical.

This table answers one question per ticket: _if it is not UAT, what single thing
unlocks it?_

A ticket reaches UAT when its acceptance criteria are met and the evidence
exists, and by no other route. Six tickets were moved **out** of UAT on
2026-09-24 because status had outrun evidence; nothing here reverses that. Where
a ticket cannot honestly reach UAT, the deliverable is the precise reason and
the exact unlock — not a status change.

## Unlock categories

| Code         | Meaning                                                                     |
| ------------ | --------------------------------------------------------------------------- |
| **OWNER**    | Needs an owner decision. No agent can supply it.                            |
| **OPERATOR** | Needs authorized live-host or hPanel access this environment does not have. |
| **COMMIT**   | Needs commit/PR authorization before the evidence can even be generated.    |
| **REVIEW**   | Implemented and evidenced; awaiting an independent verdict. In flight.      |
| **WORK**     | Genuine remaining engineering, with an estimate.                            |

---

## Already UAT (21)

CS-1, CS-2, CS-4, CS-6, CS-7, CS-8, CS-9, CS-12, CS-14, CS-16, CS-17, CS-18,
CS-19, CS-20, CS-21, CS-22, CS-23, CS-28, CS-29, CS-49, CS-50.

No action. Note CS-19 carries a recorded residual (SaveJob mount hydration, see
CS-51) and CS-22 intersects the unresolved CS-46 product decision.

---

## QA — awaiting independent sign-off (12)

These are the largest legitimate conversion available. Two independent
read-only reviewers are running against CS-33/34/35/36 and CS-31/32/38/51.

| Ticket | Unlock                   | Detail                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CS-33  | **REVIEW**               | In flight. Verdict decides UAT.                                                                                                                                                                                                                                                                                                                                                                                 |
| CS-34  | **REVIEW**               | In flight.                                                                                                                                                                                                                                                                                                                                                                                                      |
| CS-35  | **REVIEW**               | In flight.                                                                                                                                                                                                                                                                                                                                                                                                      |
| CS-36  | **REVIEW**               | In flight.                                                                                                                                                                                                                                                                                                                                                                                                      |
| CS-31  | **REVIEW**               | In flight. Its own criterion 3 demands Firefox+WebKit; the repaired `check-ui.ts` now runs green on all three, so the reviewer must rule whether that satisfies it.                                                                                                                                                                                                                                             |
| CS-32  | **REVIEW**               | In flight. Reviewer must rule on whether refreshing 88 WebKit baselines honoured "never approve a snapshot merely to turn the check green". `check-pages-ui.mjs` also runs in no workflow (see CS-52).                                                                                                                                                                                                          |
| CS-38  | **REVIEW**               | In flight.                                                                                                                                                                                                                                                                                                                                                                                                      |
| CS-51  | **REVIEW**               | In flight. Four of five instances fixed; the fifth is deliberately deferred pending a backend lookup.                                                                                                                                                                                                                                                                                                           |
| CS-10  | **REVIEW**               | Not yet dispatched. AC1/AC2 met; AC3 satisfied by justification, not action — the reviewer must accept or reject that reading. D-1/D-2/D-7/D-8 remain **OPERATOR** (diff proposal written, `.ai/OPERATOR-ACTION-orchestrator-agent-file.md`).                                                                                                                                                                   |
| CS-47  | **OPERATOR**             | Test suite now independently verified by me: **69/69, exit 0** (builder had reported 63 — more coverage than claimed, but I record what I measured). Cannot reach UAT on local evidence: no unit is installed on any host, no webhook ever posted. Operator installs the unit, confirms `systemctl` timestamp rendering parses on Ubuntu 24.04, runs the stop-a-timer proof in `docs/OPERATIONS/MONITORING.md`. |
| CS-15  | **COMMIT** → then REVIEW | AC4 is "a check enforces the baseline so it cannot regress silently". The suite is now repaired, hardened and **wired**, but **not CI-executed** — no pipeline has run it. Best reachable state today is _reviewer-approved, pending CI execution_.                                                                                                                                                             |
| CS-48  | **COMMIT** → then REVIEW | Same shape. `ai-provider.test.ts` is **untracked** and must be committed with the `v2/package.json` change or CI fails module-not-found. Until a pipeline runs, the 12-case security matrix is wired but unexecuted.                                                                                                                                                                                            |

---

## IN PROGRESS / READY (5)

| Ticket | Unlock        | Detail                                                                                                                                                                                                                                                                                                                                                  |
| ------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CS-13  | **WORK** (~M) | Shared loading/empty/error states reach 2 modules; the `(app)` group has 8 routes. Roll out to the remaining six preserving the four distinct states, then AC4 (three engines at 320/768/1440) — which the repaired suite can now actually enforce.                                                                                                     |
| CS-39  | **WORK** (~S) | AC1 already satisfied by CS-6. AC2 (preparation grounded in saved profile + rules-v1, distinguishing absent profile / unavailable / retry) and AC3 (resource provenance, safe external links) need systematic verification. Ticket had zero evidence entries before today.                                                                              |
| CS-52  | **WORK** (~L) | Classify all 11 unwired executable checks; prioritise the four covering the failure modes the audit marked NOT VERIFIED (crash recovery, database recovery, queue runtime, soak). Fix the structural cause: CI names scripts, so the `v2 test` glob that would catch anything unnamed is itself never invoked. Also wire V2 tests into the deploy gate. |
| CS-54  | **WORK** (~M) | Verified true by me: `next.config.ts:27` has `script-src 'self' 'unsafe-inline'`. Needs a nonce/hash strategy that works in production App Router. The **API** CSP is strict and unaffected.                                                                                                                                                            |
| CS-57  | **WORK** (~S) | One-line fix plus a missing-cookie test. `app.ts:249` `request.cookies[sessionCookie]!`.                                                                                                                                                                                                                                                                |

---

## DISCOVERY — deliverable is a document, and that is UAT-able (13)

| Ticket | Unlock             | Detail                                                                                                                                                                                                 |
| ------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CS-42  | **WORK** (~L)      | Schema + real contract tests (valid, malformed, foreign-owner, stale-revision). No UI page. Scheduling stays off.                                                                                      |
| CS-43  | **WORK** (~L)      | Depends on CS-42. Semantics + negative-case tests. **No** email or scheduling implementation.                                                                                                          |
| CS-44  | **WORK** (~M)      | Requirements + threat model **only**. No email capability until owner approves sender/domain.                                                                                                          |
| CS-45  | **WORK** (~M)      | Read-only encrypted export following the existing `mobile-site/admin.enc.json` pattern. Remote ticket-**write** is explicitly out of scope.                                                            |
| CS-40  | **WORK** (~M)      | Design doc **only**. No endpoints. No arbitrary SQL/shell/filesystem via web APIs. Implementation needs separate security approval.                                                                    |
| CS-41  | **WORK** (~M)      | Needs architecture + security approval before any schema or collection work.                                                                                                                           |
| CS-53  | **WORK** (~M)      | Composite `(owner_id, run_id)` FKs on `search_jobs`/`run_events`, matching `lead_history`/`resume_results`. Defence-in-depth; no reachable exploit today.                                              |
| CS-55  | **WORK** (~M)      | Rate-limit 11 authenticated GETs. Derive limits from the **real** polling intervals (5s/10s), do not guess.                                                                                            |
| CS-56  | **WORK** (~S)      | Character-constrain `derived.titles` at extraction. Not exploitable today (auto-escaping JSX, same-owner, absent from exports); the cost is future renderers inheriting it silently. Intersects CS-46. |
| CS-11  | **OWNER**          | Public Pages design pass. **UI is FROZEN.** Functional half only if the criteria contain one; visual half deferred by owner directive.                                                                 |
| CS-37  | **OWNER**          | Onboarding/resume-review journey. Same freeze. Do not start a redesign to close a ticket.                                                                                                              |
| CS-30  | **OPERATOR**       | Managed Hostinger firewall. Needs hPanel access. Cannot be attempted; local simulation is explicitly not evidence.                                                                                     |
| CS-5   | **WORK** + blocked | V1 retirement has two unstarted prerequisites (Pages export → PostgreSQL, MCP → V2). **Cannot reach UAT.** Deliverable is a migration plan with blockers named.                                        |

---

## BLOCKED (6)

| Ticket | Unlock       | Detail                                                                                                                                                                                                                                                                                                                                                                                |
| ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CS-3   | **OPERATOR** | Proxy restart behaviour. Needs host proof.                                                                                                                                                                                                                                                                                                                                            |
| CS-24  | **OPERATOR** | Monitoring. Needs host proof.                                                                                                                                                                                                                                                                                                                                                         |
| CS-25  | **OPERATOR** | **Highest-risk item in the backlog.** Its criteria demand a dump "produced without a human running anything" and a restore that "is exercised, not documented". Recorded evidence is a mutation test against a _disposable container_ — neither an unattended dump nor a restore drill. It sat in UAT describing recoverability never shown to exist. Needs the most careful runbook. |
| CS-26  | **OPERATOR** | Scheduled discovery. Needs host proof.                                                                                                                                                                                                                                                                                                                                                |
| CS-27  | **OPERATOR** | Posting expiry/re-check. Needs host proof.                                                                                                                                                                                                                                                                                                                                            |
| CS-46  | **OWNER**    | Requires an owner-confirmed product decision between always-on resume-derived evidence and an explicit per-fact exclusion gate. Both options are already documented neutrally in `docs/KNOWN-LIMITATIONS.md`. **This is the correct terminal state for an agent** — confirming on the owner's behalf would be the exact silent reinterpretation the ticket exists to prevent.         |

---

## Summary of unlocks

| Unlock                                  | Count | Who clears it                                  |
| --------------------------------------- | ----- | ---------------------------------------------- |
| REVIEW (in flight or ready to dispatch) | 9     | Independent Reviewer — no external dependency  |
| WORK                                    | 15    | Engineering, mostly documents and small fixes  |
| OPERATOR                                | 7     | CS-3, CS-24, CS-25, CS-26, CS-27, CS-30, CS-47 |
| OWNER                                   | 3     | CS-46, CS-11, CS-37                            |
| COMMIT                                  | 2     | CS-15, CS-48                                   |
| Already UAT                             | 21    | —                                              |

**The honest headline:** up to 9 tickets can convert to UAT with no external
dependency at all, purely through independent review. 7 need an operator with
host access and nothing else. 3 need a sentence from the owner. 2 need
permission to commit. The remaining 15 are real work, and most of them are
documents rather than code.
