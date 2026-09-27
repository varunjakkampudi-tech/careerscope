---
description: 'Obtain an independent CareerScope review tied to the current requirements and content.'
agent: CareerScope Orchestrator
argument-hint: 'Requirements, diff or file scope, and evidence'
---

Use [agent matrix](../../docs/ai/agent-matrix.md),
[orchestration](../../docs/ai/orchestration.md), and
[quality gates](../../docs/ai/quality-gates.md).

Invoke CareerScope Independent Reviewer through the native allowlisted agent
tool with requirements, source, current diff/content identity and real check
evidence. Add domain reviewers only for specific risks. Use a fresh reviewer
execution, not a builder-written review section. If unavailable, request the
manual fresh-session handoff and keep acceptance BLOCKED until its actual return.

Review correctness, security, failures, performance, accessibility, data and API
contracts, tests that can fail, documentation drift and unauthorized changes.
Inspect implementation rather than trusting summaries. Reviewers do not edit
the content they grade or receive wider tools to make the review convenient.

Return findings first, ordered P0-P3 with file references, impact and a focused
check; then verdict, assumptions, uncovered risks and next owner. Bind the
verdict to the reviewed content. Changes require affected rechecks and review.
Do not reset round counts by reassigning reviewers. No simulated approvals,
installs, external CLIs, paid APIs, new servers or shipping actions.
