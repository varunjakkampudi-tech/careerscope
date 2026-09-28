# CareerScope backlog execution batches

This is the execution order for the 34 tickets that are not in UAT as of
2026-09-28. A batch is a planning unit, not evidence of completion: every
ticket keeps its canonical status in `.ai/backlog.json`, and a BLOCKED ticket
does not move until its named owner, host, or design evidence exists.

## Batch 1 — CI and release gates

`CS-1`, `CS-7`, `CS-9`, `CS-52`, `CS-84`

Close the remaining pipeline coverage, exact-SHA deployment gate, V2 service
coverage, security-check registration, and grouped dependency reconciliation.
Run this first because every later implementation batch depends on trustworthy
validation. CS-7 and CS-84 remain gated on their explicit release evidence.

## Batch 2 — Host runtime and scheduled operations

`CS-3`, `CS-24`, `CS-25`, `CS-26`, `CS-27`, `CS-30`, `CS-47`

Use the consolidated host-evidence runbook and one controlled operator session
to verify proxy recovery, monitoring, database backup, discovery scheduling,
freshness, managed firewall exposure, and timer health. These remain BLOCKED
until real Hostinger/host evidence is recorded; local simulation is not a
substitute.

## Batch 3 — Application security controls

`CS-46`, `CS-54`, `CS-59`

Resolve the owner decision for resume-fact exclusion, remove or formally
compensate for unsafe-inline CSP, and prove proxy-safe per-key rate limiting.
Security review and dependency closure are required before QA promotion.

## Batch 4 — Public frontend information architecture

`CS-11`, `CS-14`, `CS-17`, `CS-19`

Complete the public Pages design pass, mobile Leads usability, job-detail
experience, and coherent save/shortlist flow as one UX family. Keep any domain
or API gaps visible rather than fabricating frontend state.

## Batch 5 — Discovery and notification domains

`CS-41`, `CS-42`, `CS-43`, `CS-44`

Produce the job/company/skill, saved-search, alerts, and account-recovery
domain contracts. This is discovery-first work; implementation only begins
after the owner and security decisions captured by each ticket are accepted.

## Batch 6 — Onboarding and resume journey

`CS-37`, `CS-64`

Finish the explicit onboarding/profile/resume-review journey and make resume
title derivation language-robust. Preserve deterministic matching boundaries.

## Batch 7 — Applications product slice

`CS-50`

Close the interview-stage data model and list/detail UI after the saved-lead
and status semantics are stable. This is intentionally isolated so its domain
decision cannot be hidden inside a broad frontend batch.

## Batch 8 — Platform and architecture cleanup

`CS-5`, `CS-10`, `CS-45`

Retire the V1 layer, define agent activation policy, and complete the remote
engineering control-center design with a separately gated write path. These
are architecture/release-scope changes and require explicit migration and
authorization evidence.

## Batch 9 — Admin authorization and pages design

`CS-40`, `CS-88`

Keep both tickets BLOCKED. They require owner-provided privileged workflows,
authorization contracts, redaction boundaries, and approved admin-page UX
before any endpoint or UI implementation is attempted.

## Batch 10 — Deployment hardening and guarded AI activation

`CS-80`, `CS-86`, `CS-89`

Establish the untracked-file baseline, complete Hostinger firewall hardening,
and finish the OpenRouter operational path. CS-86 requires live Hostinger
firewall evidence; CS-89 additionally requires owner approval, a
provider-verified `:free` model, an approved Hostinger secret, and live
rollback verification. AI remains default-off until then.

## Sequencing rule

Execute one batch at a time. Before moving a ticket to QA or UAT, record the
current-content evidence required by every acceptance criterion, run the
applicable quality gates, and preserve any unresolved dependency as BLOCKED.
Owner decision (2026-09-29): database backup (CS-25) is intentionally deferred
to a future release because no VPS backup was taken for this release. The
host timer was disabled without deleting its implementation or any data; CS-25
is tracked in BACKLOG until the future backup design and acceptance window.
