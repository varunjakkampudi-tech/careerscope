# Frontend & Admin Roadmap

## Planning snapshot: 2026-09-20

The owner approved recording missing tickets, not implementing or deploying
them. The [canonical backlog](../.ai/backlog.json) now contains **44 tickets**:
19 Ready, 5 QA, 1 In Progress and 19 Discovery. CS-1 through CS-29 retain their
original objects, statuses, criteria and history. CS-30 through CS-44 are new
Discovery entries with no release target, execution evidence or completed steps.
Priorities, sizes and scores are provisional planning estimates, not readiness.

This is a dated projection, not a second backlog. Consult
[project state](PROJECT-STATE.md) for the V1/V2 split and deployment boundaries.
No branch, feature implementation, release promotion or deployment was performed
for this planning update. Future implementation belongs on an authorized
short-lived branch after current acceptance work, not directly on `main`.

### Existing board

The statuses below are recorded labels, not proof that current bytes passed QA.
"Ready" is the existing todo queue; this update does not reassess readiness.

| ID    | Status      | Priority | Ticket                                                  |
| ----- | ----------- | -------- | ------------------------------------------------------- |
| CS-1  | QA          | P1       | CI proves the V2 unit layer                             |
| CS-2  | QA          | P1       | Linux WebKit lead-header offset at 768px                |
| CS-7  | QA          | P0       | Exact-commit CI deployment gate                         |
| CS-20 | QA          | P1       | Agile commands reject unreadable canonical state        |
| CS-21 | QA          | P1       | Consistent completed-ticket predicate                   |
| CS-12 | In Progress | P1       | Native agent workflow documentation                     |
| CS-3  | Ready       | P1       | Proxy crash recovery or alerting                        |
| CS-4  | Ready       | P2       | Derive release version file list                        |
| CS-6  | Ready       | P1       | Routing, shared layout and signed-in boundary           |
| CS-8  | Ready       | P1       | Fail-closed canonical readers                           |
| CS-9  | Ready       | P1       | Service-backed V2 integration CI                        |
| CS-13 | Ready       | P2       | Shared loading, empty and error states                  |
| CS-14 | Ready       | P2       | Mobile Leads experience                                 |
| CS-16 | Ready       | P1       | Actionable Discovery results                            |
| CS-17 | Ready       | P1       | Job detail experience                                   |
| CS-18 | Ready       | P1       | Match evidence experience                               |
| CS-19 | Ready       | P1       | Shortlist actions and persisted stages                  |
| CS-22 | Ready       | P1       | Verify approved resume/profile contribution to matching |
| CS-23 | Ready       | P1       | Provider empty-result and failure semantics             |
| CS-24 | Ready       | P1       | Worker failure visibility                               |
| CS-25 | Ready       | P1       | Host backup and actual restore verification             |
| CS-26 | Ready       | P2       | Scheduled discovery proposal                            |
| CS-27 | Ready       | P2       | Liveness, freshness and retention                       |
| CS-28 | Ready       | P2       | Distinct posting identity and deduplication             |
| CS-29 | Ready       | P1       | Explicit shared workspace dependency resolution         |
| CS-5  | Discovery   | P3       | V1 retirement prerequisites                             |
| CS-10 | Discovery   | P2       | Agent activation and retention policy                   |
| CS-11 | Discovery   | P2       | Public Pages design review                              |
| CS-15 | Discovery   | P2       | Signed-in and Pages accessibility audit                 |

### Added discovery tickets

ChatGPT supplied the proposal in the existing shared conversation under marker
`TICKET-PLAN-20260920`. It is advisory, not a code audit or test result. The native
Independent Reviewer reviewed planning boundaries before the additions; that
review did not certify an unseen implementation. No source-validation or QA
completion is implied by adding these entries.

| ID    | Priority | Ticket                                        | Prerequisites / disposition                                                       |
| ----- | -------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| CS-30 | P1       | Managed Hostinger firewall verification       | Operator authorization and actual external evidence; release acceptance candidate |
| CS-31 | P1       | V2 skip-link regression                       | Reproduce current bytes; focused child scope of CS-15                             |
| CS-32 | P1       | Pages 320px visual regression                 | Inspect actual/expected/diff; related to CS-11, no blind baseline approval        |
| CS-33 | P1       | Job detail and evidence read contract         | Before CS-17/18 consumption; includes CQ-05 projection investigation              |
| CS-34 | P2       | Web environment least privilege               | Verify configuration consumers; CQ-01 hardening candidate                         |
| CS-35 | P2       | Typed conflict errors                         | Verify API compatibility and actionable client behavior; CQ-03                    |
| CS-36 | P1       | Login, account security and session reset     | CS-6; CQ-04; registration stays disabled                                          |
| CS-37 | P1       | Onboarding, profile and resume review         | CS-6, CS-22, CS-35; explicit approval before matching                             |
| CS-38 | P2       | Dashboard actual-state experience             | CS-6, CS-13; no invented analytics or totals                                      |
| CS-39 | P2       | Preparation and Career Links pages            | CS-6, CS-13; reuse existing rules/static content                                  |
| CS-40 | P2       | Admin authorization and investigation surface | Deferred design/security approval; role/contracts before UI                       |
| CS-41 | P2       | Job/company/skill domain expansion            | CS-28, CS-33; deferred inventory and architecture approval                        |
| CS-42 | P2       | Saved search domain and UI                    | CS-23; deferred; later scheduling separately gated by CS-26                       |
| CS-43 | P2       | Alerts and notification semantics             | CS-42, CS-27; deferred; delivery/scheduling not activated                         |
| CS-44 | P2       | Account recovery and verification lifecycle   | Deferred security design and approved sender; separate from password change       |

### Progress and QA

- No ticket is recorded Released or Ready for Release. The six active records
  (five QA plus one In Progress) already exceed the WIP limit of two. Discovery
  additions do not increase active WIP or justify starting more work.
- [progress.json](../.ai/progress.json) has historical September 19 percentages
  without a current verified denominator. They are not carried forward as fresh
  completion estimates. [QA-REPORT.md](../.ai/QA-REPORT.md) is a placeholder, not
  proof that no QA ever ran. Neither record was silently rewritten.
- [release-plan.json](../.ai/release-plan.json) has no current/next release or
  recorded release history and keeps scheduling disabled. That does not disprove
  the independently documented production deployment.
- The saved [acceptance command log](../test-results/current-tree-baseline-20260920-053322/commands.jsonl)
  records a partial run: root 1047, V2 57 and Pages 21 tests passed; root/V2
  typecheck, lint and build, V2 format, and three-engine Pages workspace checks
  passed. These are historical run results, not current-byte revalidation.
- That run failed root formatting, root WebKit 390px row-overlap checks, the V2
  skip-link check and a Pages visual comparison. CS-31 and CS-32 isolate the last
  two. The 390px failure is not automatically the same defect as CS-2's Linux
  768px offset; reproduce and triage it in acceptance before assigning a fix.
  Formatting failures in the historical baseline documents also remain open.
- No after-snapshot established content continuity. Full accessibility, Linux
  WebKit, dedicated queue/crash/full-disk/database-recovery/performance gates,
  fresh vulnerability scans and live provenance remain unverified for that run.
  This ticket-planning update does not rerun application or live checks.

### Decisions and work order

Record the 15 bounded groups rather than duplicate each widget or rewrite the
existing backlog. Preserve the original records and link related work here.
The data-contract ticket CS-33 precedes its page consumers; it does not depend
on CS-17/18. Saved-search design does not depend on activating a scheduler.

First rebuild current-byte acceptance evidence. Then retain the owner's release
sequence: CS-1/CS-9 CI coverage, CS-7 exact-SHA gate, CS-8 fail-closed readers,
CS-2, CS-3 and managed-firewall acceptance CS-30. Resolve the recorded failing
checks before treating that sequence as complete. Frontend implementation follows
acceptance and approved design; deferred domain/admin/recovery work follows its
own approvals. No previous exhausted implementation/review counter is reset.

Superseding constraints apply even where older criteria remain historical:
CS-7 must not be tested by pushing known-red code; use isolated negative controls.
CS-10 must preserve the 24-role capability library and four-agent default.
CS-23 must distinguish legitimate empty results from broken providers, not mark
every empty HTTP 200 as failure. CS-22 must investigate the existing explicit
resume-to-profile approval path, not bypass approval or invent scoring weights.
CQ-02 stage-label/action investigation belongs with CS-19; note edits must
preserve all supported stages and never imply an application was submitted.

## Planning snapshot: 2026-09-23 — design image audit and route architecture

The owner added five PNG design images under `page-designs/`. This section
records a visual audit of every image, a reconciled route architecture, and
the resulting ticket changes. No frontend code was written for this snapshot
beyond what is separately recorded against CS-49 (Dashboard). Nothing here
implies deployment, promotion, or that a page "matches" its design merely
because a ticket references it.

### What was actually inspected

Five files exist under `page-designs/`:

1. `CareerScope Saved Jobs Dashboard.png`
2. `CareerScope Desktop and Mobile Job Search.png`
3. `CareerScope Applications Dashboard Mockup(1).png`
4. `CareerScope Application Details Dashboard.png`
5. `CareerScope Application Details Dashboard (1).png`

Despite two filenames containing the word "Dashboard," **none of the five
images depicts the sidebar's own "Dashboard" nav item in its active/selected
state, and no image shows Dashboard page content.** Image 5 is visually
identical to image 4 (same Application Details screen, no discernible
difference) — treated as one design, not two. This leaves **four distinct
designed screens**, not five, and **zero designed Dashboard screens**. This is
recorded here rather than silently substituted, per the standing rule against
inventing UI requirements not supported by the design images.

### Per-screen audit

**1. Saved Jobs** (image 1; sidebar item "Saved" active)

- SUPPORTED BY DESIGN: split list/detail layout; stat cards (Saved/Applied/
  Still Interested/May Apply Later/No Longer Interested); status filter tabs;
  per-job cards with logo, tech tags, "Saved N days ago"; detail pane with
  tabs (Overview/Requirements/Benefits/Company/Similar Jobs), company panel,
  quick-info panel, action row (Remove from Saved/Add Note/Set Reminder/Share
  Job); pagination; mobile variant with segmented control and bottom tab bar.
- SUPPORTED BY CURRENT PRODUCT: a saved-leads list already exists
  (`GET/POST/PUT /api/leads`), with real per-job data, notes and status.
  Bookmarking and status changes are real, persisted operations (CS-19).
- INFERENCE / PROPOSAL: "Similar Jobs" tab, "Set Reminder," "Share Job" have
  no backing API today.
- NOT CURRENTLY IMPLEMENTED / DOES NOT MATCH REAL DATA: the design's status
  categories — **Interested, May Apply Later, Not Interested, Applied** — do
  not match `leadStatusSchema` (`saved, applied, interviewing, offer,
rejected, archived`) defined in `v2/packages/core/src/leads.ts:7-13`. This
  is a product-level reconciliation question, not a styling detail; mapping
  them 1:1 would misrepresent what the status field actually means. Left for
  CS-19's owner to resolve explicitly, not decided here.
- The left sidebar's "Upgrade Plan" / "Free Plan" widget has no correspondence
  in CareerScope, which is single-owner with no billing system
  (`docs/PROJECT-STATE.md`). Treated as a template artifact, not a
  requirement, unless the owner says otherwise.

**2. Jobs / Discovery search** (image 2; sidebar item "Jobs" active)

- SUPPORTED BY DESIGN: facet tabs (All/Remote/Hybrid/On-site/Saved); filter
  bar (Role/Experience/Location/Salary/Job Type/Company/Skills) plus
  "Advanced Filters"; active-filter chips with individual removal and "Clear
  All"; result count; per-job **Match %** badge; split list/detail with the
  same detail-pane structure as Saved Jobs; an explicit disclaimer banner on
  the detail pane: _"No auto-apply: CareerScope does not submit applications
  automatically. You're always in control."_
- SUPPORTED BY CURRENT PRODUCT: this maps directly onto CS-16 (actionable
  discovery results), CS-17 (job detail view) and CS-18 (match-score
  explanation) — real deterministic match scores already exist
  (`packages/matching`) and the no-auto-apply constraint is a real, existing
  product decision the design correctly encodes as user-facing copy.
- NOT CURRENTLY IMPLEMENTED: the design shows only a bare "95% Match" badge
  with no visible per-dimension breakdown — CS-18's acceptance criteria
  (per-dimension contributions, exclusion reasons, low-confidence disclosure)
  go beyond what this image actually shows and must not be considered
  satisfied by a badge alone.
- "Review & Track Application" button implies write-through into whatever
  the Applications screen (below) turns out to require — not decided here.

**3. Applications — "Track Your Progress"** (image 3; sidebar item
"Applications" active)

- SUPPORTED BY DESIGN: stat cards with trend deltas (Total/In Progress/
  Interviews/Offers/Not Selected); status tabs; a table (Job/Company, Status,
  Applied On, **Next Step**, Actions); an "Application Insights" bar chart;
  a "Your Application Tips" panel; an "AI Insights"/"Let AI Help You Prepare"
  panel.
- NOT CURRENTLY IMPLEMENTED — no existing backend concept for: multi-stage
  interview scheduling with dates/times ("Technical Round Sep 25, 2026 2:00
  PM IST"), a free-text "Next Step" field, trend deltas ("+12% vs last
  month"), or the analytics chart. `leadStatusSchema` has no `In Progress` /
  `Offer` distinction matching this screen 1:1 (it has `applied`,
  `interviewing`, `offer` — close but not identical wording, and no dated
  sub-stages within any one status). This is a materially larger feature
  than "the existing shortlist, restyled" — recorded as its own new
  DISCOVERY ticket (CS-49 is Dashboard; this screen is **CS-50**, see below),
  not folded into CS-19.
- The "AI Insights & Suggestions" and "Let AI Help You Prepare" panels map to
  the OpenRouter AI work (CS-48) and are explicitly out of scope for any
  ticket touched in this snapshot, per the owner's own directive that AI work
  is separate.

**4. Application Details** (images 4 and 5, identical)

- SUPPORTED BY DESIGN: a horizontal stage tracker (Applied → Application
  Review → Technical Round → HR Round → Offer) with per-stage dates/status;
  Job Details panel; Company Overview panel; a chronological "Application
  Timeline" with per-event narrative text; a "Documents" panel (Resume v3,
  Cover Letter, Portfolio) with per-document upload dates; a multi-entry,
  timestamped "Your Notes" list; an "AI Insights & Suggestions [Beta]" panel
  with an "Application Strength" percentage.
- NOT CURRENTLY IMPLEMENTED: none of the stage tracker, timeline events,
  per-document metadata, or multi-entry notes exist today. `saved_leads.notes`
  is a single free-text field (`v2/packages/core/src/leads.ts`), not a list of
  timestamped entries — implementing this screen as designed would require a
  new notes-history table, not a UI change alone. Recorded under the same new
  CS-50 ticket as the Applications list screen, since a details view requires
  the list's data model to exist first.
- The "AI Insights & Suggestions [Beta]" panel is, again, CS-48's concern,
  not this ticket's.

### Shared design system extracted (real, cross-screen evidence)

Consistent across all four screens: a fixed dark sidebar (logo mark +
"Discover · Prepare · Grow" tagline; nav order Dashboard, Jobs, Applications,
Saved, Resume, Skills, Insights, **AI Assistant**, Career Resources, Settings;
illustrated card + user/plan footer); a light topbar (global search with
`Ctrl+K` affordance, a scope dropdown, a themed search button, a light/dark
toggle, a notification bell with a count badge, an avatar menu); a stat-card
row pattern; a tabbed status-filter pattern; a two-pane list/detail layout on
desktop collapsing to a single scrollable list plus a bottom tab bar on
mobile; a consistent card/badge/tag visual language. This is real, reusable
evidence for a shared shell and design-token system (CS-6/CS-13's concern),
independent of the per-page data questions above.

Sidebar items **Resume, Skills, Insights, Career Resources, Settings** and
the topbar's global search and notifications have **no corresponding design
image** — their content, if any, is not specified by anything provided and is
not assumed here.

### Reconciled route architecture

| Route                                                 | Page                        | Design ref                       | Auth    | Shell     | Nav location                                           | Source of truth                                                             | Current status                                                                      | Existing ticket              | New ticket?                                                                                      | Deps               | Mobile design | Desktop design | Open questions                                                                                                                                                                       |
| ----------------------------------------------------- | --------------------------- | -------------------------------- | ------- | --------- | ------------------------------------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------ | ------------------ | ------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/dashboard`                                          | Dashboard                   | **none provided**                | private | app shell | sidebar #1                                             | `GET /api/searches` (recent runs) + lead/status counts via `GET /api/leads` | Exists today as a `view==='dashboard'` state pane (`page.tsx:338-361`), not a route | CS-38 (existing, DISCOVERY)  | Use CS-38; also opened **CS-49** for the concrete real-route implementation this snapshot builds | CS-6, CS-13        | none          | none           | No Dashboard mockup exists; scope for CS-49 is the existing pane's real data, reshelled with the extracted shared design system, honestly labelled — see owner decision needed below |
| `/jobs` (or `/search`)                                | Discovery / Jobs search     | image 2                          | private | app shell | sidebar #2                                             | `POST /api/searches`, `GET /api/searches/:id/jobs`                          | Exists as `view==='search'`                                                         | CS-16                        | no                                                                                               | CS-13              | ✔             | ✔              | Whether route is `/jobs` or `/search` — design labels the nav "Jobs," existing code/tickets say "Discovery/search"; not resolved here                                                |
| `/jobs/:runId/:jobId` or `/search/:runId/jobs/:jobId` | Job detail                  | image 2 (detail pane)            | private | app shell | (no separate nav item — reached from list)             | same run/job data                                                           | Detail is inline in `view==='search'`, not a distinct route                         | CS-17                        | no                                                                                               | CS-16              | ✔             | ✔              | none                                                                                                                                                                                 |
| `/leads` (design calls it "Saved")                    | Saved Jobs                  | image 1                          | private | app shell | sidebar #4                                             | `GET/POST/PUT /api/leads`                                                   | Exists as `view==='leads'`                                                          | CS-14 (mobile), CS-19 (flow) | no                                                                                               | CS-2, CS-18        | ✔             | ✔              | Status-category mismatch noted above, unresolved                                                                                                                                     |
| `/applications`, `/applications/:id`                  | Applications list + details | images 3, 4/5                    | private | app shell | sidebar #3                                             | **none — new data model required**                                          | Not implemented; no equivalent screen exists                                        | none                         | **yes — CS-50**                                                                                  | CS-19, CS-50       | ✔             | ✔              | Whether CareerScope adopts an ATS-style interview-timeline model at all is a product decision, not decided here                                                                      |
| `/preparation`                                        | Preparation                 | none                             | private | app shell | sidebar item "Career Resources"? or separate — unclear | `GET /api/preparation`                                                      | Exists as `view==='preparation'`                                                    | CS-39                        | no                                                                                               | CS-6, CS-13        | —             | —              | Design has no dedicated Preparation/Career-Links screen; nav taxonomy doesn't obviously map "Career Resources" to the existing "Career Links" view — flagged, not resolved           |
| `/career-links`                                       | Career Links                | none                             | private | app shell | see above                                              | static/curated list                                                         | Exists as `view==='links'`                                                          | CS-39                        | no                                                                                               | CS-6, CS-13        | —             | —              | same as above                                                                                                                                                                        |
| `/profile`                                            | Profile                     | none                             | private | app shell | sidebar item "Skills"? unclear                         | `GET/PUT /api/profile`                                                      | Exists as `view==='profile'`                                                        | CS-37                        | no                                                                                               | CS-6, CS-22, CS-35 | —             | —              | No image; "Skills" as a separate nav item vs. part of Profile is not resolved                                                                                                        |
| `/account/security`                                   | Account security            | none                             | private | app shell | topbar avatar menu (implied)                           | existing session/password endpoints                                         | Exists as `view==='security'`                                                       | CS-36                        | no                                                                                               | CS-6               | —             | —              | none                                                                                                                                                                                 |
| `/login`                                              | Login                       | none                             | public  | none      | —                                                      | `POST /api/session`                                                         | Exists inline via `AccountForm`, not a route                                        | CS-36                        | no                                                                                               | CS-6               | —             | —              | none                                                                                                                                                                                 |
| —                                                     | AI Assistant                | images 1/3/4 (nav item + panels) | private | app shell | sidebar (present in every image)                       | **OpenRouter (CS-48)**                                                      | Not implemented; explicitly out of scope for this snapshot                          | CS-48                        | no                                                                                               | —                  | —             | —              | Owner directive: "OpenRouter AI work is separate and must NOT be implemented in this task"                                                                                           |

No route was invented for `/register`, `/forgot-password`, `/verify` or
`/admin` — none is supported by the current designs or by current product
state, consistent with the standing instruction not to resurrect previously
proposed routes without present evidence.

### Ticket disposition (Phase 3)

- **CS-49 (new)** — "Dashboard: real-route implementation using the extracted
  shared shell, no invented metrics." Depends on CS-6 (routing must exist for
  Dashboard to be a real route) and CS-13 (shared loading/empty/error). Scope:
  restyle the existing honest dashboard pane (recent searches + real lead
  counts) using the shared visual system extracted above; add no metric
  without a real API field. Status: DISCOVERY until the owner resolves the
  no-Dashboard-image gap (see below), then intended to move through the same
  ticket lifecycle as everything else this session (implement → real
  specialist review → QA → owner-acceptance stop, never further, per rule).
- **CS-50 (new)** — "Applications tracking: interview-stage data model and
  UI (list + details)." Recorded as DISCOVERY with a securityImpact/
  architectureImpact placeholder and an explicit product-decision gate: does
  CareerScope adopt an ATS-style multi-stage interview timeline at all, and
  does that change "it does not apply to jobs" positioning in
  `docs/PROJECT-STATE.md`? Not started; requires Product Architect/System
  Designer sign-off before any implementation, consistent with this
  session's practice for architecture-impacting changes.
- CS-6, CS-13, CS-14, CS-16, CS-17, CS-18, CS-19, CS-36, CS-37, CS-38, CS-39
  are **not duplicated** — their existing IDs, statuses, and acceptance
  criteria are preserved unchanged. This snapshot only adds the design
  cross-reference above; it does not silently rewrite any of their
  acceptance criteria.

### Addendum, same day: the owner supplied the real Dashboard design

Shortly after this snapshot was written, the owner shared the actual
Dashboard mockup directly (not saved to `page-designs/`), resolving the gap
recorded above. CS-49 was rebuilt against it: hero greeting banner, a real
(not fabricated) career-progress checklist, four real stat cards, a
recommended-jobs list sourced from the owner's own most recent search, a
recent-activity feed merged from real search/lead/resume events, a
last-search skill ranking, quick actions, and a disabled "Not available yet"
AI Assistant placeholder (the design includes one; CS-48 still owns the real
implementation). Every number either traces to a real API field or shows an
honest empty/placeholder state — the design's invented figures ("94% Profile
Match", "248 New Jobs +12%", "12 Applications +3% this week", "AI Career
Assistant · Active") were deliberately not reproduced, per the owner's own
standing rule against invented metrics. A real Independent Reviewer pass (3
findings, all fixed: a capped-count honesty gap, two mis-targeted nav links,
an activity/checklist inconsistency) and a real QA pass (PASS, two process
items reconciled) both ran before promotion. CS-49 was promoted QA → UAT via
`node scripts/agile.mjs promote` — a real, evidence-gated command, not a
manual status edit. Per this task's own stop condition, no further page was
started; the session is holding for the owner's visual confirmation of the
Dashboard result.

Assumptions: private single-owner workload, existing stack and bounded requests,
no extra polling/collection without a measured need, preserved privacy and
single-host reliability limits. New routes need focused latency and failure
checks, not invented performance claims. Ticket owners maintain their contracts
and tests; assigned reviewers are planned roles, not evidence they participated.
Open decisions remain admin authority, expanded data models, notification
channels and the recovery sender. No public signup, AI, auto-apply or scheduler
activation is authorized.

---

## The core problem

The requested product is a multi-page career intelligence workspace with an
admin console. The current frontend is **one route**. More importantly, several
requested pages have **no backing data** — not a missing endpoint, a missing
table.

Building UI for data that does not exist means inventing data. That is
forbidden. So the work splits into "buildable now" and "needs backend first".

---

## Frontend page-to-ticket map

[V2 page.tsx](../v2/apps/web/src/app/page.tsx) currently selects Discovery,
Dashboard, Leads, Preparation, Career Links, Profile and Security through local
view state on `/`. Existing components are not evidence of separate routes.
**Every additional path below is proposed**, not an implemented route or an
approved URL contract. Public Pages is a separate artifact. QA todos in this
table have not been executed by this planning update.

CS-6 owns routing and the shared signed-in shell; CS-13 owns shared states;
CS-15 owns the broader accessibility audit. All private views also require
server-side owner authorization, not just a client guard.

| Surface / proposed path                                   | Current basis and boundary                                       | Tickets                           | QA todo / prerequisite                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Shared shell `/`                                          | Existing V2 state views and session contract                     | CS-6, CS-13, CS-15, CS-31, CS-36  | Private deep links, back/refresh, focus, expiry, no private-data flash                                                             |
| Login `/login`                                            | Existing account form; session/login APIs                        | CS-6, CS-36                       | Success, invalid credentials, rate limits, retry and safe return destination                                                       |
| Conditional registration `/register`                      | Registration capability stays off                                | CS-36; CS-44 for future lifecycle | Disabled UI/server behavior; no enablement or new public signup promise                                                            |
| Onboarding `/onboarding`                                  | Proposed journey over existing profile/resume contracts          | CS-37                             | With/without resume, incomplete state and explicit save                                                                            |
| Profile `/profile`                                        | Existing profile editor and revisioned profile API               | CS-37, CS-35, CS-22               | Validation, stale revision, preserved edits and saved matching snapshot                                                            |
| Resumes `/resume`, `/resume/:id`                          | Existing private upload/parse/review components                  | CS-37, CS-22                      | Owner denial, invalid file, pending/failed parse, 507 and capability-gated cancel                                                  |
| Account security `/account/security`                      | Existing password/session controls                               | CS-36                             | Password failure/retry, revocation, cache reset, CSRF and owner boundary                                                           |
| Dashboard `/dashboard`                                    | Existing recent-run/dashboard view                               | CS-38, CS-6, CS-13                | Real persisted values, capped-list semantics, empty/error and freshness                                                            |
| Discovery `/search`                                       | Existing searches/results and source outcomes                    | CS-16, CS-13, CS-23               | Actionable supported facts, ranking, filters, partial/provider failures                                                            |
| Run history `/searches`, run `/search/:id`                | Existing run list/detail/events; route extraction proposed       | CS-6, CS-16, CS-23                | Owner isolation, reopen, stream reconnect/reset, interrupted and partial runs; refine history-specific scope before implementation |
| Job detail `/search/:runId/jobs/:jobId`                   | Owner/run-scoped retained job, not a global public job           | CS-33 before CS-17                | Safe external content, provenance, freshness, malformed/foreign identity                                                           |
| Match evidence (detail section or subroute)               | Existing stored evidence/frozen profile; richer contract pending | CS-33 before CS-18                | Known/unknown dimensions, exclusions, low confidence; no duplicate scoring                                                         |
| Leads `/leads` and `/leads/:id`                           | Existing saved/archived editor and lead/history APIs             | CS-19, CS-14, CS-35               | Mobile usability, all supported stages, note edits preserve stage, history, dedup and retry                                        |
| Preparation `/preparation`                                | Existing saved-profile rules-v1 report                           | CS-39                             | No-profile, populated, failure/retry and truthful non-AI scope                                                                     |
| Career Links `/career-links`                              | Existing curated/static resources view                           | CS-39                             | Safe links, provenance, filters/empty state, keyboard and mobile                                                                   |
| Job catalog `/jobs`                                       | A broader corpus is not established by retained search results   | CS-41                             | Deferred data/coverage/identity decision; no public owner-data exposure                                                            |
| Companies `/companies`, `/companies/:id`                  | Owner-scoped observations/APIs require inventory                 | CS-41                             | Deferred authoritative identity and coverage; no fabricated company facts                                                          |
| Market/skills `/market`, `/skills`, `/skills/:id`         | Retained-result evidence is not global market coverage           | CS-41                             | Deferred schema/aggregate scope, unknown fields and sample limitations                                                             |
| Saved searches `/saved-searches`                          | Durable criteria lifecycle requires design                       | CS-42                             | Deferred CRUD/revision/owner tests; no scheduler activation                                                                        |
| Alerts `/alerts`                                          | Notification lifecycle/channel unresolved                        | CS-43                             | Deferred replay/dedup, stale vs closed, bounded delivery and privacy                                                               |
| Recovery `/forgot-password`, `/reset-password`, `/verify` | No approved transactional sender or self-service lifecycle       | CS-44                             | Deferred approval, non-enumeration, expiry, single use and abuse tests                                                             |
| Admin `/admin/*`                                          | No approved role/read endpoint contract; Swagger is not admin    | CS-40                             | Deferred role provisioning, anonymous/non-admin denial and redacted reads                                                          |
| Public Pages and encrypted admin                          | Separate `mobile-site` artifact, not V2 routes                   | CS-11, CS-15, CS-32               | Visual/mobile checks, allowlists, decryption boundary and no API/workflow claims                                                   |

The map is coverage, not extra acceptance criteria silently appended to old
tickets. Before implementation, reconcile any newly discovered scope with the
owning ticket. No extra run-history or stage ticket is created merely to fill a
row in this table.

---

## Blocked on backend work

Each of these needs schema and collection work before any UI is honest.

| Requested                                        | Blocker                                                                                                         |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `/jobs` public browsing                          | Owner/run-scoped results are not a global corpus; expanded coverage and publication require approval.           |
| `/companies`, `/companies/:id`                   | Inventory existing owner-scoped company/posting observations before proposing richer entities or pages (CS-41). |
| `/market`, `/skills`                             | Existing retained-result market evidence does not establish global aggregates or rich skill/job facts (CS-41).  |
| `/alerts`, saved searches                        | No saved-search entity.                                                                                         |
| `/verify`, `/forgot-password`, `/reset-password` | **No email sender.** OPEN — EXTERNAL.                                                                           |
| All `/admin/*`                                   | No admin role, no admin endpoints, no audit table.                                                              |

Missing salary, skill or other rich facts cannot be invented by the UI. First
inventory the stored contracts under CS-33/CS-41; any expansion needs explicit
normalization, source capability, migration and historical unknown-value rules.

---

## Admin console

Deferred discovery under CS-40. It must **not** be a database UI. The intended
views below are candidates to validate, not approved endpoints or live evidence.

### Prerequisites, in order

1. An approved **owner/admin role** model, provisioning/revocation policy and server authorization.
2. Read-only admin endpoints under `/api/admin/*`, subject to the same session,
   CSRF and origin rules as everything else.
3. Approved audit requirements. Any future mutation requires an audit record and
   separately approved design; the initial candidate surface is read-only.

### Intended views, and what already exists to back them

| View                                                                     | Data source                                         | Exists?                    |
| ------------------------------------------------------------------------ | --------------------------------------------------- | -------------------------- |
| Overview — health, version, deployed SHA                                 | `/api/health`, OCI revision label                   | Partly                     |
| Queue — ready, in-flight, DLQ, oldest work                               | SQS + `command_executions`                          | Data yes, endpoint no      |
| Outbox — oldest unpublished                                              | `outbox_events`, indexed `(publishedAt, createdAt)` | Data yes, endpoint no      |
| Runs — searches, executions, timing, provider outcomes                   | `search_runs.sourceOutcomes`                        | Data yes, endpoint no      |
| Providers — success, failure, limited, latency                           | Per-run outcomes                                    | Aggregation does not exist |
| Storage — objects, bytes, temporaries, reserved bytes, markers, refusals | File storage counters                               | Data yes, endpoint no      |
| Security — session count, revocations                                    | `sessions`                                          | Data yes, endpoint no      |

### Hard rules

Never expose: password hashes, session tokens, cookies, the database password,
the Redis password, encryption keys, private keys, or raw resume content.

Every admin mutation requires owner authorization, CSRF, origin validation,
server-side validation, an audit record and explicit confirmation. Do not
invent destructive endpoints — "delete any row" is not an admin feature.

---

## Post-acceptance frontend order

1. Routing, auth boundary, shared layout. Everything else depends on it.
2. Move the seven existing components onto real routes, with proper loading,
   empty, error and unauthorized states.
3. Polish: responsive behaviour, focus management, live regions, 409 and 507
   experiences.
4. Resolve CS-33 contracts before their detail/evidence page consumers.
5. Consider admin only after CS-40 design/security approval and authorized
   read-only endpoints; do not bundle mutation controls into page work.
6. Keep CS-41 through CS-44 deferred until their domain and external prerequisites
   are approved. They are not mandatory additions to the private-owner MVP.

---

## Standing constraints

Unchanged by this phase:

- AI stays off. Matching stays deterministic.
- Auto-apply stays on hold.
- Naukri stays deferred, and legitimate-access only if ever built.
- Do not weaken Argon2id, CSRF, origin checking or rate limits for UI
  convenience.
- Do not break existing API contracts.
- This planning update grants no feature-branch, commit, push or deployment authority.

---

## Progress update: 2026-09-23 (evening) — CS-6 and the core product slice shipped

Following the owner's direction to complete the ticket backlog with ChatGPT
review looped after every ticket, and to close the visual gap toward the
owner-supplied design images with real, measured tooling rather than
subjective judgement.

### Shipped and QA-recorded this round

- **CS-6** (frontend routing + auth boundary): every real page is now its own
  Next.js route under `app/(app)/` — `/dashboard`, `/jobs`, `/saved`,
  `/resume`, `/settings`, `/career-resources`, `/preparation` — behind one
  shared `AuthenticatedShell` that is the single place deciding whether
  private content renders. Root `/` is sign-in only. One shared `QueryClient`
  replaces the previous per-route instances. Known, disclosed gap:
  `scripts/check-ui.ts` still assumes the old button/view navigation and needs
  its own rewrite before it can be trusted again as a regression gate.
- **CS-13** (shared loading/empty/error states): `components/ui-states.tsx`
  (`LoadingState`, `ErrorState`, `EmptyState`) rolled out to the shell and the
  Jobs route; not yet rolled out inside every other route's internals.
- **CS-14** (mobile Leads): all 6 real lead statuses (`saved`, `applied`,
  `interviewing`, `offer`, `rejected`, `archived`) now have real filter tabs
  and a real status selector — previously only 2 of 6 were reachable. Found
  and fixed two real overflow bugs (a CSS Grid blowout and a flex
  `min-width` bug) and one real accessibility bug (a heading level skip in
  `MatchEvidence`).
- **CS-16** (actionable job results): results are now sorted by match score;
  recency and top matched skills show on the collapsed row. Confirmed —
  rather than assumed — that salary cannot be fabricated (`collectedJobSchema`
  has no salary field; CareerScope collects none) and that the only two real
  API filters (query, sources) were already reachable.
- **CS-17** (job detail): confirmed the existing inline detail view already
  satisfies its criteria, including that posting descriptions were already
  XSS-safe (no `dangerouslySetInnerHTML` anywhere in `apps/web`). Real,
  undecided gap recorded rather than faked: there is no "dismiss" action or
  schema support for one.
- **CS-18** (explainable match score): `match.excludedReason` existed in the
  data model but was never shown — a hard-excluded job explained nothing.
  Now surfaced as a prominent alert; low confidence is now explicit text, not
  an unlabelled tag.
- **CS-19** (save/shortlist flow): confirmed the backend already dedupes a
  save by fingerprint (`ON CONFLICT ... DO NOTHING`, falls back to the
  existing lead). Added the one real missing piece: an immediate, real
  "Saved. Undo?" action that archives the just-saved lead through the same
  status endpoint the lead editor uses.

### Design-parity infrastructure (owner request)

- Replaced a `font-family` rule naming `'Avenir Next'` — a font CareerScope
  never actually ships — with `next/font/google` Inter, embedded at build
  time. Every OS was previously silently substituting a different local font;
  now rendering is identical everywhere.
- Built `scripts/visual-regression.ts` (pixelmatch + pngjs): screenshots a
  live route, diffs it against a reference PNG, and reports an objective
  percentage match plus a diff image. First real, correct measurement:
  `/dashboard` vs. the owner's pixel-perfect reference scored **66.32%**.
  A meaningful share of that gap is pixels that will not close without
  fabricating data (a 4th/5th job card, week-over-week deltas, a market-wide
  chart, a stock photo) — tracked honestly rather than chased with fake
  content. ChatGPT review is pending confirmation on reporting a second,
  style-only score alongside the raw one.

### A real, separate bug found while verifying end-to-end

The local synthetic test fixture's `match.dimensions` was stored as `{}`.
`matchDimensionsSchema` requires one entry per real `MATCH_WEIGHTS` key
(`score`, `weight`, `reason` each), so `collectedJobSchema.strip().parse(...)`
inside `Leads.save()` has been throwing for this entire local fixture dataset
— `POST /api/leads` returned 400 for every save attempt in local dev. This is
local seed-data staleness (the real discovery worker always populates every
dimension), not a product code bug, and was fixed by correcting the local
fixture data rather than loosening the schema.

### Still open

- CS-50 (Applications tracking, scoped down to an honest v1 per ChatGPT's
  agreement — no fabricated interview-stage timeline, AI insights panel or
  documents manager).
- `check-ui.ts` rewrite for the new routing model.
- CS-13's rollout into every route's own internals (Saved/Resume/Settings/
  Preparation/Career Resources still have ad hoc states in places).
- Skills, Insights and AI Assistant remain honestly disabled ("Soon") — no
  owner-supplied design and no real underlying feature yet.
