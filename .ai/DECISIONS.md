# Decisions

Architectural decisions, why they were made, and what was rejected. Append
only -- a superseded decision stays, marked superseded, because the reasoning
is the useful part.

## D-001: reviewer is never the builder

**Decision.** The agent that implements a change never decides it is correct.

**Why.** A model reviewing its own work reproduces its own blind spots. This
is the single rule the workflow exists to enforce; everything else is
logistics.

**Rejected.** One agent doing plan, build and review. Faster, and worthless as
assurance.

## D-002: shared state lives in .ai/, not in conversation

**Decision.** Every handoff reads and writes files under .ai/.

**Why.** Conversation memory does not survive a session boundary, and a fresh
inspection requires a fresh session by definition.

## D-003: builder model is not pinned yet

**Decision.** `.github/agents/careerscope-builder.agent.md` carries no
`model:` key.

**Why.** GPT-6 Astra was requested and is not available -- the Copilot CLI
rejects it outright. Writing in a substitute would be the silent swap the
workflow forbids. Pin it once the exact picker identifier is known.

## D-004: eleven specialists replace the generic architect/builder pair

**Decision.** `careerscope-architect` and `careerscope-builder` were deleted and
replaced by the specialist team.

**Why.** They would have duplicated Product Architect, Frontend, Backend and
Infrastructure exactly. Two agents owning one job means neither owns it, and the
brief explicitly says not to create an agent that duplicates existing capability.

**Kept.** Their content was carried into the specialists rather than rewritten.

## D-005: model assignment, and a documented substitution

**Decision.** No `model:` key is pinned in any agent file. The intended model is
stated in each agent's body instead.

**Why.** Two separate reasons, and both matter:

1. **GPT-6 Astra is unavailable.** Verified:
   `copilot --model gpt-6-astra` returns
   `Error: Model "gpt-6-astra" from --model flag is not available.`
   The brief permits substitution once documented — this is that documentation.
   The Frontend, Backend and Infrastructure agents will run on whatever the
   picker is set to, and that choice is the operator's, made deliberately.
2. **VS Code cannot pin a model per agent file anyway.** The picker governs at
   run time. Writing a `model:` key would create the appearance of enforcement
   without the substance, which is worse than an honest gap.

**Caveat on the evidence.** Every identifier probed was rejected, including
`claude-opus-5` — the model this session runs on. The Copilot CLI and the VS
Code picker are different surfaces, so this proves Astra is unavailable _to the
CLI_, not necessarily absent from the picker. Confirm in the picker before
concluding.

**Intended assignment:** Product Architect, UX, Security and Final Auditor →
Claude. Frontend, Backend, Infrastructure → GPT-6 Astra when available. QA,
Performance, Research, Orchestrator → strongest available.

## D-006: read-only is enforced by tool grant, not by instruction

**Decision.** Product Architect, UX, Security, Final Auditor and Research are
granted `search`/`read` and **no** `edit` tool. QA and Performance get `execute`
but not `edit`.

**Why.** A prompt saying "do not modify files" is a request. Withholding the
tool is a constraint. Only one of those survives a model that decides it knows
better.

**Limitation.** `execute` can still modify state through the shell, so QA and
Performance are constrained by convention, not capability. Stated rather than
hidden.
