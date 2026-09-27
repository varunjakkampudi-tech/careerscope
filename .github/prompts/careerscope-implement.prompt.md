---
description: 'Implement approved CareerScope tasks with file ownership, regression checks and independent handoff.'
agent: CareerScope Orchestrator
argument-hint: 'Approved task, acceptance criteria, and allowed files'
---

Use [orchestration](../../docs/ai/orchestration.md),
[agent matrix](../../docs/ai/agent-matrix.md), and
[quality gates](../../docs/ai/quality-gates.md). Honor existing explicit approval;
do not demand a new empty-plan ceremony. Clarify only genuinely missing decisions.

Confirm task prerequisites, exact file claims and an acyclic dependency graph.
Select the existing tier builder or Senior Engineer and invoke it through the
native allowlisted agent tool. Approved independent builders may run in parallel
only on disjoint claims; serialize manifests, generated outputs and shared state.
Unavailable invocation means a truthful manual fallback or BLOCKED.

Require affected source, nearest baseline test and relevant skills before edits.
Make the smallest defensible change and validate promptly. Add realistic
regressions and valid/violating/malformed cases for new validators. Never weaken
gates, security or tests, and never modify another owner's files.

Return exact changed files, actual commands/results, gaps and a content-bound
handoff to QA and an independent reviewer. Builders cannot certify their own
completion. Respect bounded rounds; unresolved exhaustion is BLOCKED. No installs,
paid APIs, external CLIs, new servers or shipping actions are authorized.
