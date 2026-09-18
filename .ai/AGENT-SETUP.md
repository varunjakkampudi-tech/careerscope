# CareerScope Multi-Agent Engineering System

Permanent specification of the AI engineering workflow. Update this file
whenever the agent architecture changes.

Validate with `node scripts/check-agents.mjs`.

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
| Security             | verifier    | **intended Claude**        | **execute only** | adversarial security review                    |
| Code Quality         | reviewer    | **intended Claude**        | **none**         | duplication, dead code, complexity, boundaries |
| Independent Reviewer | auditor     | **intended Claude**        | **none**         | tries to prove the implementation wrong        |
| Final Auditor        | auditor     | **intended Claude, fresh** | **none**         | "is this actually complete?"                   |

Nine roles were added beyond the original eleven, each separating a decision
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

**Visual Designer and Frontend must never run together.** Both write to the same
tree. The Designer owns tokens, global styles and assets; Frontend owns
components, routes and state.

**No agent may create an agent.** An agent able to write `.github/agents/*.md`
could grant itself the `edit` tool, and every permission guarantee here rests on
tools being absent. When the team lacks a capability, the Orchestrator reports
it and stops; the operator adds the agent in a reviewed commit.

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

2. **VS Code cannot pin a model per agent file.** The picker governs at run
   time. A `model:` key would create the appearance of enforcement without the
   substance — worse than an honest gap.

**Caveat on that evidence:** every identifier probed was rejected, including
`claude-opus-5`, the model this session runs on. The Copilot CLI and the VS Code
picker are different surfaces, so this proves Astra is unavailable _to the CLI_,
not necessarily absent from the picker. Confirm in the picker before concluding.

**Operator responsibility:** switch the model in the picker when switching
roles. The agent file will not do it for you.

---

## Workflow

```
Request → Recon → Research → Architecture → UX → Plan → Review
        → Implementation → QA → Security → Performance → Cleanup
        → Documentation → Architecture Sync → Final Audit → Complete
```

Phases that do not apply are skipped, with the reason recorded.

### Routing — smallest sufficient team

Running all eleven agents on a CSS fix is theatre, and it trains everyone to
skim the output.

| Change              | Team                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| Copy or CSS         | UX → Frontend → QA                                                                           |
| Component behaviour | UX → Frontend → QA → Final Auditor                                                           |
| New API endpoint    | Product Architect → Backend → Security → QA                                                  |
| Migration           | Product Architect → Backend → Security → QA                                                  |
| Deployment or CI    | Infrastructure → Security → QA                                                               |
| New dependency      | Research → Product Architect → builder → QA                                                  |
| Full feature        | Research → Architect → UX → Frontend + Backend → QA → Security → Performance → Final Auditor |
| System redesign     | all                                                                                          |

## Execution graph

The Orchestrator decides what runs together. One rule governs it:

**Parallel is safe only for read-only agents.** Architect, UX, Security,
Performance and Research hold no `edit` tool, so no number of them running at
once can conflict.

**Never parallelise two builders.** Frontend, Backend and Infrastructure all
write files. "They touch different folders" is a prediction, not a guarantee.

Also sequential: anything consuming another agent's output. QA cannot verify an
implementation that has not happened.

```
        ┌──────────────── ORCHESTRATOR ───────────────┐
        ↓                     ↓                       ↓
    ARCHITECT                 UX                  RESEARCH      parallel
        └─────────────────────┼───────────────────────┘
                              ↓
                        IMPLEMENTATION                          one writer
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

Only the Orchestrator delegates — verified by `check-agents.mjs`, which is what
prevents a delegation cycle.

Handoffs name files, never memory, because specialists start without context:

```
#CareerScope Product Architect  Review .ai/PLAN.md against .ai/REQUIREMENTS.md.
                                Round 2 of 5. Prior findings in .ai/PLAN-REVIEW.md.
#CareerScope Backend            Implement approved .ai/PLAN.md items 1-4.
                                Run validation, report real output.
#CareerScope Final Auditor      Audit the diff against .ai/REQUIREMENTS.md.
                                Fresh context. Verify claims, do not trust them.
```

Read-only agents have no edit tool, so the **Orchestrator transcribes their
findings verbatim** into the `.ai/` reports.

---

## Tool permissions

| Capability | Who                                                      |
| ---------- | -------------------------------------------------------- |
| `edit`     | Orchestrator, Frontend, Backend, Infrastructure          |
| `execute`  | those four, plus QA and Performance                      |
| read-only  | Product Architect, UX, Security, Research, Final Auditor |

Read-only is enforced by **withholding the tool**. A prompt saying "do not
modify files" is a request; an absent tool is a constraint. Only one survives a
model that decides it knows better.

---

## Shared state

**Canonical, machine-readable.** Automation reads these and nothing else:

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

The validator asserts the JSON and the Markdown **agree**, so the projection
cannot quietly become fiction. This split exists because regex over prose
produced three silent false negatives here; machine decisions now consume
structured data.

No secrets. The validator checks.

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
justified in writing · typecheck, lint, tests and build pass with output someone
actually read · accessibility and smoke checks where applicable · docs and
architecture current · diff reviewed, no unrelated changes · final independent
audit passed · `LOOP-STATE.json` reports `COMPLETE`.

None of these is completion: a zero exit code, an output file existing, a model
saying "done". On this machine `claude auth status` exits **0** while reporting
`loggedIn: false` — the trap is live in the first command anyone runs.

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

1. **Model pinning per agent is impossible.** Role↔model pairing is convention.
2. **A fresh session cannot be forced.** The Final Auditor's independence
   depends on the operator starting one.
3. **`execute` can modify state via shell.** QA and Performance are constrained
   by convention there, not capability.
4. **Nothing prevents pasting a reviewer's text in and calling it a review.**
5. **Sub-agents cannot be invoked programmatically from a chat session** — the
   operator drives each handoff.

## Relationship to Claudex Loop

`.github/CLAUDEX-WORKFLOW.md` documents a separate cross-CLI workflow whose host
is a Claude Code or Codex terminal session. Both exist deliberately: this one
for everyday work inside VS Code, Claudex when a genuinely different provider
and account should review. **Use one per task, not both.**
