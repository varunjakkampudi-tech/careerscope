# CareerScope Multi-Agent Engineering System

Permanent specification of the AI engineering workflow. Update this file
whenever the agent architecture changes.

## Current Continuation Capability Record

Reconciled at observed UTC 2026-09-19T23:23:28.657Z: the parent DOES expose real
native `runSubagent` and executed Senior Engineer (three attempts), Documentation
(two passes), QA (three passes) and Independent Reviewer (three loops), in the
sequence recorded in [PLAN.md](PLAN.md). These are parent-native invocations,
not nested coordinator calls. Final independent QA reported 209/209 and scoped
lint/format passing; final Independent Reviewer APPROVED with IR01-IR03 closed.
No model selection was observed. The roster and tool grants are unchanged.

The earlier nested capability limitation below was incorrectly generalized to
the parent. It is historical evidence, not a current session-wide blocker.
Current status remains BLOCKED because implementation 3/3 and code review 3/3
reached policy bounds and acceptance/canonical gates remain incomplete. Actual
native SessionStart, Agent Sessions UI/model selection, final audit and host
provenance remain unverified. This reconciliation launches no additional agents.

### Historical Nested Session Observation (Superseded As Current Status)

Observed 2026-09-19T22:04:49.656Z: this session exposes no native agent invocation
or tool-discovery tool. The configured roster below is unchanged; this is a
session capability blocker, not proof that VS Code cannot invoke agents.
No specialist was invoked, no model inferred, and no permissions expanded.
Autonomous Engineering OS continuation is BLOCKED pending a session with native
allowlisted delegation, serialized QA and fresh independent review. The
Orchestrator's 173 passing focused tests are not specialist review evidence.
See [active task](ACTIVE-TASK.md) and [review log](../review.txt).

Start at [repository-local Copilot engineering](../docs/ai/README.md).
The [agent matrix](../docs/ai/agent-matrix.md) maps fifteen requested roles to
all 24 existing agents and twenty local skills, including exact source files,
tools, evidence, forbidden actions, handoffs and definitions of done.

`node scripts/check-agents.mjs` checks agent configuration, not UI discovery or
product readiness. The new validator's agreed interface and limits are in
[quality gates](../docs/ai/quality-gates.md); its schema belongs to its implementation.

---

## Purpose

One rule justifies the whole structure:

> **The agent that implements a change is never the sole authority that it is
> correct.**

A model reviewing its own work reproduces its own blind spots. It is fluent,
confident, and wrong in exactly the places it was wrong the first time.
Everything else here — the shared state, the bounded loops, the tool
restrictions — exists to make that rule enforceable rather than aspirational.

---

## Agents

Located in `.github/agents/`.

| Agent                | Role        | Model                      | Write access     | Primary responsibility                         |
| -------------------- | ----------- | -------------------------- | ---------------- | ---------------------------------------------- |
| Orchestrator         | coordinator | picker default             | edit + execute   | routing, `.ai/` state, the completion decision |
| Project Manager      | product     | **intended Claude**        | **none**         | what to build, priority, acceptance, GO/NO-GO  |
| Product Architect    | reviewer    | **intended Claude**        | **none**         | requirements, domain model, debt               |
| System Designer      | architect   | **intended Claude**        | **none**         | boundaries, flows, topology, failure modes     |
| UX                   | reviewer    | **intended Claude**        | **none**         | IA, navigation, states, accessibility          |
| Research             | advisor     | picker default             | **none**         | internal investigation before adoption         |
| Research Reference   | advisor     | picker default             | **none**         | current external fact, cited                   |
| Senior Engineer      | builder     | _unresolved_               | edit + execute   | cross-cutting implementation                   |
| Frontend             | builder     | _unresolved_               | edit + execute   | Next.js, React, components, routing            |
| Backend              | builder     | _unresolved_               | edit + execute   | Fastify, PostgreSQL, queues, workers           |
| Infrastructure       | builder     | _unresolved_               | edit + execute   | Docker, Caddy, CI/CD, host                     |
| Visual Designer      | builder     | picker default             | edit + execute   | design system, tokens, imagery                 |
| Documentation        | builder     | picker default             | edit + execute   | docs, and drift between docs and code          |
| Repository           | builder     | picker default             | edit + execute   | git hygiene, branches, tags, releases          |
| QA                   | verifier    | picker default             | **execute only** | runs the real commands                         |
| Performance          | verifier    | picker default             | **execute only** | measures; recommends only with evidence        |
| Security             | reviewer    | **intended Claude**        | **none**         | adversarial security review                    |
| Code Quality         | reviewer    | **intended Claude**        | **none**         | duplication, dead code, complexity, boundaries |
| Independent Reviewer | auditor     | **intended Claude**        | **none**         | tries to prove the implementation wrong        |
| Final Auditor        | auditor     | **intended Claude, fresh** | **none**         | "is this actually complete?"                   |
| Product Discovery    | advisor     | picker default             | **none**         | evidence-backed candidate features             |
| Release Manager      | coordinator | picker default             | edit + execute   | release scope and preparation gates            |
| Agent Operations     | advisor     | picker default             | **none**         | actual failures and bounded recovery           |
| Skills Curator       | advisor     | picker default             | **none**         | capability provenance and risk review          |

Thirteen roles were added beyond the original eleven, each separating a decision
that had been blurred or an artefact nobody owned:

- **Project Manager** decides what and why; **System Designer** decides how it
  should be structured; **Senior Engineer** builds; **Independent Reviewer**
  tries to break it; **Research Reference** supplies current external fact.
- **Visual Designer** owns a design system that did not exist — no tokens, no
  primitives. **Documentation** owns drift. **Repository** owns git and release
  hygiene. **Code Quality** owns maintainability.

Two pairs look like duplicates and are not:

- **Product Architect vs System Designer** — one asks whether the domain model
  is right, the other whether the structure is.
- **Independent Reviewer vs Code Quality** — one asks "does it work?", the other
  "can we keep changing it?". Code Quality is read-only precisely so it cannot
  perform the cleanup it recommends and then grade its own work.

**Visual Designer and Frontend need explicit disjoint file claims to run
together.** The Designer owns assigned tokens, global styles and assets;
Frontend owns assigned components, routes and state. Shared files serialize.

**No agent may expand its own permissions.** Agent/configuration changes need
explicit operator approval, exclusive ownership and review. A missing capability
is not permission to create another agent or install a tool. This setup reuses
the existing roster.

---

## Models — what is actually configured

**Nothing is pinned.** No agent file carries a `model:` key.

Two independent reasons:

1. **GPT-6 Astra is unavailable.** Verified:

   ```
   $ copilot --model gpt-6-astra -p "..."
   Error: Model "gpt-6-astra" from --model flag is not available.
   ```

   It was requested for Frontend, Backend and Infrastructure. No substitute was
   written in, because a silent swap is the thing this workflow exists to
   prevent. The substitution is documented here and in `.ai/DECISIONS.md` D-005
   rather than hidden in a config file.

2. **This roster deliberately leaves model frontmatter unset.** VS Code supports
   `model:` and fallback choices; its absence here is a configuration decision,
   not a platform limitation. Intended-model prose does not select a model.

**Caveat on that evidence:** every identifier probed was rejected, including
`claude-opus-5`, the model this session runs on. The Copilot CLI and the VS Code
picker are different surfaces, so this proves Astra is unavailable _to the CLI_,
not necessarily absent from the picker. Confirm in the picker before concluding.

**Operator responsibility:** inspect the actual picker selection and availability.
The CLI result above is historical, not a current verification or a requirement
to run an external CLI. This native setup requires no paid model API.

---

## Workflow

```
Request → Recon → Research → Architecture → UX → Plan → Review
        → Implementation → QA → Security → Performance → Cleanup
        → Documentation → Architecture Sync → Final Audit → Complete
```

Phases that do not apply are skipped, with the reason recorded.

### Routing — smallest sufficient team

Running all 24 agents on a CSS fix is theatre, and it trains everyone to skim
the output. **This table is not an attendance list.** Each row is the smallest
team that produces the evidence the change class actually needs; four agents is
the working default, and a row longer than that is carrying a specific risk it
names. Skip any agent whose evidence the change does not require, and record
why. Adding an agent "for completeness" is how a review becomes a formality.

The Orchestrator routes every row and is not repeated in the table. Add
**Performance** to any row where the change touches a hot path, a query, bundle
size or worker throughput. Add the **Final Auditor** whenever the change ships.

| Change class                           | Team                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Copy or CSS (no token change)          | UX → Frontend → QA                                                                                                      |
| Design-system or token change          | Visual Designer → UX → QA — Frontend serialized after, never concurrent                                                 |
| Component behaviour                    | UX → Frontend → QA → Independent Reviewer → Final Auditor                                                               |
| New API endpoint                       | Product Architect → Backend → Security → QA → Independent Reviewer                                                      |
| Migration                              | System Designer → Backend → Security → QA → Independent Reviewer                                                        |
| Cross-tier or tooling change           | Senior Engineer → QA → Independent Reviewer                                                                             |
| Refactor, dead code or duplication     | Code Quality → Senior Engineer → QA → Independent Reviewer                                                              |
| Deployment or CI                       | Infrastructure → Security → QA                                                                                          |
| New dependency                         | Research → Security → Product Architect → scoped builder → QA                                                           |
| New skill, extension or MCP server     | Skills Curator → Security → **operator installs** — no agent installs anything                                          |
| Documentation-only change              | Documentation → Independent Reviewer                                                                                    |
| Release cut or deploy execution        | Release Manager → QA → Documentation → Project Manager (GO/NO-GO) → **operator authorises**                             |
| Git, tag, commit or push operation     | Repository → **operator authorises** — no fallback, never delegated                                                     |
| Backlog intake or feature proposal     | Product Discovery → Project Manager → Product Architect                                                                 |
| External or current-fact question      | Research Reference → the requesting agent                                                                               |
| Agent failure, stale state, loop bound | Agent Operations → Orchestrator — recommendation only, never an agent edit                                              |
| Full feature                           | Research → System Designer / Product Architect → scoped builders → QA → Security → Independent Reviewer → Final Auditor |
| System redesign                        | Orchestrator selects distinct specialists from the matrix. **Never "all".**                                             |

Every agent except Performance appears in at least one row, and Performance is
deliberately handled by the rule above the table rather than by a row: it
attaches to any change touching a hot path, a query, bundle size or worker
throughput, which cuts across every class rather than belonging to one. That is
coverage, not a quota: no
change class should activate more than its row names.

#### Disambiguating the six overlapping pairs

These pairs survive the CS-10 retention test but are close enough to be
misrouted. Route by the stated discriminator, not by seniority or availability.

| Pair                                | Discriminator                                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product Architect / System Designer | Is the **domain model** right → Architect. Is the **structure or failure mode** right → Designer. Both only when a change alters model _and_ topology.   |
| Project Manager / Product Discovery | Discovery **proposes**; PM **prioritises and recommends GO/NO-GO**. Never let a proposal reach a release gate without PM.                                |
| Independent Reviewer / Code Quality | "Does it work" → Reviewer. "Can we keep changing it" → Code Quality, and only on refactor, duplication or dead-code work — not every diff.               |
| Research / Research Reference       | "Is it already in this repo, should we adopt it" → Research. "What does the current official doc or advisory say, cited and dated" → Research Reference. |
| Senior Engineer / tier builders     | Squarely one tier → that tier specialist. Cross-tier, tooling or `scripts/` → Senior Engineer.                                                           |
| Release Manager / Repository        | Release **scope, plan, gate and record** → Release Manager. **Tag, branch, commit, push, provenance** → Repository. Neither does the other's half.       |

**Visual Designer and Frontend never run concurrently.** They write the same
tree, and the Designer's stricter rule takes precedence over the matrix's
disjoint-claims allowance until its owner resolves the conflict.

> **Known contradiction — operator action required (CS-10, D-1).** A second,
> divergent copy of this activation table lives in
> `.github/agents/careerscope-orchestrator.agent.md` lines 63–72, and its
> "System redesign → all" row directly contradicts both the table above and this
> file's own "Activate per task — never 'run all agents'" rule; its line 60 also
> still reads "all ten agents" against a roster of 24. The Orchestrator reads its
> own file, so **the contradicting copy is the one that will be obeyed.** No
> agent may edit `.github/agents/`, by design — every permission guarantee here
> rests on tool grants being operator-owned — so this table cannot delete the
> duplicate. The duplicate must be removed by an operator in a reviewed commit
> and replaced with a pointer to this section. Defects D-2, D-7 and D-8 live in
> the same file and are likewise operator-action-required; see
> `.ai/agent-operations.json` for the full record.

## Execution graph

The Orchestrator decides what runs together. One rule governs it:

**Parallel requires independent dependencies and explicit file/resource claims.**
Read-only reviewers can inspect a frozen input together. Independent builders
may run concurrently with explicit approval and disjoint claims. Serialize
shared manifests, generated outputs, state and overlapping files.

QA and Performance have general `execute`; they are not technically read-only.
Isolate their data and side effects or serialize them. A separate worktree does
not isolate a shared database. See [orchestration](../docs/ai/orchestration.md).

Also sequential: anything consuming another agent's output. QA cannot verify an
implementation that has not happened.

```
        ┌──────────────── ORCHESTRATOR ───────────────┐
        ↓                     ↓                       ↓
    ARCHITECT                 UX                  RESEARCH      parallel
        └─────────────────────┼───────────────────────┘
                              ↓
                        IMPLEMENTATION                          claimed writers
                              ↓
                     ┌────────┴────────┐
                    QA             SECURITY                     parallel
                     └────────┬────────┘
                              ↓
                        PERFORMANCE
                              ↓
                       FINAL AUDITOR                            fresh context
```

---

## Handoffs

Only the Orchestrator delegates, using its native `agent` tool and explicit
allowlist. Specialists have `agents: []`. Configuration checks are not proof of
end-to-end runtime discovery. Scripts validate records; they do not schedule agents.

Handoffs name files, content identity, claims, evidence and bounds, never memory.
The briefs below are examples, not invocation syntax or proof that an agent ran:

```
#CareerScope Product Architect  Review .ai/PLAN.md against .ai/REQUIREMENTS.md.
                                Round 2 of 5. Prior findings in .ai/PLAN-REVIEW.md.
#CareerScope Backend            Implement approved .ai/PLAN.md items 1-4.
                                Run validation, report real output.
#CareerScope Final Auditor      Audit the diff against .ai/REQUIREMENTS.md.
                                Fresh context. Verify claims, do not trust them.
```

Read-only agents have no edit tool, so the **Orchestrator transcribes their
actual findings** into the assigned reports. Native subagent calls are distinct
from user-triggered handoff transitions. Agent Sessions/separate worktrees or a
manual fresh chat provide alternatives when available; record the method used.

---

## Tool permissions

| Capability      | Who                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edit`          | Orchestrator; Senior Engineer; Frontend; Backend; Infrastructure; Visual Designer; Documentation; Repository; Release Manager                                                                           |
| `execute`       | those editors, plus QA and Performance                                                                                                                                                                  |
| read-only tools | Product Architect; System Designer; UX; Security; Research; Research Reference; Code Quality; Independent Reviewer; Final Auditor; Project Manager; Product Discovery; Agent Operations; Skills Curator |

Withholding edit and general execute limits those tool operations.
`execute/getTerminalOutput` does not grant shell execution. General execute can
write despite the absence of edit, so QA's no-implementation-edits rule is a
behavioral restriction. Tools and optional preview hooks are not an OS sandbox.

---

## Shared state

**Existing machine-readable records.** These retain their current consumers:

```
.ai/LOOP-STATE.json     phase, active agent, heartbeat, per-agent state, activity
.ai/progress.json       the progress matrix
.ai/findings.json       P0-P3 findings
.ai/references.json     research cache with URLs and access dates
```

**Human projections.** People read these; scripts do not parse them:

`CAREERSCOPE-PROGRESS` · `AGENT-SETUP` · `PROJECT-CONTEXT` · `REQUIREMENTS` ·
`ARCHITECTURE` · `SYSTEM-DESIGN` · `UX-DESIGN` · `DECISIONS` · `ACTIVE-TASK` ·
`PLAN` · `PLAN-REVIEW` · `IMPLEMENTATION-LOG` · `CODE-REVIEW` · `SECURITY-REPORT` ·
`PERFORMANCE-REPORT` · `QA-REPORT` · `FINAL-AUDIT` · `DOCUMENTATION-AUDIT` ·
`CLEANUP-REPORT` · `review.txt`

The product backlog remains canonical for priority. The approved new
`.ai/engineering.json` is an execution projection, with policy in root
`quality-gates.json`; neither replaces legacy consumers by implication. Its
exact schema is owned by the delivered validator. Do not invent fields here.
Append content-bound snapshots to `review.txt`, never replace its history.

Do not assume a validator reconciles every projection or detects every secret.
Keep secrets out at collection time. Structured validation must fail on missing
required or malformed data rather than reading it as empty success.

---

## Skills each agent should consult

Twenty skills are already installed in `.github/skills/`. Nothing needs
installing; agents need to know which apply to them.

| Agent                | Skills                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| System Designer      | `careerscope-architecture`, `careerscope-outbox-queue`, `careerscope-job-discovery`                                                                                |
| Product Architect    | `careerscope-architecture`, `careerscope-job-matching`                                                                                                             |
| Backend              | `careerscope-outbox-queue`, `careerscope-resume-storage`, `careerscope-job-discovery`, `careerscope-job-matching`, `postgres-best-practices`, `drizzle-orm-expert` |
| Frontend             | `react-best-practices`, `design-taste-frontend`, `accesslint-audit`, `nextjs-seo-indexing`                                                                         |
| Visual Designer      | `ckw-design`, `emil-design-eng`, `baseline-ui`, `design-taste-frontend`                                                                                            |
| UX                   | `accesslint-audit`, `ckw-design`                                                                                                                                   |
| Infrastructure       | `careerscope-deployment`, `container-security-hardening`                                                                                                           |
| Security             | `careerscope-security`, `container-security-hardening`, `audit-skills`                                                                                             |
| QA / Performance     | `careerscope-verification`                                                                                                                                         |
| Independent Reviewer | `careerscope-verification`, `phase-gated-debugging`                                                                                                                |
| Senior Engineer      | `phase-gated-debugging`, plus whichever domain skill the change touches                                                                                            |
| Code Quality         | `careerscope-architecture` (for boundary ownership)                                                                                                                |

The `careerscope-*` skills carry the invariants that are easiest to break.
Consult the relevant one **before** changing that area, not after a reviewer
finds the breakage.

### Agents do not install skills

**No agent installs a skill, plugin or extension on its own.** A skill can carry
scripts, remote execution and destructive commands; installing on the strength
of a name is a supply-chain decision made by something that cannot be held
responsible for it. Installing a catalogue wholesale is worse.

When an agent needs a capability nothing covers, it says so and stops. The
operator then finds the smallest relevant skill, reads it and its resources in
full, checks for scripts and remote execution, rejects anything conflicting with
the engineering contract, installs it project-scoped and pinned, and records
why. `audit-skills` exists for exactly this review.

---

## Loop limits

```
PLAN_REVIEW_MAX     5
SYSTEM_DESIGN_MAX   3
IMPLEMENTATION_MAX  3
CODE_REVIEW_MAX     3
SECURITY_MAX        2
PERFORMANCE_MAX     2
FINAL_AUDIT_MAX     2
```

Reaching a limit sets `BLOCKED` with the unresolved findings preserved. It never
becomes `COMPLETE`. A bound that can be exceeded is not a bound.

---

## Completion criteria

Requirements and acceptance criteria met · no open P0 or P1 · P2s fixed or
explicitly justified · all applicable checks pass with inspected current-content
evidence · accessibility and smoke checks where applicable · docs and architecture
current · ownership-clean diff · actual independent review passed. A completion
label records that decision; it is not its proof. `check` is not `ready`, and
`verify` must refuse without all applicable evidence and independent review bound
to the current content. See [quality gates](../docs/ai/quality-gates.md).

None of these is completion: a zero exit code, an output file existing, a model
saying "done". On this machine `claude auth status` exits **0** while reporting
`loggedIn: false` — the trap is live in the first command anyone runs.

### Evidence must cite the consumer, not only the deliverable

**For any ticket whose deliverable is consumed by another file, the evidence
must cite the CONSUMER, and the consumer's own consumer, until it reaches
something that actually executes.**

The second clause was added on 2026-09-25 after a re-review applied the
original rule to CS-31 and found it only half-satisfied. The first hop was done
well — deliverable `authenticated-shell.tsx`, consumer `check-ui.ts` cited by
file and line, with the previous wrong citation named. That hop is exactly what
turned a "verified" claim into a REVISE. But the second hop was missing:
`check-ui.ts` is itself consumed by `test:ui`, which is consumed by `ci.yml` —
and CS-31's evidence never mentioned that `test:ui` ran in **no** workflow
until CS-15 wired it, nor that it is still not CI-executed. CS-31 silently
inherited CS-15's unproven status.

The justification is decisive: **both of the worst findings in this project sat
at the second hop, not the first.** CS-15's evidence claimed CI enforcement for
a suite no workflow invoked, and CS-10's D-1 disclosed a contradiction in the
very file that defeats it. Stopping at the first consumer would have caught
neither.

This rule was earned, not invented. A third independent reviewer found the same
shape in four unrelated tickets on 2026-09-25 and named it: _"the artefact is
correct and something one step downstream of it is stale or unproven. Each
ticket verified its own artefact thoroughly and its consumer not at all."_

- **CS-10** — the canonical activation policy is right; the copy the
  Orchestrator actually obeys is wrong.
- **CS-15** — the accessibility check is well built; it enforced WCAG 2.1 while
  its criterion says 2.2.
- **CS-47** — the scheduler checker is the best-constructed check in the
  repository; no host has ever run it.
- **CS-48** — the AI provider is correct and fail-closed; the UI directly above
  it renders "AI inference off" while AI is on.

Two of the worst defects found in this project are instances of this rule being
absent: CS-15's evidence claimed CI enforcement for a suite that ran in **no**
workflow, and CS-10's D-1 disclosed a contradiction in the very file that
defeats it. In both cases the deliverable was inspected and its consumer was
not.

So: writing a check is not evidence that anything runs it. Writing a policy is
not evidence that the thing which reads it agrees. Writing a provider is not
evidence that the screen above it tells the truth. Follow the chain to
something that executes — or record plainly where you stopped and why.

### Never assert absence without first proving the surface loaded

**An absence check must be preceded by a positive anchor proving the surface
actually rendered, as the identity you expect.** `count() === 0` is true on a
blank page, a crashed page, a page still loading, and a page where your locator
is simply wrong. By default, every "X is not present" browser assertion has this
failure mode.

Found on 2026-09-25 while writing the CS-36 cross-session test: five routes
asserted the previous owner's data was absent, with nothing established first.
Every one would have passed against a page that had not finished rendering —
and the test would have "proven" session isolation while looking at nothing.
The fix was to require something belonging to the _new_ owner on each route
first (their own run title, their own lead, or that route's real empty-state
text), so the absence checks cannot be reached until the page has genuinely
loaded as that identity.

This is the seventh instance of the check-that-cannot-fail class found in one
night, and the one closest to home: it was in a test written _to_ close a
coverage gap, by someone who had spent the day finding exactly this defect in
other people's work.

**The same rule in its most transferable form — pair every negative with a
positive on the same surface, in the same test.** It is not only a browser
problem. An isolation test asserting that a foreign owner's read returns no data
**passes trivially against a query that is broken for everybody**. The negative
alone cannot distinguish "correctly denied" from "returns nothing to anyone",
and those are opposite outcomes: one is the control working, the other is the
feature dead.

So the owner's _own_ read must succeed in the same test that proves the foreign
one fails. Applies to owner isolation, permission checks, filters, soft-delete,
and anything else whose success condition is that something is missing.

> A negative assertion measures a difference. Without a positive on the same
> surface you have measured one side of it and assumed the other.

### For dev/production differences, the production run IS the verification

**For anything that behaves differently between a dev server and a production
build, running against the production artefact is not a verification step. It
is the verification.** A dev-server green is not merely weaker evidence — it can
be _actively misleading_, because it exercises a code path that does not exist
in the thing that ships.

The worked example is CS-54, 2026-09-25, and it is the closest this project has
come to shipping a broken application.

A nonce-based CSP replaced `script-src 'unsafe-inline'`. It passed local
typecheck, lint, the full browser suite on **all three engines**, and a
correctly-constructed negative assertion that genuinely asserted the _absence_
of `'unsafe-inline'` rather than the presence of its replacement. By every check
available to the person who wrote it, it was finished.

Against a production build it broke the application completely. `next build`
prerenders these routes to static HTML; that HTML is generated at build time and
cannot carry a per-request nonce. The measurement: **10 `<script>` tags, 0
`nonce=` attributes**, while the response header advertised a nonce. Because
`'strict-dynamic'` makes the nonce authoritative and causes `'self'` to be
ignored, none of those scripts could execute and the page never hydrated.

The only thing between that and production was a reviewer reading an acceptance
criterion — _"works with the App Router in production, not only in
development"_ — carefully enough to treat it as a requirement rather than
decoration, and refusing a ticket whose own evidence disclaimed it.

**That is the answer to "why not just promote it, the tests are green." The
tests were green.**

Two corollaries worth keeping:

- **Run the cheapest disconfirming test first.** The production build took ten
  minutes and killed the approach outright. Refinement work done before it —
  the nonce-uniqueness assertion — was effort spent on something already dead.
- **When the approach dies, reopen the ticket rather than relabelling it,** and
  do not assert the remaining weakness away. Reducing the check to what is
  currently true and leaving the gap open is honest; writing a check that
  blesses the current state is a validator made green by reinterpreting the
  condition it exists to enforce.

### Assert your preconditions before any scripted write

**Before a script edits a file, assert that what it expects to find is actually
there.** Then verify the write landed. This applies to _any_ scripted edit — a
falsification mutation, a revert, a bulk migration, a cleanup.

**The danger is not a weak proof. It is a confident wrong answer.**

A check that cannot fail tells you nothing. **A mutation that did not apply
tells you the opposite of the truth** — and hands you a real command with a real
exit code to support it. A _cleanup_ that wrote the wrong range is worse still:
it corrupts the file and then shows you a plausible green suite.

Four saves on 2026-09-25:

1. A PowerShell regex replacement matched nothing; the suite then ran **green**.
   Reported as written, that green run would have read as "reinstating the
   refusal fails the test" — the reverse of what happened. Caught by noticing
   the echoed `Set` literal was unchanged.
2. A Python quoting error inside PowerShell meant a `rel="noopener noreferrer"`
   removal never applied. Caught before the suite ran, because the printed line
   still showed `rel` present.
3. **The one that inverts a conclusion.** Testing whether the new
   `{ what, detail }` contract made a bare error message unrepresentable, the
   mutation silently failed to apply and `npm run typecheck` returned **exit
   0**. At face value: _the bare message compiles, therefore the contract does
   not work._ The finding would have been reported as **failed**, backed by a
   genuine command and a genuine exit code — evidence that looks stronger than
   most of what gets accepted, and precisely backwards. The contract does work;
   a correctly-applied mutation produces `error TS2322` and exit 2.
4. **The one outside falsification entirely.** A _revert_ script asserted its
   end anchor contained `waitFor();`, found `page.goto` instead, and **refused
   to write** — preventing an off-by-one that would have deleted 70 wrong lines
   from `check-ui.ts`. Nothing would have flagged it: the file would still have
   compiled, and the suite would still have gone green with coverage silently
   removed.

Cases 1 and 2 are _absence_ of evidence — you learn less than you thought.
Case 3 **inverts** it. Case 4 **destroys work while looking clean**.

The cheapest sufficient habit: after writing, print the changed line; after
reverting, print it again. Prefer a script that asserts its own precondition
(`assert s.count(TARGET) == 1, "nothing to change"`) over a find-and-replace
whose failure is silent. Every one of the four near-misses above was a silent
find-and-replace.

> **Formatting runs between write and match.** Prettier reformats in this repo,
> so a multi-line expression can collapse onto one line _after_ you write it and
> _before_ a later script tries to match it. This has invalidated an exact-match
> anchor three times, including once while editing this very section. Re-read
> the file immediately before matching against it, rather than matching against
> what you believe you wrote.

### Re-read acceptance criteria cold, not through the finding

A fix round narrows attention to the defect that was found, and **the criteria
nobody is arguing about are where the next gap sits.**

CS-31 is the proof. The contested finding (CS31-1, a skip-link contract that
would have stayed green with `tabIndex={-1}` removed) was fixed correctly and
survived four separate attempts to make it vacuous. The ticket still could not
be promoted, because a completely different criterion — AC3's "and a narrow
mobile viewport" — was literally unmet, and nobody had looked at it on either
side of the review.

Before fixing a REVISE, re-read every acceptance criterion from the ticket
itself, not through the lens of the reviewer's finding. Check all of them.

### A reproduction that shares the original's definition tests arithmetic, not truth

CS-13's F-4 census defined "async-bearing" as _imports
`useQuery`/`useMutation`/`useInfiniteQuery`_. A second party re-derived the
count independently, got **9, 8 and the same excluded ninth** — an exact match,
first try — and it was reported as confirmation.

It confirmed nothing. Both runs used the **same proxy**, so both inherited the
same blind spot: `account-security.tsx` imports only `useState` while making two
real network calls by hand, so it was excluded _correctly by the stated rule_
and wrongly in substance. The proxy and the property had come apart, and
agreeing arithmetic could not reveal it because the arithmetic was never wrong.

> When re-deriving someone's figure, **re-derive the definition first.** If you
> accept their proxy you are checking their spreadsheet, not their claim.

The corrected proxy was "makes a network call" — by any means, not by one
library's hooks.

### A text-matching census must strip comments, and must self-test the stripper

Immediately after the above, the corrected census produced a _new_ wrong answer:
`account-security.tsx` started matching the **old** proxy, because the comment
written to explain the old proxy contained the words
`useQuery/useMutation/useInfiniteQuery`. The measurement matched its own
documentation.

With comments stripped, the original census's membership did not reproduce at
all: two of its nine members showed no async evidence under any of four tests.

Two rules follow, and the second is the one that is usually skipped:

1. Strip comments before matching source text, or the census measures prose.
2. **Prove the stripper works before trusting a single count** — it must remove
   a commented-out hook _and_ leave a real call intact. A stripper that silently
   does nothing returns the uncorrected numbers while looking corrected, which
   is case 3 of the precondition taxonomy in a new costume.

### This repository has a systematically elevated grep false-positive rate

Twice in one night a single-line grep match turned out to be **inside an
explanatory comment**, and each time it produced a finding that evaporated on
reading four lines of context:

- `cache.clear()` at `authenticated-shell.tsx:35` — inside a note explaining
  which _other_ paths call it, producing a phantom fourth occurrence.
- `useQuery/useMutation/useInfiniteQuery` at `account-security.tsx:20` — inside
  a note explaining why the old census proxy excluded that file, which made the
  file match the very proxy it was documenting.

This is not bad luck. **This codebase documents its reasoning inline, and that
reasoning quotes the exact identifiers someone would later grep for.** The habit
is good and must not change — those comments are why the `origin` exclusion and
the block-variant fix will survive a future refactor. But the consequence is
structural:

> A bare grep over this repository has an elevated false-positive rate **by
> design**. Read the surrounding lines before treating any single-line match as
> evidence, and strip comments before counting anything.

Same family as the rest of these rules: a check that looks authoritative while
measuring the wrong thing.

**Third instance, and it is the sharpest shape of the three.** A grep for
`titles.length` was run to confirm how a finding had been fixed, hit that
pattern in a _different_ assertion in a _different_ test, and the hit was
reported as the fix — **without reading the surrounding lines.** The real fix
was stronger than the one described: `toContain('Principal Platform Engineer')`
rather than a length check, under a comment beginning _"THIS ASSERTION IS THE
TEST"_ that explained the vacuity in five lines. It was there to be read.

> **Searching for a pattern and then offering the pattern you searched for as
> evidence is confirmation by construction.** The grep did not discover the
> fix; it discovered the thing you asked it to find. What distinguishes the two
> is reading what surrounds the hit.

The damage here ran in the _favourable_ direction — the code was better than
reported — which is precisely why it would have survived review. A description
weaker than the implementation invites someone to later "simplify" the code
down to the description.

**Fourth instance, and it is the exact inverse — a NON-match treated as
evidence.** A grep of `check-pages-ui.mjs` for `near-zero` returned nothing, and
that absence was almost reported as _"the misleading comment has been fixed"_.
It had not been. **The phrase is split across a line break** inside a wrapped
comment:

```js
// ... Perceptual comparison at a near-
// zero tolerance catches real regressions ...
      { threshold: 0.1 },
```

Unwrapping the comment continuations before searching finds it immediately, and
the file's mtime showed it had not been touched in weeks.

> **A line-oriented search cannot see a wrapped phrase. Absence of a match is
> not evidence of absence.**

This codebase wraps comments at roughly 75 characters, so **any multi-word
phrase in a comment can straddle a line and vanish from a line-oriented
search** — and the phrases most worth searching for are the explanatory ones,
which are exactly the ones long enough to wrap.

These two are one rule seen from both sides: **a match is not a finding until
you read around it, and a non-match is not a finding at all.** When the question
is _"was this changed?"_, the answer comes from the file's history or its mtime
— never from a search that found nothing.

**Which tools inherit the blind spot is itself checkable, and worth knowing.**
`check-promotion-evidence.mjs` and `check-checks-registry.mjs` normalise
whitespace before matching and are immune. Line-oriented gates are not — and
**CS-65's entire defect was a line-oriented check that never looked at the file
in question.** The composed practice: _read around a match; distrust a non-match
from a line-oriented tool; and prefer tools that normalise before they match._

**And whitespace normalisation is necessary but not sufficient for _code_
comments** — learned by having the recorded remedy fail:

```
raw                 no match
whitespace only     NO MATCH     ← the remedy recorded above
strip // then ws    MATCH
```

A wrapped **line comment embeds its own continuation marker mid-phrase**:

```
`parsed.text` never // leaves Postgres for this query
```

Joining the lines leaves `// ` sitting between the words. **Strip comment
markers as well as whitespace.** The fix that works on wrapped prose does not
work on wrapped code comments — and this is the second time the same phrase
class has cost a read, having already produced the `near-`/`zero` miss.

### A count is a measurement

A registry was reported as having 45 entries. It has 44. The correction that
followed is the part worth keeping, in its author's own words:

> _"I wrote 'I counted the registry array: 45 entries.' I did not count it. I
> eyeballed a long array and reported a number as though it were measured."_

Three separate counts tonight came in under the machine count — 15 against 43,
28 against 43, 45 against 44 — and every one was offered in the grammar of
measurement.

> **Reporting a count you did not take is the same act as reporting a check you
> did not run.** If a number appears in a finding, something must have produced
> it: a command, a script, a length. "About" and "roughly" are honest; a precise
> figure you estimated is not.

**And correcting a form is not re-taking the measurement.** Ten tickets carried
_"All applicable criteria met"_ — a claim that **cannot fail**, because an unmet
criterion can be reclassified as _not applicable_ without editing a number. The
phrase was replaced with the counted form on all ten in one edit, with an honest
note that the criteria had not been re-verified.

**Two of the ten were wrong, and both were found within minutes** — CS-74's AC3
was half-met, CS-52's AC4 unmet. The correction had made them _findable_; it had
not made them _right_.

> **A counted claim over an uncounted criterion is no better than the hedge it
> replaced.** It is only more falsifiable — and falsifying it is then the work,
> not an optional follow-up.

Two further details, because both nearly hid it:

- **A caveat recorded in `evidence` does not qualify a claim made in
  `currentStep`.** The note saying "this does not re-verify the criteria" was
  true, visible, and in the wrong field — nobody promoting a ticket reads that
  far. The eight outstanding tickets now say _"COUNT NOT YET RE-TAKEN"_ **in the
  status field itself**.
- **CS-52's wrong count came from a phrase that was true.** _"Both halves
  complete"_ correctly described the structural and systemic halves — and AC4
  was a **third** thing. A summary that is accurate about what it covers is
  still misleading about what it omits.

### A glob that under-matches produces a plausible wrong total

Counting the CS-61 guard sites with `components\*.tsx` and `app\**\*.tsx`
returned **10 call sites and 10 guards**. The real figure is **16**. The glob
silently missed `app\(app)\dashboard\page.tsx` — **six sites in the single
largest consumer** — because the Next.js route-group directory name contains
parentheses.

**A 37% undercount, and the 10:10 agreement looked like corroboration.**

Two distinct hazards, and the second is the one that keeps recurring:

1. **Parenthesised path segments are a live hazard in this repository
   specifically.** The `(app)` route group is where most of the web code lives,
   and it is exactly what many glob implementations and shell quotings drop.
   Enumerate recursively with `readdirSync` rather than trusting a glob when the
   answer is a count.
2. **Matching totals are not correspondence.** 10 and 10 agreed and were both
   wrong, because both came from the same under-matching enumeration. **Only a
   per-file breakdown made the answer trustworthy** — the same distinction that
   made the CS-13 census proxy worthless even though two parties independently
   reproduced its number.

> **When two figures agree, check they were not produced by the same mistake.**
> Agreement between measurements that share a method is not independent
> confirmation; it is the method confirming itself.

### With concurrent writers, a red build is only evidence when the writers are idle

A `v2 typecheck` failure was observed mid-edit — three call sites using
`ownerKey(owner, …)` with neither symbol yet in scope in that file. It was a
rename in progress, not a defect, and the reporter checked file mtimes before
raising it rather than after.

This belongs beside _"differs from HEAD carries no information when everything
is uncommitted — the question is always differs how."_ Both are cases where **an
ordinarily reliable signal is uninformative in this specific operating mode**,
and reading either naively produces a confident wrong answer.

### Reconcile the file set before reconciling the finding

Two censuses disagreed, 9 against 11, and neither was wrong — one scanned
`.tsx`, the other `.tsx` plus `.ts`. Including `.ts` adds `lib/api.ts`,
`lib/api.test.ts` and `lib/session.ts`: the fetch wrapper, its test, and a
helper. None render UI states, so all three sit correctly outside a _component_
census and the extra count meant nothing.

**Most census disputes are a glob difference wearing the costume of a
substantive one.** Compare the file sets first; it is cheaper than arguing about
the conclusion.

### Unrepresentability must be verified against the type system that implements it

This one inverts the principle the rest of this file keeps recommending. Nine
times today the strong move was _"make the bad state unrepresentable"_ rather
than _"write down a rule someone must follow"_. CS-42's exclusion of `origin`
from stored saved-search criteria was logged as the sixth convergence and the
only **preventive** one — a defect removed before it could be written.

It was also the one instance where **the mechanism did not deliver the intent.**
The document stated two things that cannot both be executed: that `criteria` is
`CreateSearch` _minus_ `origin`, and that it is validated by _reusing_ the
pipeline schema rather than copying it. `origin` is
`.optional().default('manual')`, and a Zod `.default()` **fires on `undefined`**
— so reuse does not leave `origin` absent, it **adds** it:

```
input keys : query, sources
parsed keys: origin, query, sources     <- injected, "manual"
```

An implementer following the document literally would have stored `origin` on
every saved search — the exact execution authority the document forbade two
paragraphs earlier. The design asserted the property in prose and the schema
underneath silently reintroduced it.

> **Stating that a state is unrepresentable is a claim about a type system, and
> claims about type systems are testable.** Parse a fixture and look at the
> keys. Until you have, "cannot be expressed" is prose, and prose does not
> constrain an implementer who reuses the schema you told them to reuse.

The fix was one clause — `createSearchSchema.omit({ origin: true })`, a
derivation rather than a copy, so the no-drift argument survived. And the check
on the fix needed its own positive control, because "it omits `origin`" is
equally true of a schema that validates nothing:

```
with .omit({ origin: true }) -> origin present: false
derived schema still rejects extra keys (.strict): true
derived schema still rejects duplicate sources    : true
```

### A criterion can encode its own falsification and still be void

CS-61's AC3 was praised here for encoding its own falsification: _"with every
reset deliberately disabled, a second owner must still not receive the first
owner's cached data."_ That praise was premature.

The criterion named what to disable and never named what the **test must not
do**. Four previous attempts had already failed because the test navigated with
`page.goto()` — a full document load that destroys an in-memory cache
unconditionally — and AC3 did not exclude it. The obvious fifth attempt passes
with owner-scoped keys, passes with owner-agnostic keys, and passes with every
reset disabled. The navigation does the work and the assertion cannot tell.

> **A falsification needs its constraint as well as its condition.** "Disable
> the mechanism and observe" is void if the harness independently destroys the
> state you were going to observe. State the constraint — and pair it with a
> positive control that must FAIL when the fix is reverted, because that control
> is the only thing proving the experiment could ever have seen the defect.

### When a ticket changes state, the summary changes tense

`summary` is rendered by the Control Centre tile and by any digest, so it is a
**status-bearing field** — but nothing maintains it as one, and it drifts in
both directions:

- **CS-38** kept `summary: "Closed … everything else already verified"` after
  `currentStep` had been honestly corrected to say the guard was reverted. The
  highest-visibility field carried the exact claim a reviewer had blocked on.
- **CS-50** kept a summary describing the work as _"its own pre-design ticket"_
  while the ticket sat in UAT with a built, reviewed route. **The board
  described shipped work as not yet designed.**

Under-reporting is the safer direction, but the defect is the same: a field
people read as status that nobody updates when status changes.

CS-34 is the model to copy — _"Fixed and verified locally (2026-09-24)… not yet
deployed, per the ticket's own explicit constraint."_ Tense, date, and the
limit, in one line.

### Before promoting, ask the mechanical question

Three UAT tickets were demoted in one audit, and **all three failed the same
way: an acceptance criterion the ticket's own records showed was unmet.** Not
one was a defect in the code.

- CS-14's AC4 required screen-reader operation _"verified not assumed"_, while
  `KNOWN-LIMITATIONS.md` recorded screen readers as `OPEN — HUMAN VALIDATION`.
- CS-17's AC4 required a dismiss action its own evidence said had no schema.
- CS-50's AC1 required an _owner-confirmed_ decision recorded as made with a
  non-owner reviewer.

> **Promotion must ask: does any acceptance criterion have a recorded unmet
> status, anywhere in this repository?** That question is mechanical. It needs
> no reviewer, no judgement and no shell, and it would have caught all three.

The failure was never a shortage of evidence — each ticket had written the
disqualifying fact down itself. It was that **nothing in the promotion path
read what the ticket already said.**

### A red result needs its cause identified before its significance is asserted

This is the same family as the mutation taxonomy above, arriving from the
opposite direction. Case 3 was _a mutation that did not apply inverts your
conclusion_. This is **a failure whose cause you have not identified will invent
its own conclusion, and yours will sound reasonable.**

`engineering:test` went red: 215 tests, 210 pass, 5 fail, in
`engineering-runner.test.mjs`. A coherent story assembled itself immediately —
the suite is broken, it is chained into `gates:test`, the committed `gates:test`
does not include it, **therefore the first commit arms a red suite and fails the
first pipeline run of the entire body of work.** That was escalated to the owner
and an instruction to fix the suite went out.

The one command nobody ran first was the child the runner spawns:

```
node --test --test-isolation=none --test-reporter=tap scripts/engineering.test.mjs
  → bad option: --test-isolation=none      exit 9
```

The child dies before emitting a byte of TAP. **The test was correct and was
failing for exactly the reason `ci.yml` describes it as existing** — refusing to
report totals it cannot substantiate. Had the fix instruction been followed, the
one guard in this repository that refuses to report unsubstantiated totals would
have been weakened, on the night fifteen checks that could not fail were
catalogued.

> **"It is failing" and "it is failing _because_" are different claims, and only
> the second supports a recommendation.** A red result with an unidentified
> cause is not evidence for anything yet — least of all for changing the thing
> that went red.

What it had actually detected: `engines.node` is `>=24.0.0`, `.nvmrc` is `24`,
CI uses `24`, and **every local verification in this run executed on v22.23.2**.
One suite noticed, incidentally, by using a newer flag. **A version floor that
only one test enforces is a floor that is not enforced** — CS-74.

**And the paired positive is what finished it.** The negative alone
(`bad option`) proved the flag was rejected; it could **not** distinguish _wrong
flag name_ from _broken test file_, and the honest conclusion still available at
that point was "something is wrong with this suite" — which is exactly how the
first escalation went wrong. Running the other spelling on the same file in the
same session settled it:

```
--test-isolation=none               → bad option
--experimental-test-isolation=none  → # tests 159 · # pass 159 · # fail 0
```

The flag was added in Node v22.8.0 as `--experimental-test-isolation` and
renamed to `--test-isolation` in v23.6.0; v22.23.2 sits inside that window. CI
runs 24, past the rename, so **the five failures cannot occur there.** The
suite was never broken — it is the only thing in the repository that noticed the
runtime was unsupported.

> **Pair the negative with a positive on the same surface applies to your own
> diagnosis, not only to other people's tests.** A failing command tells you
> something failed. Only the control tells you _what_.

This rule has now prevented two wrong conclusions in one evening — a schema
reproduction that failed for an unrelated validation error and would have read
as confirming an absence, and this. Both were coordinator-side, not
reviewer-side, which is the point: **the rule is not a thing you enforce on
others.**

### A false warning about a method is worse than a false bug report

One wastes a check. The other degrades **every future check**.

A warning went out tonight that **"mtime may be unreliable on this tree —
verify by content."** It was withdrawn by the session that sent it, after it
falsified its own hypothesis: the file it thought it had re-read at 18:14 was
**untracked**, so no worktree copy existed to be stale. The real cause was
that the file grew 589 → 622 lines when the duplicate was removed at 17:51 —
**and the reporter had cited an earlier read rather than looking again.**

> **"mtime was correct the whole time. I was the stale copy."**

The retraction matters more than the fault. **"Verify by content, the
timestamp may lie" sounds like extra rigour**, so it would have been adopted
without argument — making everyone slower while discarding a check that works,
and one that had already prevented a wrong conclusion earlier the same
evening.

Note the asymmetry that makes this dangerous: **a claim that makes a process
more cautious gets less scrutiny than one that makes it less cautious.** That
is the same mechanism as the five exemption phrases — a plausible sentence
that silently changes how things get graded — running in the opposite
direction.

**Before reporting an instrument unreliable, run the positive control that
distinguishes a broken instrument from a true negative reading.** Here that
was two writes to a probe file in the same directory, confirming mtime
advances. _"The measurement looks wrong"_ and _"the thing did not happen"_
produce the same surprise.

And the underlying error was not about timestamps at all: **a defect was
reported that had already been fixed, because the reporter reasoned from
memory of a file instead of from the file.** That is precisely the failure
this document catalogues in tests — an assertion describing a past state that
is never re-evaluated. **Re-read at the moment of flagging.** It costs one
command.

Keep both directions of it together, because they happened between the same
two sessions within an hour: one nearly filed a P1 against a **two-minute
intermediate state read mid-write**; the other reported a defect that **had
already been fixed, from a read it did not repeat.** Same root — a timestamped
observation treated as current.

### A delta between two measurements is not evidence of a cause

The companion to the rule below, and it failed in the opposite direction.

Type diagnostics went 56 → 24 → 15 and I recorded **"−41, the `origin` fix"**
in `review.txt`. Wrong. Another session added `lib: ["ES2024","DOM"]` at
18:17:14, **between the two measurements**. The real split is **−32** from
`origin` and **−9** from the lib setting.

**I did not catch it. The session that made the change did, and declined the
credit** — _"attributing them to me would have been wrong."_

> **With concurrent writers, the unit of attribution is the interval, not the
> change you happen to know about.** Before claiming a delta, ask what else
> touched the tree between the two readings.

Note the symmetry with the near-miss below: there I nearly blamed another
session for a defect it had already fixed; here I credited a collaborator with
someone else's improvement. **Both come from treating a timestamped
observation as if it were isolated.**

### A fix that fails for an unexpected reason is an observation

The prescription for CS-77 was _"type the parameter as `z.input` — one type,
not 36 call sites."_ Applied alone it **moves the error into production
code**: `database.ts(63,10) TS2769`, because `searches.request` is
`$type<CreateSearch>()`, the output type.

That unexpected error was the only thing that revealed the real coupling —
`request` is **stored** and must carry `origin`, and `requestHash` is computed
over a value whose `sources` carries `.transform(sort)`. Without the parse
moved inside, **an unsorted and a sorted spelling of one request hashed
differently and collided as a false `IDEMPOTENCY_KEY_REUSED`.** A caller
passing `['himalayas','remoteok']` was told their request already completed
with different details.

**A real behavioural bug, found only because a half-right fix failed for a
reason nobody predicted and the failure was investigated rather than worked
around.** The instinct to reach for a cast at that moment discards the
observation — and here it would also have traded a type error in tests for a
**data defect in storage**, with the type checker then silent about it.

### Before designing a fix, look for the sibling that already solved it

Third time in one evening:

| Gap                            | Sibling that already solved it               |
| ------------------------------ | -------------------------------------------- |
| no v2 test typecheck           | root `tsconfig.test.json`                    |
| `CreateSearch` typed as output | `jobs.ts:5` `CollectedJobInput = z.input<…>` |
| severity cells hand-written    | the same file's own generated rows           |

The `jobs.ts` case stings most: **the correct pattern was one file away and
already in use for a caller-facing parameter.** `commands.ts` simply did not
follow it.

And the survey around it is worth as much as the fix — **37 `z.infer` types
enumerated, every parameter position checked, input differs from output in
exactly two schemas**, one of which was already correct. `createSearch` was the
only instance. **A bounded negative is a result.**

### With concurrent writers, a bad read is more likely than a bad file

**This rule was learned on `.ai/backlog.json` and not generalised, and that
omission nearly cost another session's trust.** At 18:12 a read of
`v2/packages/core/src/database.ts` showed

```ts
const request = input as CreateSearchInput as ReturnType<typeof createSearchSchema.parse>;
```

— a double type assertion beneath a comment saying **"PARSED HERE"** and
twenty lines explaining why canonicalisation matters. The finding wrote
itself: a cast changes no value, so `origin` is not defaulted and `sources`
not sorted; worse, the cast **deletes the `$type<CreateSearch>()` compile
guard that the comment itself names**. It was graded P1.

**It was never filed, because the recording script asserted the defect was
still present and it was not.** The file had been rewritten at 18:14:43 with a
real `createSearchSchema.parse(input)`. **A two-minute intermediate state,
almost reported as a defect in somebody else's work.**

> **A rule learned on one file type is not automatically applied to another.**

That is the partial-application defect again — guarded at one site, not its
sibling — except the unguarded "site" was a different _kind of file_.

And note what made it dangerous: **the intermediate state was maximally
convincing.** A cast beneath a thorough, technically correct comment that
pre-empts the objection is **more** persuasive than a bare mistake. A reviewer
reading top-down is more likely to be fooled, not less.

**Adopted: never report a defect in another session's path from a single
read.** Re-read immediately before recording, compare mtime, and prefer asking
the owner to filing.

The same window produced a number that was correctly **not** recorded: a
test-typecheck reporting 74 diagnostics, including 29 `TS2584` and 26 `TS2304`
"cannot find name" errors — the sign that the `types`/`lib` configuration was
itself mid-edit. **Counting a tree while another writer is inside it produces
a number that looks precise and means nothing, which is worse than no number.**

Twice in one hour a read of `.ai/backlog.json` produced alarming nonsense, and
**neither was a real defect**:

- An inline `node -e` mangled by PowerShell quoting reported **2 items** where
  there were 74. The remedy was already written down in this file — _use a
  script file, never inline `node -e`_ — and was not followed.
- A script reading the file mid-write parsed `{ not json` and looked exactly
  like corruption. The file was intact at 600KB; the read had landed inside
  another process's write.

Both were seconds away from being reported as catastrophic data loss.

> **Before reporting a state file as corrupt or truncated, re-read it.** Check
> its size and mtime, and parse it a second time. With three sessions writing,
> a torn read is the _likelier_ explanation, and it costs one command to
> exclude.

And when mutating a state file, **read once, mutate in memory, write once.**
Re-reading between mutations widens the window in which another writer can land
between your read and your write.

### PowerShell `cd` does not move the process working directory

This one produced a confident, specific, alarming number — which places it in
the same family as case 3 of the mutation taxonomy, not in the "weak evidence"
family. It does not fail to inform you; **it misinforms you.**

Measuring `review.txt` seconds apart returned **208,286 bytes** from `Get-Item`
and **48,310** from `[IO.File]::ReadAllBytes`. It looked exactly like live
truncation of the one artefact in this repository with **no git baseline to
recover from**, and it was moments from being escalated as work loss.

**Both readings were correct. They were reading different files.**

> PowerShell **cmdlets** (`Get-Item`, `Get-Content`, `Set-Content`) honour `cd`.
> .NET file APIs (`[IO.File]::*`, `[IO.Directory]::*`) resolve relative paths
> against the **process** working directory, which `cd` does not change. Mixing
> the two in one script silently reads or writes two different files.

The stale copy in the other directory was 48,310 bytes, so every CR-byte count
taken that way had been measured against the wrong file.

**It is environment-dependent, which makes it worse.** In a session whose
process directory already equals the repository root the two agree perfectly and
the hazard is invisible — so a script that is correct on one machine silently
reads the wrong file on another.

> **Use absolute paths with .NET file APIs, or use cmdlets — never mix relative
> paths across the two.**

> **When a guard exists at one site and not another, the unguarded one is where
> the failure will happen — and it is usually the site someone judged
> "obviously fine".**

**The enumerated list is the count.** Two bare numbers of the same pattern
disagreed in the record — 4 in one place, 5 in another, 6 in a third — because
nobody had written down _which_ instances. A named list cannot disagree with
itself.

1. **`binary` classified silently while `unknown` was loud** — the silent
   branch is the one that makes a check decorative.
2. **Shape 5 guarded while Shape 3 demanded a locator** — the ungated shape is
   the one that fires most often.
3. **The runbook derived a container name at two sites and guarded only the
   restore drill.** The unguarded one **stopped a running production
   container**, with a trailing comment — _"example target; pick
   deliberately"_ — where the other site had an assertion. **Guidance is not a
   guard**, least of all ninety seconds before the operator is told to start
   the service again.
4. **A rule learned on one file type, never applied to another** — _"with
   concurrent writers, a bad read is more likely than a bad file"_ was
   recorded about `.ai/backlog.json` and not generalised to source files owned
   by other sessions. The unguarded "site" was a different **kind of file**.
5. **I wrote both the rule and the violation, ninety minutes apart, in the
   same document** — see below.
6. **`tsc -b` unguarded while the chain's last link was guarded.** A bare
   `tsc -b` could report stale success; `npm run typecheck` ends in a check
   that matches `/^\S+\.ts\(\d+,\d+\): error TS\d+/` and exits 1. **The
   unguarded invocation was the one people ran by hand.**

In every one, **the unguarded site was the riskier one**, and every one passed
its own review.

The runbook case also shows the cheaper fix: **do not repeat the guard, remove
the second derivation.** Two derivations of one value is the same defect as two
lists of one thing — it is how the guard came to exist at one site and not the
other in the first place. Hoist it, derive once, reuse.

These are about **consistency of application** rather than correctness of the
individual check.

**Instance 5 is the one that matters most, because I wrote both halves.**
Having flagged
the CS-24 step for deriving a container name without a guard, I replaced it
with a step that checked the env file using an advisory `echo` instead of a
gate, swallowed sourcing errors with `2>/dev/null` — the exact
redirect-destroys-the-reason defect fixed two steps earlier — and left
`docker stop "$TARGET"` outside the emptiness check, so an unset target would
sleep through a full tick and capture a quiet journal that the pass criterion
reads as **AC3 failed**.

> **Writing a rule does not inoculate you against it.**

The mechanism is worth naming because it will recur. I was concentrating on the
**substantive** correction — right container class, right interval, right
classification — and treated the guard as already solved. **A fix inherits the
attention of its author, and its author is attending to the thing they just
learned, not the thing they already knew.**

Two structural fixes came out of it, both generalisable:

- **Put the guard inside the block it protects, not beside it.** A guard
  beside a destructive command protects the **command**; a guard around it
  protects the **conclusion**. Here the refusal had to prevent the `sleep`,
  not just the `stop`, because the quiet journal was the real damage.
- **A default is only legitimate when the source was actually read.** `${VAR:-fallback}`
  cannot distinguish "configured and unset" from "never readable", so gate the
  read first and leave the variable empty on failure.

### A check is only as trustworthy as the tooling that looks at the file it lives in

This is the rule the whole run was circling, and it took until the end of the
day to see it stated at the right level.

`v2` runs `tsc -b` over its project references. All three referenced projects
carry `exclude: ["src/**/*.test.ts"]`. **Eleven of eleven tracked v2 test files
are therefore invisible to the type checker** — ten in `packages/core`, one in
`apps/workers/search`. The one config that would have included them,
`apps/web`, contains no test files. The gap is total, not partial.

The consequence found in the wild is the worst instance available. A mock in
`ai-provider.test.ts` was typed as
`Parameters<Parameters<typeof createServer>[0]>[1]`, which selects the wrong
overload and **collapses to `never`**. Everything asserted against it typed
clean because `never` accepts every comparison. Retyping produced **30 errors,
then 0** — and those errors exposed a fixture missing **seven required fields**.

> **The file was checking nothing, and the check that proved it was checking
> nothing could not run, because the file was excluded from the check.**

Now the part worth carrying:

> That was a **check that could not fail, inside the test file for CS-48** — the
> ticket whose AC7 was itself about a data-minimisation test that could not
> fail. The test was painstakingly rebuilt to be falsifiable **while the file
> containing it was type-invisible.**

**Fixing a check inside an unchecked file is the same defect one level up.**
Every falsifiability audit this run has performed asked _can this assertion
fail?_ and none asked _is anything looking at the file this assertion lives
in?_ The second question is cheaper and strictly more powerful, because a
negative answer voids every assertion in the file at once.

Generalise past TypeScript. The same shape is a lint config that globs past a
directory, a coverage report that excludes the harness, a test runner whose
pattern silently matches nothing, a CI job whose `paths:` filter never triggers.
In each, **the artefact exists, reads as coverage, and is not executed or
inspected by anything.**

> Before trusting a check, confirm the thing that checks it can **see** it.
> Ask for the resolved file list, not the exit code.

And the fix has a shape too. The `exclude` here is **correct** for the emitting
projects — `outDir` is `dist` and tests must not ship. **Deleting it would be
the wrong repair.** The right one already exists in this repository: the root
workspace runs `tsc --build --force && tsc -p tsconfig.test.json && tsc -p
tsconfig.test.web.json`. V2 is missing the equivalent. When a gap like this
appears, **look for the sibling that already solved it** before designing a fix.

Two consequences to apply immediately. First, **every `v2 typecheck` result
recorded today excluded tests**, and that caveat now travels beside the
Node-22-against-a-floor-of-24 one. It does not retract them — the source did
compile — but an unbounded "typecheck exit 0" is exactly the shape of claim that
produced eight demotions. Second, `apps/api` carries the same `exclude` with
**zero test files today**, so **the next API test anyone writes is born
invisible.** The gap is not only historical; it is waiting.

### `never` in a mock voids a test; `any` in a value under test does not

Same diagnostic family, opposite consequence — and getting this backwards
would have put a false finding next to a real one, which is how a real finding
comes to be dismissed.

> A **`never` collapse in a mock's type** makes assertions **vacuous**. The
> mock's shape is never validated against anything, so the test asserts about
> an object that satisfies every constraint by construction.
>
> An **`any` collapse in a value under test** does **not**. The assertions
> still execute against the real value at runtime. It removes **protection**;
> it does not remove the **check**.

`ai-provider.test.ts` was the first kind: retyping it produced 30 errors and
exposed a fixture missing seven required fields. The five `TS7022` sites at
`database.test.ts:1108-1142` are the second kind — `first`, `second` and
`firstResult` collapse to `any` through circular inference, but the test
installs a trigger, takes an advisory lock, starts a revoke and a login **in
both orders**, and **waits on `pg_locks` and `pg_blocking_pids` to confirm real
contention** rather than assuming it. Every assertion around it is a runtime
comparison, including a negative at `:1142`.

**`assert.equal(typeof loginToken, 'string')` is the tell.** That is exactly
what someone writes when they cannot lean on the type — evidence the author
knew and compensated, not evidence of neglect. **Fix for hygiene, not for
correctness.**

### A comment explaining a fixed defect can itself be wrong

The inverse of the best artefact this project has produced, and it costs more
than an ordinary mistake.

`ai-provider.test.ts` correctly diagnoses **why** a type collapsed to `never` —
`createServer` is overloaded, `Parameters<>` takes the first overload, its
`[0]` is `ServerOptions` — and then misstates **what `never` does**, claiming
`res.writeHead(...)` and `res.anything(...)` were _"all equally accepted."_

Probed directly, with a control:

```
TS2344  on the type alias itself
TS2339  Property 'writeHead' does not exist on type 'never'   ← legitimate call
TS2339  Property 'thisMethodDoesNotExistAnywhere' ...         ← bogus call
(no error on the same bogus call against `any` — the control)
```

**All were equally _rejected_.** The polarity is inverted. `never` is silently
assignable **to** anything — that part is real — but **property access on it is
an error**, and the two get conflated.

So **the harm was never `never`. The harm was exclusively that the file was
excluded from type-checking.** And since the alias was itself a `TS2344`, the
file would have failed **immediately and obviously**, not subtly. There was no
quiet-wrong state; only an unexamined one.

> **A recurrence-prevention comment that misstates the cause will prevent the
> wrong recurrence.** It is trusted at the moment it matters most, by someone
> with no reason to doubt it.

Fix the explanation, keep the part that is right. Here that was the closing
line, which is worth quoting in full: _"A test file that cannot be
type-checked is the same class of problem as a test that cannot fail."_

### The source of your inputs is part of your measurement

`git ls-files` cannot see untracked files. Used to enumerate test files on a
tree where **260 files are untracked**, it reported **11** where the universe
is **17** — and it was run by the same person who had filed the ticket about
untracked files three hours earlier.

> **A measurement that cannot see part of its own subject reports a confident
> wrong total.**

Same class as the glob that dropped 6 of 16 call sites, with a different blind
spot: there the _pattern_ under-matched, here the _source of names_ was
incomplete. Ask what the enumeration cannot see before trusting its count.

And do not stop at the first gap: of the two files outside `tsconfig.test.json`,
one was covered by a **different link in the same chain**. Checking one config
in isolation is the same fragment error as reading one line without its
neighbours — real coverage was 16 of 17, not 15.

### A true fact filed in the wrong field becomes a false claim

Recording a degraded chat session under `LOOP-STATE.agents` produced:

```
FAIL  LOOP-STATE tracks every agent (25 of 24)
```

That map **mirrors the 24-file `.github/agents` roster and is length-checked
against it.** A chat session is not one of those agents, so a true observation,
filed there, would have rendered a 25th agent that does not exist — **the
dashboard lying**, which is the specific failure the LOOP-STATE discipline
exists to prevent. Moved to `externalSessions`; **the record was preserved, not
deleted.**

Same shape as CS-51's two fives and CS-31's buried AC1 — and committed on state
its own author owns, minutes after writing up a comment that was right about
the cause and wrong about the mechanism.

**Record the counterexample too.** That gate did what nineteen others could
not: it **failed loudly on a change that looked entirely reasonable to the
person making it.** Not every check here is weak; this one was cheap, specific,
and caught a defect its author could not see.

### A point-in-time read is not a current fact

The companion to the spatial version below, and the append-only log makes it
**easy** to commit, because every line in that file was true once.

Three stale-snapshot reports in one evening:

1. the runbook's duplicate pass criterion — **fixed at 17:51**, reported from
   an earlier read;
2. an _"mtime may be unreliable"_ warning issued off the back of that, then
   retracted;
3. a tally quoted from `review.txt:4377` — **a mid-sequence downward
   correction**, superseded 200 lines later by a genuine new instance.

> **The common cause is not carelessness about files. It is treating a
> point-in-time read as a current fact without asking whether the record kept
> going.**

Pair it with reading a line without its neighbours **in space**: same defect on
two axes. For an append-only log, **the later entry wins** — so a grep that
returns one hit has found _an_ answer, not _the_ answer.

### A pattern whose count nobody can reproduce is a slogan

`AGENT-SETUP.md` enumerated **three** instances of one shape and then said
_"Fifth instance."_ No fourth was ever named. Meanwhile `review.txt` carried
4, then 5, then 6 — a coherent 5 → 4 → 5 → 6 history, but only reconstructable
by reading a running log end to end. Two readers did it, both badly.

**Replace every bare count with a named list.** A named list cannot disagree
with itself, and a new instance appends to it rather than incrementing a
number nobody can audit.

And check the list mechanically, with the matcher falsified first. Mine
initially reported item 6 **absent** because it did not match wording I had
just written — **a check that under-reports is its own defect**, and it was
fixed before its result was used.

### "Provisional" and "bounded" are different claims

Evidence that was **true but narrow** must not be marked suspect.

_"Every `v2 typecheck exit 0` today type-checked no test file. That does not
retract them; the source did compile. **It bounds them.**"_

> **"Provisional" implies the result might be false. It was not false; it was
> narrow.**

A bare `tsc -b` reported truthfully on the projects it considered up to date.
That is evidence for a narrower claim than the one it was quoted for — so
**restate the claim, do not discredit the run.** Marking true-but-narrow
evidence as suspect corrodes the record in the opposite direction from an
overclaim, and corrodes it just the same.

### Evaluating a check in isolation misreads it in both directions

The inverse of the eighteen findings, with the **same root cause**. Three
instances in one segment, all reported as _unable to fail_, all sound because
of something a few lines away:

| Check                        | What made it sound                                   |
| ---------------------------- | ---------------------------------------------------- |
| `liveStreams.every(...)`     | a multiset assertion **4 lines above**               |
| `result.outcomes.every(...)` | `elapsed.length === 5` **7 lines above** (partially) |
| `tsc -b`                     | a later link **in the same chain**                   |

> **The check was evaluated in isolation, and the thing that made it sound
> already existed two lines away.**

The eighteen looked _sufficient_ and were not; these three looked
_insufficient_ and were not. **One habit — reading a fragment instead of the
context — with two opposite signs.** Neither direction is detectable from the
fragment, which is the whole point.

### A correct finding applied at the wrong scope

The companion failure, and it is mine twice over:

- The CS-76 caveat went onto every ticket citing a typecheck — until
  `apps/web` turned out to genuinely include its tests, so CS-61 had been
  swept in wrongly.
- The #19 provisional marker went onto **29** tickets on the claim that "the
  gate could not fail". The gate **could** fail; only its first link could
  not. `npm run typecheck` chains four commands and the last one matches
  `/^\S+\.ts\(\d+,\d+\): error TS\d+/` — any file, not just tests. **The real
  set was 4, and all four cited a bare `tsc -b`.**

Both findings were correct. **Both blast radii were not.**

> Before applying a finding across the board, ask what would have to be true
> of _every_ member of the set — then check the member most likely to be an
> exception.

**Record the withdrawal on each item rather than deleting the marker.** A
marker applied and silently removed is indistinguishable from one that was
never applied, and the fact that 29 tickets were briefly graded on an
overstatement is itself part of the record.

> **A correction applied silently is indistinguishable from the mistake never
> having happened, which is why it must not be.**

### An incremental gate can be structurally incapable of failing

Nineteen checks that could not fail were found in one evening. **The
nineteenth was not an assertion. It was the gate the others leaned on.**

```
npx tsc -b          exit 0
npx tsc -b --force  exit 2    collect.ts(65,48) TS2353 — production code
```

Deleting that project's `.tsbuildinfo` made plain `tsc -b` go red and stay
red. The project is in the build graph: **incremental state was reporting
success over a genuine error**, so for that project the command **could only
return success.**

> A test that cannot fail misgrades **one** ticket. A typecheck that cannot
> fail misgrades **every ticket that cited it** — here, 29 of 79.

**And nobody wrote a bad check.** `tsc -b` did exactly what incremental build
means, used correctly, and produced an unfalsifiable result. That is what
makes it the first of the nineteen where the **tooling** was the thing that
could not fail, and it is the clearest statement of the whole family:

> **The evidence was structurally incapable of failing, and it still looked
> exactly like evidence.**

**Practical rules.** For any cached or incremental tool — `tsc -b`, test
runners with caches, lint daemons, Docker layers, `.tsbuildinfo`,
`node_modules/.cache` — a green result is only evidence if the cache was cold
or bypassed. **Record which.** Prefer `--force` for any result that will be
cited as proof, and treat an uncached run as a different claim from a cached
one.

**Handling the fallout is its own discipline.** Mark the affected evidence
**provisional**; do not delete it — the original lines record what was
actually run, and **the record of a mistaken check is worth more than its
absence.** And **do not demote in bulk**: twenty-nine simultaneous demotions
carry less information than one, because nobody can tell which were real.
Provisional first, re-grade on a clean forced run.

Finally, the shape of the personal error, which is the reusable part. The
command was run correctly and its exit code reported accurately — **and the
question never asked was whether the command was capable of returning
anything else.** I hardened _how_ an exit code was measured while never
questioning what it meant; that measurement is among the 29 now marked
provisional, and it is mine.

### A gate that goes red by becoming able to fail is not a regression

Three gates went deliberately red in one evening — `node:check` on Node 22,
`eol:check` on the unrenormalised files, and the newly wired v2 test
typecheck. **Every one went red by becoming able to see something it was
previously blind to.**

The last is the clearest. `v2 typecheck` was green an hour before and is exit 1
now, **and nothing broke**:

- **`tsc -b` over the production references is still exit 0.** The application
  compiles exactly as it did all evening.
- The test files are now checked too, and 56 diagnostics surfaced **from files
  that had never been checked in their existence**.

> Separate the two claims, because only one of them changed. **"The
> application compiles"** and **"the gate is green"** were the same sentence
> yesterday and are different sentences today.

A project that cannot tell these apart will revert its own improvements —
someone bisects to the commit that "broke typecheck", finds the new project,
and removes it. **Record the transition in the words above at the moment it
happens**, because the naive reading of two consecutive runs is the opposite of
the truth.

And state the residual honestly rather than reassuringly: **do not record
`v2 typecheck: exit 0` from this point.** The honest line is _production code
compiles and lints clean, unit suites 55/55 with 0 skipped, and the
test-typecheck gate is newly wired and reporting 56 diagnostics across three
known causes_ — none of them in files that reach `dist`.

### A ban stated at the wrong granularity blocks the correct fix too

The standing instruction was **"do not change `target: ES2023` — that is
tuning the build to the tests."** Right in spirit, too blunt in form.

The nine `Promise.withResolvers` errors went away, so the config was checked
rather than assumed:

```
tsconfig.base.json   "target": "ES2023"         ← unchanged
tsconfig.test.json   "lib": ["ES2024", "DOM"]   ← test project only, noEmit
```

**`lib` says which types to know about; `target` governs what is emitted.** A
`noEmit` project can know about `Promise.withResolvers` — which exists at
runtime on Node 24 regardless of compile target — **without altering a byte of
production output.**

> **`lib` in a `noEmit` test project is not "tuning the build to the tests."
> Changing `target` in the base config would be.**

Generalise it: **a prohibition written at the wrong level of detail forbids
the correct fix alongside the wrong one**, and the person who obeys it
literally ends up worse off than the person who understands why it was
written. State bans in terms of the **effect** to be avoided — "production
emit must not change" — not the **mechanism** that happened to cause it.

### A correctness property maintained by convention fails silently

V2's `MatchingProfile` narrows `application` to `expectedCtc`,
`yearsOfExperience`, `willingToRelocate`. V1's `buildCandidateContext` reads
**exactly those three** — verified by enumerating every `application.<field>`
access and asserting the set, not by reading three and stopping.

So there is **no live defect**, and that makes it a better finding, not a
lesser one:

> The defect is not that the types differ. It is that **a deliberate
> minimisation depends on an unenforced agreement with a consumer in another
> workspace.**

The day the matcher reads a fourth field, V2's `Pick` will not supply it and
the value arrives as `undefined` inside deterministic scoring. **Not a crash —
a silently wrong match score.** Worse than a crash, and invisible until
violated.

Two fixes are forbidden in both directions, which is worth noting because each
looks reasonable alone. **Do not widen V2** — that discards a deliberate
minimisation to satisfy a type checker and hands the matcher data it has no
business receiving. **Do not cast** — that removes the only signal,
permanently, in the one place the boundary is exercised.

And name the contract in the ticket. **The three field names _are_ the
agreement**; a ticket saying "the shapes must agree" makes the next person
re-derive the only thing that matters.

### A raw error count is a symptom count, not a finding count

96 type errors decomposed into: **~76** from _one_ `dist`-vs-`src` resolution
misconfiguration, **9** from a single `Promise.withResolvers` lib-target
decision, **5** hygiene, **6** unexamined. **Fix the config and re-count**
rather than reporting 76 as 76 findings.

> The honest headline: the v2 test suite had never been type-checked, and when
> it was, it produced **one real vacuity, one config problem, one library
> decision, and some hygiene.**

That is far better than the raw number suggested, and it agrees with the
independent loop-assertion sweep. **The tests are in good shape; the tooling
around them was not** — different problems, different owners. Say so plainly.
A P1 about missing coverage otherwise invites the reader to assume the
uncovered code is bad.

And note why the gap still matters at P1 despite the good news: **good
assertions cannot detect that the type they assert against has collapsed, and
a type checker cannot detect a tautology.** Neither defence substitutes for
the other.

### A test can be sound for a reason that is not visible where it is written

This is the inverse of everything else recorded here, and it arrived last
because the whole run had been looking the other way.

CS-33's negative-path test SQL-writes corrupt data past both validators, then
asserts the read routes cope. **Six `UPDATE`s, not one `rowCount` check.** A
zero-row `UPDATE` leaves the data clean, the route returns 200, and the strip
assertion — `assert.ok(!json.includes('unexpectedField'))` — **passes
trivially. That is the absence-assertion-with-no-positive shape in its purest
form.**

And yet the test is sound. The malformed half does `data - 'title'` on the
**same row** and asserts **400**, reachable only if the row was really
modified. The later assertion **retroactively proves the earlier assertion's
precondition.**

> The test is safe because a **later assertion in the same test** proves an
> **earlier assertion's precondition** — not because either assertion is
> self-validating. The guarantee is **emergent from ordering**, not stated.

**The finding is the fragility, not the test.** Split those halves into two
tests and the strip half becomes vacuous immediately, with nothing to signal
it — and _"one test per behaviour"_ is ordinary advice, so that refactor is
locally correct and silently destructive. A third site is worse: the two
**restore** `UPDATE`s at the end have **no later assertion at all**, so they
lack even the emergent guarantee, while their comment promises they stop a
corrupted fixture reaching anything added later.

> **We spent the day on assertions that look sufficient and are not. This is
> one that looks insufficient and is — and both are fixed the same way: pair
> the negative with a positive, in the same test, explicitly.**

### The two tests in one file that prove it, side by side

Both sound, for opposite reasons. `database.test.ts` holds both.

|                   | CS-48 AC10                                                  | CS-33 negative-path                                                  |
| ----------------- | ----------------------------------------------------------- | -------------------------------------------------------------------- |
| Precondition      | **asserted** — `'the fixture profile must really be saved'` | **not asserted** — no `rowCount` check                               |
| Non-vacuity       | **explicit** — `bodies.length === 1`                        | implicit                                                             |
| Why it holds      | **stated where it is written**                              | a _later_ assertion happens to prove an _earlier_ one's precondition |
| Survives a split? | **yes**                                                     | **no** — separate the halves and the strip case goes vacuous         |

> **Both are correct today. Only one is correct in a way the next reader can
> see** — and only one survives the ordinary refactor of one test per
> behaviour.

That is the real argument for the `rowCount` line, and a better one than "add
a guard": **the guard is not there to catch a bug, it is there to make an
existing guarantee local rather than emergent.**

**CS-48's AC10 is the reference implementation for owner-isolation testing
here.** The route takes no owner from the request — it is derived from the
session — so the only available test is to ask the **same** `checkId` as two
different owners and prove each got their own profile. Every failure mode is
closed: a route always serving owner A fails owner B's positive; a route
returning no profile still fails the positive; zero provider requests fail the
length guard; and two owners sharing a title makes the negative fire **loudly**
rather than passing falsely. Copy this shape: **positive on the same surface
first, then the paired negative, precondition asserted, collection proven
non-empty.** CS-61's AC3 has already defeated four attempts; a fifth should
look like this.

### Searching for a token is not measuring the property

Fifth form of one substitution, and by now it is the signature failure of this
project's tooling. In every case a **cheap proxy** stood in for the property
someone actually cared about:

| Proxy                       | Property it stood in for        |
| --------------------------- | ------------------------------- |
| a react-query census        | which queries are owner-scoped  |
| an `app/(app)/` glob        | which call sites exist          |
| a line-oriented grep        | whether a phrase is in the file |
| `AC2` appears in `evidence` | AC2 is satisfied                |

The last one was run over five tickets: 15 criteria, 13 named by identifier,
**2 flagged**. One of the two — CS-56's AC2 — is **met**, proven by thirteen
hostile fixtures asserting `toEqual([])`, which is genuine _rejection_ rather
than merely a different result. **The evidence addresses AC2 thoroughly; it
simply never writes the string "AC2".**

> **A 1-in-2 false-positive rate on the only cases it flagged.** That is not a
> finding. It is a filter.

**Report a proxy result as a proxy result.** "No criterion is unmentioned" is a
real and useful statement; "all criteria met" is a different one, and the scan
cannot reach it. Where a proxy comes back clean, record the **weak** claim —
and keep the outstanding label, because the label is about the strong one.

And the proxy was still worth running: **it narrowed fifteen criteria to two
candidates in a single command.** The error is never running the cheap check;
it is converting its output into the expensive check's answer.

**Do not convert an outstanding count into a number on the strength of a
scan.** That is exactly the counted-claim-over-an-uncounted-criterion defect
the outstanding label exists to prevent — the defect reappearing inside the
remedy for itself.

**The genuine candidate then needs a genuine read.** CS-35's AC1 named three
paths — revision conflict, idempotency-key reuse, missing target role — and a
criterion naming three things is the shape that hides an unmet third, as
CS-52's "both halves" and CS-74's AC3 both were. Checked individually in
source, all three are traced with distinct codes and all appear in the handler
map; revision conflict even carries **two** distinct codes where one would
satisfy the criterion. **3 of 3, discharged by reading.**

### A count is only as good as the set it is taken over

The `applicable` fix was necessary and **is not sufficient**, which took three
tickets to see:

- **CS-74** — _"All 3 criteria met"_ with AC3 half-met and AC2 unevidenced.
- **CS-52** — _"both halves complete"_ with a **third** criterion unmet.
- **CS-38** — _"closed"_ while two findings remained open.

Replacing a hedge with a count does not help if the count is taken over the
wrong set. **"Both halves" is a count over a set somebody chose**, not one the
ticket defines — right about the set it named, wrong about the set that
mattered. Re-take counts against the ticket's actual `acceptanceCriteria`
array length, never against a remembered structure.

**And the hedge is most tempting precisely where the case for it is
strongest.** CS-52's AC4 is the one `applicable` would most easily have
absorbed, because the transitive-CI route genuinely _is_ defensible. A hedge
that only ever covered indefensible gaps would have been caught long ago.

**Distinguish open-by-decision from unfinished.** CS-52's AC4 is unmet because
`deploy.yml:145-156` deliberately runs no V2 test **and says so in a comment**
— one that ends by naming `override_ci` as able to waive the very evidence the
gate leans on. Those need different handling from a forgotten criterion, and a
record saying only "unmet" loses it. Where the decision is an owner-facing
safety trade-off it belongs on the **gate list**, not a work queue — and
amending the criterion to accept the weaker route is legitimate **only if the
waiver is written into the criterion**, because amending it silently is the
reclassification move the hedge made possible in the first place.

### Boilerplate pasted into ten tickets becomes ten false matches

Self-inflicted, found by my own re-take. The wording-correction note pasted
onto the counted cohort contains the literal phrase **"ALL THREE CRITERIA
MET"** as an _illustration of the rule_. Two of those ten tickets have **two**
and **four** criteria — so a mechanical count check flags them forever, and the
flag is pure noise.

Of ten mismatches the re-take reported, **eight were false**: `both halves`
used as ordinary prose about two halves of a _fix_, plus this quoted
boilerplate. **Two were real.** Reading around every match — not only the
convenient ones — is what separated them.

> **A checker over prose reports candidates, not verdicts.** Record the
> adjudication beside the flag, or the next reader re-derives it and a future
> run "confirms" eight defects that do not exist.

Note the trap this sets for the _fix_: suppressing the false matches is exactly
the lever that makes a check unable to fail. **Prefer adjudicating flags to
suppressing them.**

## Engineering Control Center

`node scripts/control-center.mjs` — or the **CareerScope: Engineering Control
Center** task, which watches `.ai/` and re-renders on change. `--json` for a
machine-readable dump.

It renders task, phase, iteration, active agent, model, permission, elapsed
time, current operation, every agent's state, the progress matrix with deltas
against the previous commit, P0-P3 findings, the activity log, the last review
entry and the next action.

Everything it prints is read from a file. It computes no percentage of its own —
those come from the progress matrix — and it invents no activity.

Two honest limits, both deliberate:

1. **VS Code does not publish agent runtime to disk.** "Active agent" is
   whatever the Orchestrator last wrote. This is a record, not a probe.
2. **Because of (1), a recorded `RUNNING` state that has not been updated for
   15 minutes is reported as `STALE`, not animated.** A spinner over an
   abandoned run is precisely the fake activity the tool exists to avoid.

Permission is derived from each agent's actual tool list, not from a label, so
the `READ ONLY` / `WRITE` column cannot drift from the enforced configuration.

The dashboard reads `.ai/` and `review.txt` and nothing else. CareerScope does
not depend on it; if it breaks, the application is unaffected.

## Negative proof

**A green check is not evidence until the check has been shown to go red.**

Every critical validator needs **three** cases, not two:

| Input                              | Required outcome |
| ---------------------------------- | ---------------- |
| valid, satisfying state            | PASS             |
| valid, violating state             | FAIL             |
| **malformed or unparseable state** | **FAIL**         |

The third is not theoretical. The release gate shipped briefly with a parse
failure collapsing into "empty", so a corrupt `findings.json` produced zero
findings, "no open P0 or P1" passed, and a release that was **BLOCKED reported
READY TO DEPLOY**. Corrupting a file made the gate _more_ permissive.

So: **never interpret a parser failure as "nothing found".** Unreadable state is
a refusal, not an absence.

Two further rules earned the hard way:

> A validator, review verdict or progress record must never be made green by
> changing the interpretation of the condition it was created to enforce.

> Keep an agent only if it owns a unique artefact, holds a unique permission
> boundary, makes a materially different decision, or provides evidence no other
> agent can. Otherwise merge it. Activate per task — never "run all agents".

For every acceptance assertion, ask what deliberately broken state would make it
fail, then create that state and confirm it does. `check-agents.mjs` has now
produced a false pass twice: once when a regex matched only inline YAML arrays
and read the orchestrator's handoffs as empty, and once when a status assertion
was structurally unable to fail. Both reported PASS because they failed to look.

The status-vocabulary check was mutation-tested on introduction — clean exit 0,
invalid status exit 1, restored exit 0 — and that test immediately surfaced a
real violation that had already been written into the progress file.

---

## MCP

`.vscode/mcp.json` configures one server: **job-radar**. No MCP server was added
for this workflow. Reviewers get no write-capable MCP integration; that
configuration belongs to the interactive developer session, not a review
session.

---

## Known limitations

Things VS Code and Copilot cannot enforce, stated rather than papered over:

1. **Model availability is runtime-dependent.** Frontmatter supports selection;
   this roster leaves it unset. Do not infer availability from old CLI probes.
2. **Prose cannot force a fresh session.** Use a separate review execution and
   verify context isolation through native sessions or the manual fallback.
3. **`execute` can modify state via shell.** QA and Performance are constrained
   by convention there, not capability.
4. **Nothing prevents pasting a reviewer's text in and calling it a review.**
5. **Native subagents can be invoked** through the agent tool and allowlist.
   Handoffs remain user-triggered transitions; scripts do not schedule agents.
6. **Native discovery and the full UI loop remain end-to-end unverified.** A
   configuration pass does not establish runtime or production readiness.

---

## Activation policy

This is a **24-agent specialist capability library with an operator-driven,
bounded workflow and a durable state model**.

Sub-agents **can** be invoked from a chat session — this was asserted to be
impossible in this file and in the Copilot contract until a Code Quality agent
was run to test the claim. It read a file, produced file:line findings, and
found a real defect that had been committed two changes earlier. The claim was
wrong, and it had already been written into two documents and used as the
premise of an external review.

Sequencing is explicit: the Orchestrator can invoke real native subagents under
the approved graph, while handoff controls are user transitions. Scripts do not
chain them automatically. The assigned recorder maintains durable state from
actual activity, never claiming an agent acted when the operator did the work.
Equally, it must not claim the agents cannot run.

What the agent files are worth: role contracts, permission definitions, review
checklists, specialist prompts — and now, working invocation targets.

The roster is a capability library, not an attendance list. Twenty-four agents
existing is not the problem; twenty-four participating in every task would be.
Route the **smallest sufficient team** and justify each addition.

| Task class          | Agents activated                                              |
| ------------------- | ------------------------------------------------------------- |
| Default             | Orchestrator, one builder, QA, Independent Reviewer (4)       |
| Non-trivial change  | add Product Architect or System Designer (5–6)                |
| Security-sensitive  | add Security                                                  |
| UI or Pages work    | add UX; add Visual Designer if tokens or assets change        |
| Deployment or infra | add Infrastructure and Release Manager                        |
| New dependency      | add Research Reference, and Skills Curator if a skill is used |
| Release             | add Documentation — mandatory, it gates the release           |
| Disputed outcome    | add Final Auditor, in a fresh session                         |

Activating an agent that produces no artefact, holds no distinct permission and
makes no different decision is ceremony. Record the team in `.ai/LOOP-STATE.md`
so the choice can be reviewed afterwards rather than assumed.

## External Reviewer (non-resident)

A twenty-fifth reviewer exists, and it is deliberately **not** in
`.github/agents/`: a file there would imply VS Code can invoke it, and VS Code
cannot. It runs in a browser tab.

| Property    | Value                                                      |
| ----------- | ---------------------------------------------------------- |
| Identity    | ChatGPT, separate provider and separate account            |
| Model       | Not verifiable from this repository; do not record a guess |
| Repository  | **No access.** Sees only what the operator pastes          |
| Permissions | Cannot read, edit, execute or deploy                       |
| Invocation  | Operator-mediated, one paste at a time                     |
| Artefact    | A written verdict, transcribed into `.ai/findings.json`    |

**Why it is worth keeping.** It shares none of this session's context, so it
does not inherit its blind spots. It has already earned its place twice: it
classified the deploy/CI decoupling as P0 when it had been recorded here as a
lower-priority cleanup, and it supplied the malformed-state rule that the
release-gate defect proved necessary.

**Where its independence stops, stated plainly.** It reviews a summary chosen
by the agent being reviewed. If the briefing omits something, the reviewer
cannot find it — its recall is bounded by an interested party. It is therefore
a genuine second opinion on _reasoning_, and a weak one on _completeness_. It
does not replace the Final Auditor, which reads the repository directly.

**Rules.** Paste the briefing, never a secret, never a `.env`, never resume or
personal data — the transcript leaves this machine. Record its verdict as a
finding with its own source, not as fact. Its disagreement is evidence to weigh,
not an instruction to follow.

## Relationship to Claudex Loop

`.github/CLAUDEX-WORKFLOW.md` documents a separate cross-CLI workflow whose host
is a Claude Code or Codex terminal session. Both exist deliberately: this one
for everyday work inside VS Code, Claudex when a genuinely different provider
and account should review. **Use one per task, not both.**
