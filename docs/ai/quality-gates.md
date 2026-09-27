# Quality Gates

**Configuration validity is not task readiness, and task readiness is not
completion.** Compilation is not production readiness. Use
[TESTING](../TESTING.md) for the stack-specific test inventory, but obtain fresh
results for the content being accepted rather than quoting its historical totals.

## Local Validator Contract

The interface is `node scripts/engineering.mjs check|ready|status|verify`,
with policy in root `quality-gates.json` and execution projection in
`.ai/engineering.json`. The [validator source](../../scripts/engineering.mjs)
and its help own the exact schema. Source inspection is not a claim that an
unobserved invocation passed. Do not invent state fields from this prose.

[quality-gates.json](../../quality-gates.json) is the sole gate authority; do not
add a duplicate YAML policy. [Evidence model](evidence-model.md) defines the
reporting standard, [baseline](baseline.md) the actual pre-change comparison,
and [limitations](limitations.md) the unresolved enforcement gaps. Use the
[pinned runtime](capability-matrix.md#environment) on this Windows host.

The CLI supports schema 1 (`LEGACY_V1`) and schema 2 (`EXPANDED_V2`). Schema 2
adds validated task contracts; objective and gate shapes remain schema 1.
The [contract validator](../../scripts/engineering-contract.mjs) owns lifecycle,
risk, baseline and failure rules. A separate opt-in
[runner](../../scripts/engineering-runner.mjs) executes fixed check IDs, not
command strings from evidence. See [evidence](evidence-model.md) for digest and
runner-result limits. Neither source presence nor `check` proves task completion.

| Operation | Required meaning                                                                                                                                                                                                                                                                  |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check`   | Validate configuration, records and graph integrity. A structurally valid blocked/incomplete task may pass.                                                                                                                                                                       |
| `ready`   | Report eligible NOT_STARTED tasks in schema 1 or READY tasks in schema 2, excluding R5 in schema 2. Requires an IN_PROGRESS objective at HEAD, remaining attempts, COMPLETE dependencies and no active claim conflict. Empty valid results can exit 0; this is not authorization. |
| `status`  | Report recorded state and missing evidence honestly; do not manufacture progress or agent activity.                                                                                                                                                                               |
| `verify`  | Refuse completion unless all applicable acceptance evidence and independent review match the current content.                                                                                                                                                                     |

Malformed, unreadable or missing required inputs must fail closed. An absent
result is not a pass; an empty plan is not completed work. Validator tests need
valid, violating and malformed fixtures, isolated from canonical records. Stale
review, dependency cycles, conflicting claims and changed content must be
rejected where applicable. No script schedules agents or proves UI discovery.

The validator checks record consistency, not truthfulness, actual test execution,
reviewer identity or undeclared file scope. A distinct reviewer ID in JSON is
not evidence that an independent review happened. The operator and real reviewer
must check the underlying artifacts and invocation history.

## Twelve Audit Areas

Every full-loop audit covers these areas before prioritizing work. Record
evidence-backed findings or a specific, reviewable not-applicable rationale for
each. The twelve names below match the source's `AREAS` list. Inspect the
delivered policy before recording machine state; this table does not define its
record schema.

| Area                   | Minimum evidence to consider                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `architecture`         | V1/V2 ownership, module/data boundaries, source-linked diagrams                           |
| `frontend`             | Components, state handling and responsive browser checks when affected                    |
| `backend`              | API validation, contracts, failure isolation, cancellation and retries                    |
| `database`             | Schema/migrations, owner isolation, transactions, recovery and query risks                |
| `security`             | Sessions, CSRF/origin, authorization, secret handling and external input                  |
| `accessibility`        | Automated audit, keyboard/reflow, explicit human-validation gaps                          |
| `performance`          | Measured relevant workload, budgets and resource limits                                   |
| `seo`                  | Public metadata/indexing controls; private routes must remain private                     |
| `testing`              | Behavior coverage, negative/malformed cases, skips and realistic isolation                |
| `ux`                   | User journeys, loading/empty/error states, navigation and task completion                 |
| `documentation`        | Claims, links, commands, architecture drift and unverified behavior                       |
| `production-readiness` | CI/CD, build order, deployment/recovery, operational gaps and applicable tooling evidence |

Audit native discovery, tools/allowlists, graph/claims and evidence/state honesty
across architecture, security, testing and production-readiness. These are not a
thirteenth gate. The production-readiness label demands evidence; it does not
certify production or remove known release/CI gaps.

## Evidence And Completion

Bind evidence to requirements, the checked files and their current content, not
only a commit SHA in a dirty worktree. Capture the command, environment and
prerequisites, time, exit status, meaningful output/totals, skipped coverage,
artifacts and actual verifier identity. Keep secrets and personal data out.
The digest spans all tasks in the objective, including claimed documentation
bytes and formatting. After changing claimed content or bound definitions,
refresh the evidence and independent approvals needed for that objective's
passage. A prior approval cannot certify a later patch; see
[digest exclusions](evidence-model.md#what-a-result-must-establish).

Completion requires accepted criteria, all applicable gates, independent review,
current docs and an ownership-clean diff. P0/P1 findings block; correctness,
security, accessibility and architecture P2s need resolution or explicit,
evidence-based disposition. Unrun required checks, unknown results, exhausted
bounds and unavailable independent review mean **BLOCKED**. Non-applicability
requires a reason reviewed against scope, not a blanket exemption.

Start narrow after each edit. Broad code changes and release preparation need
the full applicable stack checks in [TESTING](../TESTING.md), plus browser,
runtime, storage or queue gates the change affects. Tooling-only checks do not
certify application behavior. Legacy gate tests that mutate canonical records
must not run concurrently with other writers; prefer isolated fixtures.

## Release Is A Separate Decision

The [initial audit](initial-repository-audit.md) records unresolved release-state
and deployment enforcement flaws (AI-03, AI-04, AI-10). Gate mutation tests do
not mean the current release record was accepted by deployment. Do not weaken
gates or label these defects fixed because documentation now describes them.
The new release prompt prepares evidence and a GO/NO-GO recommendation only.
It does not authorize shipping, change production, or replace the existing
release procedure. Live provenance and human screen-reader evidence remain
separate requirements where relevant.
