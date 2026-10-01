# Orchestration

The Orchestrator is the requested CTO/coordinator role. Use the
[role matrix](agent-matrix.md), not a new CTO agent. The normal team is
Orchestrator, one builder, QA and Independent Reviewer; add specialists for
specific risks and evidence. A full audit covers every area, not every agent.

Start with the [task contract](task-contract.md), [risk](risk-model.md) and
[baseline](baseline.md); use [agent protocol](agent-protocol.md) for invocation
and [context strategy](context-strategy.md) for the handoff packet. The
[state machine](state-machine.md) is operator/Copilot driven, not a scheduler.

## Task Graph And Ownership

Before dispatch, describe each task's acceptance criteria, owner, exact file
claims, prerequisites, expected evidence, next consumer and stopping condition.
Use an explicit acyclic dependency graph. Ready work has satisfied prerequisites;
an independent task is not merely one in a differently named folder.

Independent builders may run concurrently only with explicit approval and
disjoint claims. Include generated outputs and test side effects in those
claims. Serialize shared manifests, lockfiles, global styles, common contracts,
state records and any overlapping file. The current Visual Designer contract
forbids concurrency with Frontend; honor that stricter rule pending parent
reconciliation. Separate worktrees help isolation but
do not remove integration conflicts or make shared databases independent.

Review readers can run concurrently against a frozen input. QA and Performance
need exclusive or isolated mutable resources: their execution tools make them
potential writers. Do not run tests that rewrite canonical state concurrently.
QA consumes a settled implementation; review consumes the exact validated
content. Integration and review follow all prerequisite builders.

## A Handoff Must Be Reproducible

Supply the task and requirement IDs, repository revision plus current content
identity, files to read, files allowed to change, prohibited actions, applicable
instructions/skills, acceptance checks, round count and expected output. The
recipient returns changed files or findings, actual commands/results, missing
prerequisites and a justified verdict. Do not pass secrets or rely on chat memory.

The native call must name an allowlisted agent. User-triggered handoffs and
manual fresh sessions are alternatives, not evidence that a native invocation
occurred. Record the method actually used and attribute human work to the human.

## Bounds And Failures

| Loop               | Maximum rounds |
| ------------------ | -------------- |
| Plan review        | 5              |
| System design      | 3              |
| Implementation     | 3              |
| Code review        | 3              |
| Security review    | 2              |
| Performance review | 2              |
| Final audit        | 2              |

The full loop has at most **three remediation rounds**, without enlarging any
smaller bound above. Schema 1 permits task limits up to 20. Schema 2 fixes each
task's limit at 3, counts retained remediation failures, rejects repeated
strategies/counter gaps and requires ESCALATED after an unresolved third failure.
It does not enforce an aggregate cross-task loop budget or the specialist limits
above; those remain coordinator policy. See [failure recovery](failure-recovery.md).

If unresolved work reaches its bound, stop **BLOCKED**, preserve the evidence,
and name the required decision. Reassignment or task splitting does not reset
the counter. A reviewer finding a defect has succeeded at review; do not replace
them to obtain approval. Missing access, tools, services or independent review
is a blocker, not permission to simulate the step.

## Durable Records

Product priority remains in the [backlog](../../.ai/backlog.json). The existing
[.ai/engineering.json](../../.ai/engineering.json) is an execution projection, not a second product
backlog or a replacement for existing release/progress consumers. Its exact
schema belongs to the validator implementation; do not invent fields here.
The Orchestrator is the single recorder unless an explicit claim delegates a
specific record. Builders return evidence rather than racing to update state.

Append dated, revision/content-bound snapshots to [.ai/review-log.txt](../../.ai/review-log.txt);
never overwrite its history. Distinguish observed activity from planned work.
Use [quality gates](quality-gates.md) to assess completion: a progress label, an
agent's self-report, or a syntactically valid record is not proof.

[Ownership](ownership.md) defines literal canonical JSON claims, with no shadow
YAML registry. [Git isolation](git-isolation.md) covers the dirty shared-tree
fallback; [observability](observability.md) separates reported metrics from
unavailable telemetry. Current gaps live in [limitations](limitations.md).
