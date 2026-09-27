# Sprint Product Discussion: 2026-09-20

## Mandate and decision status

The owner requested a discussion with all agents about new features, candidate
tickets, architecture, code quality and differentiation inspired by LinkedIn and
Naukri. The owner explicitly confirmed **private single-owner workspace
improvements**, not a public candidate/recruiter platform.

This is a native-agent, asynchronous roundtable coordinated by the parent
session, not a live voice call or agents talking directly to each other. The
parent passed earlier contributions into later rounds. The all-24 invitation is
a one-time owner-requested exception to the usual smallest-sufficient team.
Participation does not establish consensus, implementation approval or QA.

**Current status:** all 24 specialist invocations returned. The Final Auditor
found no scoped content issues and accepted this discussion record, not product
readiness. Attendance is established by the parent's actual native invocations;
the auditor could not independently inspect their transcripts.

**Owner decisions:** convene all 24 roles; retain private-owner scope; discuss
proposals without implementation. **Recommendations, not owner decisions:** an
acceptance-first work period, followed by the existing discovery-to-shortlist
journey. Neither the comparison design nor a new ticket has been approved.

## Starting state

- [Canonical backlog](../backlog.json): 44 tickets, 19 Ready, 5 QA, 1 In Progress
  and 19 Discovery. Active WIP is 6 against a limit of 2; no status was changed.
- [W38 sprint](2026-W38.json): ACTIVE and scope-frozen, selecting CS-1, CS-2,
  CS-3, CS-7, CS-8 and CS-9. Its existing dates and release target are unchanged.
  This discussion does not open W39, reschedule W38 or activate feature work.
- [Process mode](../process-mode.json) is ACTIVE and retains historical pause
  fields. Their presence is not authority to rewrite history or scope.
- The separate [engineering objective](../engineering.json) remains BLOCKED at
  implementation 3/3 and code-review 3/3. This discussion does not retry that
  implementation or reset its counters.
- The [frontend roadmap](../../docs/FRONTEND-ADMIN-ROADMAP.md) records the page
  map and partial historical acceptance results. Its latest user edits remain
  untouched. Recorded failures include root formatting, root WebKit 390px row
  overlap, the V2 skip-link check and Pages visual comparison. Missing
  after-snapshot continuity and unrun dedicated/live gates remain unresolved.
- Orchestrator ran the existing structural `engineering.mjs check`: reported
  `valid: true`, `LEGACY_V1`, `ready: []`, `complete: false`. This is not product
  readiness. Other discussion contributors ran no application acceptance tests.

## Product strategy alternatives

| Alternative                             | Benefit to investigate                                                     | Cost or constraint                                                                   | Recommendation                                                        |
| --------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| Evidence-led private decision workspace | Help the owner inspect, retain and recover reasons for shortlist decisions | Depends on reliable retained facts, honest unknowns and usable existing journeys     | Preferred direction for owner approval                                |
| Portal-style breadth                    | Familiar catalogs, company and market browsing                             | Coverage, identity and rich data are not established; high maintenance for one owner | Keep CS-41 deferred; no portal clone                                  |
| Automation-first assistant              | Reduce repeated searches and follow-up effort                              | Requires source health, identity, freshness and approved delivery semantics          | Keep CS-42/43 exploratory; no scheduling, AI or auto-apply activation |

The intended differentiator is **decision clarity and continuity**, not an
unsupported claim of exclusive functionality or better hiring outcomes. A useful
private workflow can complement existing job portals without replacing their
networks, acquiring their data without permission or copying their branding.

## Competitor evidence and limits

Research Reference retrieved these official public pages on 2026-09-20. These
are statements in public documentation, not tested authenticated workflows.

| Source                                                                            | Retrieved capability                                                                 | Limitation                                                       |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| [LinkedIn Jobs](https://www.linkedin.com/jobs/)                                   | Job-category browsing and public/private Open To Work options                        | No authenticated workflow tested; saved-job specifics unverified |
| [LinkedIn job alerts help](https://www.linkedin.com/help/linkedin/answer/a511279) | Search alerts, daily/weekly email or app delivery, maximum 20 alerts                 | Creation and delivery not tested; availability may change        |
| [Naukri free alerts](https://www.naukri.com/free-job-alerts)                      | Up to five personalized alerts using profile/preferences and search criteria         | Matching quality and delivery reliability unverified             |
| [Naukri FastForward](https://resume.naukri.com/)                                  | Advertised resume/recruiter/job-alert services; no guarantee of interviews or offers | Promotional descriptions, no purchase or outcome testing         |

Security independently retrieved [Teal tracking help](https://help.tealhq.com/en/articles/14435727-how-to-track-your-job-applications)
and [Huntr help](https://help.huntr.co/en/), observing tracking and, for Teal,
personal notes/match information. These adjacent products further weaken any
claim that tracking, notes or match displays alone are novel.

Public visibility is not a license to scrape, republish or automate accounts.
No terms/license review or integration authorization was established. No login,
account creation, application submission or private owner data was used for this
research. Naukri remains legitimate-access only. No portal credentials, cookie
imports, CAPTCHA bypasses or automatic source-link fetching are proposed.

## Existing capabilities to reuse

Internal Research, Backend and System Designer inspected nearby source:

- [Collection](../../v2/apps/workers/search/src/collect.ts) already bounds sources,
  isolates failures, normalizes/deduplicates observations, preserves source
  links and scores against the run's saved matching profile.
- [Collected job contracts](../../v2/packages/core/src/jobs.ts) already validate
  job facts, HTTPS links, source outcomes and nullable match evidence.
- [MatchEvidence](../../v2/apps/web/src/components/match-evidence.tsx) already
  displays dimensions, reasons, skills and confidence warnings. CS-18 is not a
  blank-sheet explanation engine.
- [LeadRepository](../../v2/packages/core/src/leads.ts) already supplies
  owner-scoped reads, duplicate-safe saves, six backend stages, revisioned notes
  and history. The [saved-lead UI](../../v2/apps/web/src/components/saved-leads.tsx)
  currently exposes a narrower saved/archived workflow. CQ-02 remains CS-19.
- [Preparation](../../v2/packages/core/src/preparation.ts) is already bounded,
  profile-based `rules-v1`, not AI or a verified readiness score.

**Important limitation:** the V2 saved-lead payload contains retained job and
match data but does not expose the originating run/profile identity. A saved
date does not establish a scoring date, current fit or identical scoring inputs.
Existing fingerprint saves preserve the previous snapshot rather than silently
refreshing it. These are source observations, not live deployment verification.

Open technical questions remain whether retained data can explain hard-excluded
roles and exactly how approved resume fields reach the matching snapshot. Trace
synthetic examples under CS-33/18 and CS-22/37 before making claims; do not bypass
explicit resume review or invent matching weights.

## Proposed outcomes and experiments

### Existing journey first

The Project Manager proposed a future outcome: inspect retained evidence, save a
role and reopen the unchanged lead after refresh in 5/5 scripted journeys,
including missing facts and duplicate saves. This is a proposed acceptance
measure, not an executed result or a one-week delivery commitment.

Use CS-16/17/18/19 with CS-33's read contract first, CS-6 routing, CS-13 shared
states, CS-14 mobile treatment, CS-35 conflicts and CS-36 session reset as
applicable. Reconcile stale ticket wording against source before implementation;
do not silently amend the existing objects from this discussion.

### C1: bounded saved-role comparison

**Unapproved candidate, not CS-45.** Compare two or three owner-selected saved
roles using retained facts, reasons and existing reads. Preserve selection order;
do not calculate a winner, rescore, add score deltas or order by score. State
that the original scoring context is unavailable unless the contract provides
verified provenance. Only show a specific mismatch when supported by evidence;
never infer it from different save dates. Unknown is not a negative fact.

Preferred architecture to investigate: compose existing owner-authorized detail
GETs and reuse evidence presentation. A bounded batch endpoint is an alternative
only if measured request cost or an agreed consistent-read requirement warrants
it. No new entity, schema, service, library, cache layer or queue is justified
merely by comparison. CS-33 must validate stored projections before consumers
trust them, including malformed records and safe external URLs.

UX's proposed desktop comparison aligns criteria; the mobile candidate groups
by criterion with repeated role labels. A tabbed reference is a possible later
alternative, but the first experiment compares against today's sequential detail
workflow, not against an unrelated prototype. No UI has been built.

**Pre-register a small owner experiment before any benefit claim:**

1. Prepare four matched task pairs (eight tasks), two candidate-first and two
   baseline-first. Each pair has the same information availability and comparable
   difficulty, including unknown facts and missing provenance. Do not repeat an
   identical task as if it were an independent observation.
2. Baseline: sequential role details. Candidate: a paper/static comparison of the
   same supported facts. Start timing when the task is presented; stop when the
   owner records a choice, its rationale and one uncertainty, or at a predeclared
   five-minute limit. Incomplete tasks count as failures, not discarded samples.
3. Freeze an answer key for factual attribution and provenance interpretation,
   not a supposedly correct personal preference. Errors include assigning a fact
   to the wrong role, inventing a profile/run basis or stating unknowns as facts.
4. Proposed advancement threshold: at least three of four matched pairs faster,
   at least 20% reduction in median completion time versus baseline, and zero
   attribution/provenance errors. Reduction is
   `(baseline median - candidate median) / baseline median`. Any incomplete task
   or failed safety criterion aborts the benefit claim.
5. Record all outcomes and order. One owner's small pilot is directional, not
   statistical proof, competitive superiority or production performance evidence.
   Counterbalancing cannot eliminate learning effects. If the candidate adds
   confusion or no useful benefit, defer it rather than manufacture a ticket.

These rules reconcile agents' different 20%/25% thresholds and experimental
comparators into one **proposed**, unrun protocol. Owner approval is still needed.

### C2: decision continuity through existing notes

**CS-19 refinement hypothesis, not a new ticket or schema.** Optional prompts
for reason, unresolved question and next step could make returning to a lead
easier. Preserve ordinary free text, existing content and revision semantics.
The owner can skip every prompt; nothing becomes mandatory. A prompt must not
change stage, submit an application or relabel personal judgment as source fact.

An optional exploratory check uses six synthetic leads, prompted versus ordinary
notes, revisited after 48 hours. Product Discovery proposed recovering rationale
and next step for five of six, fewer detail reopenings and at most 30 seconds of
extra entry effort. These are unapproved measures, not a performance promise.
If ordinary notes work equally well or prompts burden the owner, retain them
unchanged. Failed/conflicting saves must preserve drafts, never imply success.

## Architecture, quality and validation constraints

Retain the deployed V2 modular monolith: Next.js, Fastify, PostgreSQL/Drizzle,
root shared domain packages, existing outbox/queue and API-only encrypted resume
writer. No competing marketplace model or additional infrastructure is proposed.

| Concern                               | Existing owner / proposed check                                                                                                                       |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stored-data validation and provenance | CS-33 before detail/evidence consumption; valid, malformed, missing and foreign-owner fixtures                                                        |
| Session isolation                     | CS-36; logout/expiry during GET, late response after reauthentication, no restored private content                                                    |
| Notes and stages                      | CS-19/35; stale revisions preserve drafts and all supported stages; optional prompts preserve free text                                               |
| Selection and partial failure         | Reject duplicate/fourth selections; identify unavailable roles while preserving valid columns; bounded retry                                          |
| Source links                          | CQ identified two renderers; reuse a small typed renderer only if a third consumer makes duplication material; unsafe URLs never become links         |
| Request lifetime                      | CS-6/33 context; existing Workspace polling needs investigation, not a rewrite; comparison adds no polling/SSE                                        |
| Read budget                           | Proposed maximum one existing GET per uncached selected role, at most three per selection; reject obsolete responses even when cancellation races     |
| Performance                           | No measurements in this discussion; future same-device warm/cold tests and React/network observations before adding batching or optimization          |
| Accessibility                         | Keyboard selection/removal, visible focus, announced state changes, no clipping or horizontal overflow; future mobile/desktop and three-engine checks |
| Operations                            | No comparison-specific infrastructure; inherited CS-3/24/25/30/34 risks remain separate and unclosed                                                  |

Performance suggested provisional feedback within 100ms and interaction p95
within 200ms on a declared reference device, with network completion measured
separately. These are discussion targets, not measured SLAs; a small ten-repeat
sample cannot establish a production p95 guarantee. Visual Designer proposed
contrast, focus, touch-target and 200% zoom checks against the existing design,
not a new palette, font dependency or portal-style feed.

Security identified risks to test, not confirmed cross-owner leaks. No private
resume/profile data goes to external models or competitor services. AI stays
off, auto-apply on hold, signup and scheduling unactivated. Future admin roles,
recovery email and public corpus work keep their separate approval requirements.

## Returned contribution ledger

Each row represents an actual parent-native `runSubagent` invocation that
returned during this discussion. Numbering records round/order of invocation,
not seniority or a majority vote. The exact agent name is the configured name.
Assigned reviewer lists inside tickets are not counted as participation.

| #   | Agent                            | Returned contribution / position                                                                                                                                                                |
| --- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | CareerScope Orchestrator         | Recommended evidence-led workspace over portal breadth or automation; bounded proposal cap; structural check valid but incomplete                                                               |
| 2   | CareerScope Project Manager      | Acceptance-first; future 5/5 result-to-shortlist outcome; no new ticket recommended now                                                                                                         |
| 3   | CareerScope Research Reference   | Retrieved four official competitor pages; alerts are established capabilities; cross-platform friction remains a hypothesis                                                                     |
| 4   | CareerScope Research             | Reuse collection, evidence, leads and preparation; side-by-side comparison considered a distinct extension candidate                                                                            |
| 5   | CareerScope Product Discovery    | C1 new interaction candidate and C2 CS-19 note refinement; suggested falsifiable owner experiments                                                                                              |
| 6   | CareerScope Product Architect    | REVISE: supported facts only, personal judgments separate; journey first and comparison discovery within CS-19                                                                                  |
| 7   | CareerScope System Designer      | Prefer existing read composition; conditional batch alternative; provenance unknown and six backend stages noted                                                                                |
| 8   | CareerScope UX                   | REVISE: comparison candidate within CS-19; criterion-first mobile option; asked per-role versus comparison-level rationale                                                                      |
| 9   | CareerScope Code Quality         | DEBT NOTED: duplicated source links and query lifetime; avoid wholesale Workspace/repository refactor                                                                                           |
| 10  | CareerScope Frontend             | Experiment now, implementation later; CS-19 refinement; partial failures and lead-query expiry need explicit handling                                                                           |
| 11  | CareerScope Backend              | Confirmed missing saved-lead run/profile provenance; favors narrow comparison discovery ticket, not activation                                                                                  |
| 12  | CareerScope Senior Engineer      | Start with approved save/reopen/notes journey; no distinct comparison ticket before owner evidence                                                                                              |
| 13  | CareerScope Visual Designer      | Facts, uncertainty and owner judgment visibly separate; preserve design language; comparison remains optional                                                                                   |
| 14  | CareerScope Security             | REVISE acceptance: ownership, malformed data, session races, note conflicts; no new ticket now; adjacent products weaken novelty claims                                                         |
| 15  | CareerScope Infrastructure       | No comparison-specific infrastructure; acceptance-first; existing operations risks remain open                                                                                                  |
| 16  | CareerScope QA                   | Proposed five-case regression matrix and a separate counterbalanced owner pilot; no tests executed                                                                                              |
| 17  | CareerScope Performance          | Proposed bounded reads and stale-response controls; no measurements; batching only after evidence                                                                                               |
| 18  | CareerScope Documentation        | Approved a separate dated minutes home; preserve canonical scope and distinguish proposals, attribution and decisions                                                                           |
| 19  | CareerScope Repository           | Preserve dirty worktree and roadmap edits; no Git/sprint activation; later authorized writing limited to minutes and append-only log                                                            |
| 20  | CareerScope Release Manager      | Acceptance-only recommendation; W38 freeze unchanged; CS-30 not silently selected; discussion can continue despite release blockers                                                             |
| 21  | CareerScope Agent Operations     | Count only actual returned invocations; retain dissent; all-24 is a one-time request, not a new workflow or loop reset                                                                          |
| 22  | CareerScope Skills Curator       | Existing tools/skills sufficient; no installation, new server, framework or makework ticket justified                                                                                           |
| 23  | CareerScope Independent Reviewer | REVISE: forbid implicit score comparability, preregister pilot rules, preserve optional/free-text notes; corrections incorporated above and assessed by Final Auditor                           |
| 24  | CareerScope Final Auditor        | No scoped content findings; discussion record acceptable, not product readiness; independently checked key state/source claims but could not attest invocation transcripts or byte preservation |

Some delegates cautioned that they personally had not invoked other agents or
verified attendance. Those statements are correct for their isolated contexts;
only the parent owns this invocation ledger. No agent is credited with tests,
edits or peer participation it did not perform.

## Disagreement, decisions and next action

**Unresolved ticket placement:** Research, Product Discovery and Backend regard
C1 as distinct enough for a candidate ticket. Product Architect, UX, Frontend,
Senior Engineer and Security prefer refining/testing CS-19 first; the Project
Manager proposed no additions. The parent recommends testing the hypothesis
before deciding. That is not unanimous approval or authority to broaden CS-19.

**Unresolved rationale scope:** UX asked whether a reason belongs to a lead or
to a comparison. The minimal proposal keeps it per lead in existing notes; a
comparison-level persistent decision would be a different contract requiring
new scope approval. Neither option has been implemented.

**No canonical mutations:** all 44 ticket objects, sprint dates/selection/freeze,
process state and exhausted engineering counters remain unchanged. No new
ticket IDs, completed steps, release version or readiness claim are created.

Recommended next decision for the owner:

1. Retain acceptance-first work under the existing frozen sprint and obtain
   explicit disposition of excess WIP and the separate exhausted objective.
2. After acceptance/design prerequisites, prioritize the existing evidence-to-
   shortlist journey rather than a broad frontend/page programme.
3. Decide whether to run the small C1 paper experiment and optional C2 notes
   experiment. Only useful evidence would justify refining an existing ticket or
   approving a distinct comparison ticket. This is not implementation permission.

Scope remains discussion-only until the owner approves a next action. Authorized
acceptance repairs are distinct from feature activation; red release checks do
not prohibit all discussion or separately scoped repair work.

## Record verification

The parent's draft check passed: 23 distinct returned roles, resolving local
links, Final Auditor correctly pending at that point, and byte-for-byte
preservation of seven protected existing files against a temporary pre-edit
snapshot. Final Auditor then checked content, the 44-ticket distribution, sprint
selection/freeze, process/engineering state and relevant source claims. It
reported no findings, without claiming independent byte-preservation evidence.

Final record checks cover all 24 unique allowlisted roles, local link existence,
formatting, unchanged canonical/roadmap bytes and exact preservation of the
original review-log prefix. These are planning-record checks, not application
acceptance. The append-only parent record is in [review.txt](../../review.txt).
No application, browser, load, deployment or live-provenance test was run by the
parent to create these minutes. Historical acceptance remains historical.
