# AI Engineering Workflow

How CareerScope work gets planned, built and independently reviewed inside
VS Code Copilot. Start at the [repository-local setup](ai/README.md) for prompts,
role mapping, evidence gates and troubleshooting.

The rule everything else serves: **the agent that implements a change is never
the sole authority that it is correct.**

## Roles And Execution

The repository has 24 specialist agents, not the former three-role system.
There is no current `CareerScope Architect` or `CareerScope Builder` target:
use Product Architect/System Designer and the assigned tier builder or Senior
Engineer. The [agent matrix](ai/agent-matrix.md) maps fifteen engineering
responsibilities to the existing files and twenty local skills.

The default team is Orchestrator, one builder, QA and Independent Reviewer.
Add specialists only for distinct risk or evidence. The Orchestrator is the CTO
role and owns routing and the completion decision, not unilateral self-approval.

Native subagent calls require the `agent` tool and the Orchestrator's allowlist.
Configured handoffs are user-triggered Chat transitions. Separate Agent Sessions
and worktrees can isolate work when available; a fresh manual chat is the
fallback. Neither a role mention nor a script invocation means an agent ran.
See [agent system](ai/agent-system.md) for runtime and permission limits.

Reviewers lack edit and general execution tools. QA and Performance have
execution tools and are **not read-only by capability**: shell commands can
write. Tool restrictions, prompts and preview hooks are not an OS sandbox.
VS Code supports model frontmatter; the current roster leaves models unpinned.
Historical intended-model prose is not a runtime model selection.

## The Loop

Audit all [twelve areas](ai/quality-gates.md#twelve-audit-areas), prioritize
testable tasks, review risky design, implement claimed ready tasks, run QA,
obtain independent review, reconcile docs, then verify completion or block.
The [orchestration diagram](architecture/README.md#orchestration) shows the
dependency structure; the [workflow guide](ai/workflow.md) provides entry points.

An explicit acyclic graph and exact file/resource claims precede delegation.
Independent builders can run concurrently with approval and disjoint claims;
shared manifests, generated outputs, state and overlapping resources serialize.
QA follows the settled implementation, and review binds to its current content.
Readers of changing files and tests sharing a database are not independent.

Bounds remain: plan review 5, system design 3, implementation 3, code review 3,
security 2, performance 2 and final audit 2. Unresolved work at a bound is
**BLOCKED**. Reassignment cannot reset counters or replace an unwelcome verdict.

## Durable Evidence

The [product backlog](../.ai/backlog.json) remains canonical for priority.
The approved new execution projection is `.ai/engineering.json`; existing
progress, findings and release records retain their consumers. Its schema is
owned by the delivered validator, not inferred from Markdown. Read-only
reviewers return evidence; the Orchestrator records actual attributed results.

Append dated, content-bound snapshots to [.ai/review-log.txt](../.ai/review-log.txt), never
overwrite its history. Reports contain actual commands, outputs, participants,
skips and missing prerequisites, without secrets or private data. A dashboard
shows recorded state, not an independent observation of the runtime.

## Done Means Evidence

Use the [quality-gate contract](ai/quality-gates.md). `check` validates structure;
it is not `ready`. Execution readiness is not completion. `verify` must require
all applicable acceptance evidence and independent review bound to current
content. A SHA alone does not identify dirty worktree content.

P0/P1 findings block. Material P2 findings require resolution or explicit
evidence-based disposition; minor accepted risks remain visible. Required checks
that cannot run stay BLOCKED. Prove critical validators reject violating and
malformed input as well as accepting valid input. Never change the meaning of a
gate to obtain green output.

## Release And Other Workflows

The new [release prompt](../.github/prompts/careerscope-release.prompt.md) is
preparation only. The [initial audit](ai/initial-repository-audit.md) records
release/deployment enforcement gaps that this setup does not fix. No prompt or
passing local validator authorizes commit, push, publish or deployment.

[Claudex Loop](../.github/CLAUDEX-WORKFLOW.md) remains a separate cross-CLI
workflow, not a dependency of this native setup. Use one workflow per task;
do not invoke it here or install anything to make native discovery appear to work.

Native discovery and the full UI execution loop remain end-to-end unverified.
Source/configuration checks do not establish production readiness. The
[setup specification](../.ai/AGENT-SETUP.md) and
[troubleshooting guide](ai/troubleshooting.md) make those limits explicit.
