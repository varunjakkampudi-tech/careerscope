---
description: 'Audit CareerScope across twelve engineering areas with source evidence and prioritized findings.'
agent: CareerScope Orchestrator
argument-hint: 'Scope, constraints, and acceptance questions'
---

Audit the requested scope using [workflow](../../docs/ai/workflow.md),
[quality gates](../../docs/ai/quality-gates.md), and the
[agent matrix](../../docs/ai/agent-matrix.md).

Establish previous implementation/CareerScope ownership, revision and dirty paths. Inspect relevant source and
nearby tests, not secrets or real environment files. Cover all twelve audit
areas before prioritizing findings; give explicit evidence for each finding or
not-applicable decision. Distinguish implemented, target, deployed and unverified.

Invoke only necessary allowlisted specialists through the native agent tool.
If unavailable, use an accurately attributed manual handoff or report BLOCKED.
Never simulate participants. Do not edit implementation during the audit.

Return severity-ordered findings with source references, proposed tasks,
acceptance checks, dependencies, file claims and missing evidence. Record only
observed activity under assigned ownership; append review snapshots rather than
overwriting history. The audit does not authorize installs, external CLIs, paid
APIs, new servers, commits, publication or deployment.
