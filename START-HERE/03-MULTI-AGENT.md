# The multi-agent engineering system

Sixteen specialist agents in `.github/agents/`, coordinated through durable
state in `.ai/`.

One principle justifies all of it:

> **The agent that implements a change is never the sole authority that it is
> correct.**

A model reviewing its own work reproduces its own blind spots — fluently, and
wrong in exactly the places it was wrong the first time.

---

## The agents

| Agent                    | Decides                                            | Permission |
| ------------------------ | -------------------------------------------------- | ---------- |
| **Orchestrator**         | routing, `.ai/` state, **completion**              | WRITE      |
| **Project Manager**      | what to build, why, priority, acceptance, GO/NO-GO | READ ONLY  |
| **Product Architect**    | requirements, domain model, abstractions           | READ ONLY  |
| **System Designer**      | boundaries, flows, topology, failure modes         | READ ONLY  |
| **UX**                   | IA, navigation, states, accessibility              | READ ONLY  |
| **Research**             | internal investigation before adoption             | READ ONLY  |
| **Research Reference**   | current external fact, cited                       | READ ONLY  |
| **Senior Engineer**      | cross-cutting implementation                       | WRITE      |
| **Frontend**             | Next.js, React, components                         | WRITE      |
| **Backend**              | Fastify, PostgreSQL, queues, workers               | WRITE      |
| **Infrastructure**       | Docker, Caddy, CI/CD, host                         | WRITE      |
| **QA**                   | runs the real commands                             | EXECUTE    |
| **Performance**          | measures; recommends only with evidence            | EXECUTE    |
| **Security**             | adversarial security review                        | EXECUTE    |
| **Independent Reviewer** | tries to prove the implementation wrong            | READ ONLY  |
| **Final Auditor**        | "is this actually complete?", fresh context        | READ ONLY  |

**Permission is enforced by withholding the tool, not by instruction.** A prompt
saying "do not modify files" is a request; an absent `edit` tool is a
constraint. Only one of those survives a model that decides it knows better.

`node scripts/check-agents.mjs` asserts this — 37 checks, including that no
reviewer, architect or researcher holds `edit`.

## How to run a task

You drive it. VS Code cannot invoke sub-agents programmatically from chat.

1. Open the **CareerScope Orchestrator** agent and give it the task.
2. It routes to the smallest sufficient team and records state in `.ai/`.
3. It tells you which specialist to open next. Switch agent, paste the handoff.
4. Read-only agents return findings as text; the Orchestrator transcribes them.
5. The Orchestrator decides `COMPLETE`, `BLOCKED` or `OPEN — EXTERNAL/HUMAN`.

Watch it with:

```bash
node scripts/control-center.mjs --watch
```

## Routing — smallest sufficient team

Running all sixteen on a CSS fix is theatre, and it trains everyone to skim.

```
Substantial work
  PM → Research → System Designer → Senior Engineer → QA
     → Performance → Security → Independent Reviewer → Final Auditor

UI work
  PM → UX → System Designer → Frontend → QA → Independent Reviewer → Final Auditor

External question
  PM → Research Reference → System Designer

Deployment
  PM → Research → Infrastructure → Security → QA
     → Independent Reviewer → Final Auditor
```

## Parallel or sequential

**Parallel is safe only for read-only agents.** They hold no `edit` tool, so no
number of them running at once can conflict. Fan them out.

**Never parallelise two writers.** "They touch different folders" is a
prediction, not a guarantee.

Sequential also for anything consuming another agent's output: QA cannot verify
an implementation that has not happened.

## Bounded loops

```
planning/research 5 · system design 3 · implementation 3
code review 3 · security 2 · performance 2 · final audit 2
```

Hitting a limit sets **BLOCKED**, never COMPLETE. A bound that can be exceeded
is not a bound.

## State

Canonical, machine-readable — automation reads these:

```
.ai/LOOP-STATE.json     phase, active agent, heartbeat, per-agent state
.ai/progress.json       the progress matrix
.ai/findings.json       P0-P3 findings
.ai/references.json     research cache, with URLs and access dates
```

Human projections — people read these:

```
.ai/CAREERSCOPE-PROGRESS.md   progress, with evidence and prose
.ai/AGENT-SETUP.md            this system, in full
review.txt                    append-only audit log, never truncated
```

The validator asserts the JSON and the Markdown **agree**, so the projection
cannot quietly become fiction.

## Two honest limits

1. **VS Code publishes no agent runtime to disk.** "Active agent" is what the
   Orchestrator recorded, not a probe. The control center labels it `REPORTED`.
2. **A stale heartbeat renders as `STALE`, not as an animated spinner.** A
   spinner over an abandoned run is fake activity, which is the one thing this
   system must never produce.

Models are **not pinned** — VS Code cannot pin a model per agent file, so the
picker governs and the dashboard prints `UNPINNED / PICKER CONTROLLED` rather
than inventing a name. Switch the model in the picker when you switch roles.

## Completion

Requirements met · no open P0 or P1 · P2s fixed or justified in writing ·
typecheck, lint, tests and build pass **with output someone read** · docs
current · diff reviewed · independent audit passed · `LOOP-STATE.json` says
`COMPLETE`.

None of these is completion: a zero exit code, an output file existing, a model
saying "done".
