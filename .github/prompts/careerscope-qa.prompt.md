---
description: 'Run scoped CareerScope QA and report real output, skips, missing prerequisites and current-content evidence.'
agent: CareerScope Orchestrator
argument-hint: 'Changed scope, acceptance criteria, and required checks'
---

Use [TESTING](../../docs/TESTING.md),
[quality gates](../../docs/ai/quality-gates.md), and
[orchestration](../../docs/ai/orchestration.md).

Invoke CareerScope QA through the native allowlisted agent tool. QA has execute
capability, not an OS-level read-only sandbox. Give it settled implementation,
isolated synthetic data, allowed commands/resources, exact acceptance criteria
and current content identity. Serialize tests with shared mutable side effects.
Do not edit implementation or tests to obtain a pass.

Start with the nearest behavior check, then run all wider gates applicable to
scope. Verify valid, violating and malformed inputs for critical validators.
Browser, keyboard, reflow and axe evidence is not human screen-reader evidence.
Do not install browsers/services or access production to satisfy a missing
prerequisite without authorization.

Return actual commands, exit/results, totals, artifacts, skips, failures and
unverified requirements. Historical green results and unrun checks are not
evidence. Missing tools/services or unavailable real QA execution mean BLOCKED,
with the manual fallback or exact prerequisite named. Hand defects to a builder;
hand results to independent review. No deployment or completion by QA alone.
