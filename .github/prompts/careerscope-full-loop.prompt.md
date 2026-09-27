---
description: 'Run the bounded CareerScope engineering loop from twelve-area audit to evidence-based acceptance.'
agent: CareerScope Orchestrator
argument-hint: 'Approved goal, constraints, scope, and acceptance criteria'
---

Follow [workflow](../../docs/ai/workflow.md),
[orchestration](../../docs/ai/orchestration.md),
[agent matrix](../../docs/ai/agent-matrix.md), and
[quality gates](../../docs/ai/quality-gates.md).

1. Establish stack, current content, scope and existing approval. Preserve dirty
   work and never read secrets/environment files. Do not invent an empty-plan
   blocker when the user has approved the task.
2. Audit all twelve areas from the delivered policy: architecture; frontend;
   backend; database; security; accessibility; performance; SEO; testing; UX;
   documentation; production-readiness. Include CI/CD, operations and agent
   tooling/workflow evidence in the applicable areas, not extra invented gates.
   Record evidence or a specific not-applicable reason for every area before
   prioritizing tasks.
3. Build prioritized, testable tasks and an acyclic dependency graph with exact
   file/resource claims. Keep backlog canonical for product priority; the new
   execution state is a projection. Use the delivered validator schema, never
   fields invented from prose. Review risky design before implementation.
4. Invoke existing allowlisted agents through the native agent tool. Use the
   smallest sufficient team, not all 24 by default. Only explicitly approved
   independent builders with disjoint claims may overlap; serialize shared
   manifests, generated outputs and state. Scripts do not schedule agents.
5. Implement ready tasks, validate immediately, obtain actual QA and independent
   current-content review, and fix within bounds: plan review 5, system design
   3, implementation 3, code review 3, security 2, performance 2, final audit 2.
   Reassignment never resets a counter. Unresolved exhaustion means BLOCKED.
6. Reconcile owned docs/diagrams and append review snapshots; never overwrite
   history or fabricate activity. Require all applicable evidence and independent
   review before completion verification. `check` is not `ready`; neither is
   completion or production readiness.

When tools, services or native invocation are unavailable, name the missing
prerequisite and use an accurately attributed manual fresh-session fallback or
stop BLOCKED. No simulated participants, paid API, external CLI, install, new
server, shipping action or unapproved scope expansion. Return actual participants,
changed files, tests/results, unresolved findings and the next authorized action.
