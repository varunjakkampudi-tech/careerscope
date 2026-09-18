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

| Agent             | Role        | Model                      | Write access     | Primary responsibility                                   |
| ----------------- | ----------- | -------------------------- | ---------------- | -------------------------------------------------------- |
| Orchestrator      | coordinator | picker default             | edit + execute   | requirements, routing, `.ai/` state, completion decision |
| Product Architect | reviewer    | **intended Claude**        | **none**         | architecture, requirements, domain model, debt           |
| UX                | reviewer    | **intended Claude**        | **none**         | IA, navigation, states, accessibility                    |
| Frontend          | builder     | _unresolved_               | edit + execute   | Next.js, React, components, routing                      |
| Backend           | builder     | _unresolved_               | edit + execute   | Fastify, PostgreSQL, queues, workers                     |
| Infrastructure    | builder     | _unresolved_               | edit + execute   | Docker, Caddy, CI/CD, host                               |
| Security          | reviewer    | **intended Claude**        | **none**         | adversarial security review                              |
| QA                | verifier    | picker default             | **execute only** | runs the real commands                                   |
| Performance       | verifier    | picker default             | **execute only** | measures; recommends only with evidence                  |
| Research          | advisor     | picker default             | **none**         | investigates before adoption                             |
| Final Auditor     | auditor     | **intended Claude, fresh** | **none**         | "is this actually complete?"                             |

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

`.ai/` — 20 files. Conversation memory does not survive a session, and fresh
sessions are exactly what independent review requires.

`PROJECT-CONTEXT` · `REQUIREMENTS` · `ARCHITECTURE` · `SYSTEM-DESIGN` ·
`UX-DESIGN` · `DECISIONS` · `ACTIVE-TASK` · `PLAN` · `PLAN-REVIEW` ·
`IMPLEMENTATION-LOG` · `CODE-REVIEW` · `SECURITY-REPORT` · `PERFORMANCE-REPORT` ·
`QA-REPORT` · `FINAL-AUDIT` · `DOCUMENTATION-AUDIT` · `CLEANUP-REPORT` ·
`CAREERSCOPE-PROGRESS` · `AGENT-SETUP` · `LOOP-STATE.json`

No secrets. The validator checks.

---

## Loop limits

```
PLAN_REVIEW_MAX     5
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

## Negative proof

**A green check is not evidence until the check has been shown to go red.**

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
