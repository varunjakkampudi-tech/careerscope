# Workflow

Open the repository in trusted VS Code and select **CareerScope Orchestrator**.
Use a prompt through Chat's slash menu, **Chat: Run Prompt...**, or the prompt
editor's run button. Discovery must be verified in this installation; merely
having a file on disk is not end-to-end verification.

## Choose The Smallest Entry Point

| Prompt                                                                         | Input                                 | Outcome                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------------------- |
| [careerscope-audit](../../.github/prompts/careerscope-audit.prompt.md)         | Scope and current constraints         | Twelve-area evidence and prioritized findings; no automatic fixes                   |
| [careerscope-implement](../../.github/prompts/careerscope-implement.prompt.md) | Approved task and acceptance criteria | Claimed implementation, tests and handoff, not self-approval                        |
| [careerscope-review](../../.github/prompts/careerscope-review.prompt.md)       | Current content/diff and requirements | Real independent review, findings and bounded verdict                               |
| [careerscope-qa](../../.github/prompts/careerscope-qa.prompt.md)               | Changed scope and required checks     | Actual execution results, skips and blockers                                        |
| [careerscope-release](../../.github/prompts/careerscope-release.prompt.md)     | Candidate scope and evidence          | Preparation-only GO/NO-GO; never a deployment                                       |
| [careerscope-full-loop](../../.github/prompts/careerscope-full-loop.prompt.md) | Approved goal and constraints         | Audit, prioritized graph, implementation, QA, review and honest completion decision |

All six target the existing Orchestrator and inherit its tools. A prompt is a
reusable brief, not an agent scheduler or tool-permission override. Actual
delegation uses native allowlisted calls; if unavailable, use the
[manual fallback](troubleshooting.md) and label it accurately.

## Full Loop

This is an **operator/Copilot-driven target loop**, not an automatic daemon.
Use the [state diagram](state-machine.md), [task contract](task-contract.md),
[risk model](risk-model.md) and [baseline](baseline.md). Version-2 lifecycle and
fixed-ID runner checks are implemented; [quality gates](quality-gates.md) and
[evidence](evidence-model.md) describe their boundaries. They neither schedule
this loop nor prove native UI/hook integration.

1. **Establish scope:** read project state, affected source and nearby tests;
   capture revision and dirty paths without reading secrets. Honor approval
   already supplied; do not fabricate an empty-plan approval blocker.
2. **Audit all twelve areas:** use [quality gates](quality-gates.md), collect
   source evidence, mark unknowns, and distinguish intentional limitations.
3. **Prioritize:** turn findings into accepted, testable tasks; keep product
   priority in the existing backlog and execution in its projection.
4. **Plan and review:** name owners, exact claims, dependency graph, required
   evidence and applicable specialists. Review risky design before writing.
5. **Implement:** dispatch only approved ready tasks. Independent builders may
   overlap only with explicit disjoint claims; shared manifests serialize.
6. **Validate and inspect:** run focused checks promptly, then applicable wider
   checks. QA executes; independent reviewers inspect the current content.
   Compare failure signatures with the baseline, fix findings within a maximum
   of three full-loop remediation rounds and the smaller specialist bounds,
   then rerun affected checks. Independent rejection prevents acceptance.
7. **Reconcile:** update owned docs/diagrams and evidence; append a review
   snapshot without replacing history. Record only actual participants. Finish
   claimed content edits, including formatting, before final evidence and review:
   those edits change the objective-wide digest and invalidate prior bindings.
8. **Verify or block:** require all applicable current-content evidence and
   independent review. Stop at a bound or missing prerequisite with a precise
   **BLOCKED** reason and next action. Completion is not ship authorization.

See [orchestration](orchestration.md) for limits and file ownership. Sessions and
worktrees are execution options, not substitutes for a dependency graph.
Use [failure recovery](failure-recovery.md) for blocked work and
[limitations](limitations.md) for current enforcement and integration gaps.

## Daily Use And Safety

Read the validator's delivered policy before using its agreed
`check`, `ready`, `status` or `verify` operations. `check` is not `ready`, and
neither grants permission to release. If the implementation is absent or the
schema cannot be parsed, stop rather than inventing compatible state.

No paid API, external CLI, install, new server, production operation, account
creation or job application is part of this workflow. Keep product AI off,
auto-apply on hold and Naukri legitimate-access only. Keep private configuration,
resumes and browser state out of reports. The separate Claudex workflow is not
invoked or required here.
