---
description: 'Prepare CareerScope release evidence and a GO/NO-GO recommendation without shipping.'
agent: CareerScope Orchestrator
argument-hint: 'Candidate release scope and existing acceptance evidence'
---

This is **release preparation only**. It does not authorize commit, push, tag,
publish, deployment, infrastructure changes or production tests. Do not invoke
the legacy shipping prompt as an implicit next step.

Use [quality gates](../../docs/ai/quality-gates.md),
[initial audit](../../docs/ai/initial-repository-audit.md), and
[orchestration](../../docs/ai/orchestration.md). Read the existing release scope
and candidate diff. Reconcile product backlog scope without rewriting history.

Invoke the existing Release Manager, Documentation, QA and independent review
roles only as needed through real allowlisted native calls. Do not simulate a
participant if invocation fails. Documentation acceptance requires actual drift
review and updates, not setting a key to satisfy a gate.

Distinguish validator `check`, execution `ready` and completion `verify`.
Require all applicable evidence plus independent review of current content.
Account explicitly for audited release-state/deployment flaws, missing CareerScope
integration coverage, live provenance and human validation. Do not claim those
gaps are fixed by this setup or silently inherit an old pass.

Return scope, exact verified evidence, documentation delta, rollback/operational
gaps, open findings and GO/NO-GO with blockers. Append only authorized review
snapshots. An unavailable prerequisite or exhausted bound is BLOCKED. No paid
API, external CLI, install or new server is required or authorized.
