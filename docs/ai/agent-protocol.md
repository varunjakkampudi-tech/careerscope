# Agent Protocol

Use the [existing roster](agent-matrix.md), not simulated named participants.
Only the Orchestrator delegates; specialist frontmatter uses `agents: []`.
Fifteen responsibilities map onto 24 agents and 20 skills, not 15 new agents.

## Dispatch And Return

1. Validate the [task contract](task-contract.md), prerequisites and claims.
   Select the smallest team: coordinator, scoped builder, QA, independent review;
   add domain specialists only for concrete risks.
2. Invoke the exact allowlisted native agent when available. Record invocation
   method and actual returned result. The operator reports real native QA and
   Independent Reviewer invocations for this assignment; do not invent others.
3. If delegation is unavailable, use a user-triggered handoff or fresh named
   session. Label that method accurately. If independence cannot be obtained,
   stop BLOCKED rather than writing the missing review yourself. A specialist's
   lack of nested invocation is not itself a blocker: the direct parent invokes
   QA/review and integrates their real returns; the delegate returns its scoped
   work without inventing participants or approving itself.
4. Builder returns implementation and focused evidence; QA executes checks
   without modifying the implementation to pass. Shell-capable QA needs isolated
   resources even though its role forbids code edits.
5. Reviewer consumes current source, requirements and evidence independently.
   Return APPROVED or CHANGES_REQUESTED with file-grounded findings and unknowns.
   A rejection is successful review, not a malfunctioning agent.
6. Orchestrator records only observed work, routes fixes within the same budget,
   and obtains renewed review after relevant changes. No recursive self-approval.

## Required Return Envelope

Task and role; invocation method; inspected/changed paths; revision and content
identity; commands with exits and meaningful output; artifacts; findings with
severity and reproduction; baseline classification; verdict; unresolved items;
next owner and remaining attempts. This is a prose handoff, not the exact runtime
schema; record only fields accepted by the implemented validators. Never forge
a compatible JSON record or claim signatures.

Read-only reviews can overlap against frozen content. Implementation, QA and
acceptance must respect data dependencies; overlapping test side effects are
writes. Use [context strategy](context-strategy.md) for bounded briefs and
[failure recovery](failure-recovery.md) when a delegate fails or rejects work.
