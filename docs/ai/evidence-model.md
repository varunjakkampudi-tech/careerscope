# Evidence Model

[baseline.json](baseline.json) and [baseline.md](baseline.md) are authoritative
pre-change observations from the actual QA invocation. Preserve them. Post-change
checks belong in new attributed records, not edits that make the baseline green.
The measured clock differs from the conversation date; preserve measured times.

## What A Result Must Establish

Bind each result to a requirement/check, command, environment/prerequisites,
revision and current scoped content digest. Retain exit status, meaningful output,
totals/skips, artifacts and verifier identity. An unrun check is unknown, not
PASS. A zero exit code still requires inspection of what the command asserted.
Critical validators need valid, violating and malformed fixtures, followed by a
restored-input pass; isolate those fixtures from canonical state.

The [validator](../../scripts/engineering.mjs) accepts, in both state schemas,
evidence keys `id`, `check`, `kind`, `command`, `result`, `revision`, `digest`,
`recordedAt`. `kind` is acceptance or regression; `result` is PASS or FAIL.
The schema-1 review carries agent, verdict, revision, digest and reviewedAt;
schema-2 task final reviews add findings. Schema-2 role reviews and failures have
separate shapes in [contract validation](../../scripts/engineering-contract.mjs).
Runner output is a separate report, not a drop-in evidence record. Keep details
outside the accepted evidence shape in attributed reports, not invented fields.

The digest is **objective-wide**, not per-task: it binds all tasks' claimed bytes,
directory membership and missing paths, plus selected objective/task/gate
definitions. Any claimed content change, including documentation formatting,
invalidates prior digest-bound evidence and approval across the objective.
Schema 2 additionally binds baseline bytes and contract inputs, including
meaningful execution and failure history.

To avoid cycles, reporting fields, evidence, reviews, failure `resolvedBy` links
and only the trailing finding-free REVIEW/PASSED/COMPLETE history events are
excluded. Resolution links are still validated against successful reruns for the
same command/check; passage requires those reruns at the current revision/digest.
Non-trailing events and events with findings remain bound. The special state and
gate files bind selected definitions rather than their raw reporting bytes.

It is **not a signature**. Distinct agent names are not identity attestation, and
command text is not evidence of execution. Independent review must examine source
and actual invocation/output, including negative evidence.

## Baseline Comparison

| Classification        | Evidence required                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------- |
| BASELINE_EXISTING     | Same command/check and materially same failure signature demonstrated in the baseline    |
| REGRESSION_INTRODUCED | Passing relevant baseline plus new failure attributable to changed content               |
| UNKNOWN               | Missing comparable baseline, changed prerequisites, ambiguous attribution or unrun check |

Do not classify by exit code alone. The baseline's missing review metadata,
audit format failure and incomplete-objective refusal are distinct signatures.
The introducing task owns a regression until evidence disproves attribution.
Fixes need a focused rerun and independent review; historical failure records
remain history, not rewritten PASS records. Schema 2 retains failed task evidence
and links successful reruns through `resolvedBy`; unresolved failures prevent
passage. Schema-1 tasks and quality gates cannot retain FAIL in a completed proof
array; gate failure supersession is not implemented.

A schema-2 contract baseline must have exactly
`{schemaVersion: 1, failures: [{checkId, signature}]}`; entries must be unique,
nonempty string pairs. An empty failures array is allowed, but missing/malformed
input is not. BASELINE_EXISTING requires an exact checkId/signature match;
REGRESSION_INTRODUCED and UNKNOWN require no such match. This consistency check
does not prove causal attribution. Historical QA artifacts remain preserved,
not silently converted into this input format. In particular, the preserved
[baseline.json](baseline.json) contains `known_failures` and QA metadata, not
the required `failures` shape, so it is not a valid schema-2 contract baseline.
The CLI help points to a separately prepared strict baseline and explicitly
preserves the historical report. Preparing a separate compatible record requires
an authorized owner and actual evidence; this reconciliation creates no record.

Failure records accept a nonnegative integer exit code or null, paired with
FAIL/TIMEOUT/TRUNCATED/ERROR: exit zero can still be a semantic failure, and null
can mean no exit code. Neither makes an unsuccessful result pass.

## Runner Results

The [runner](../../scripts/engineering-runner.mjs) accepts only its exported
fixed check IDs. PASS requires exit zero without spawn errors, signals, timeout
or truncation, and unchanged revision, objective digest and command-script digest.
For engineering-tests it also requires recognized TAP with matching trailing
plans and sequential result numbers at the top level and recursively within
nested results. Test and suite counts and outcome totals must reconcile with the
summary. Missing/mismatched plans, malformed numbering, contradictory results,
`Bail out!`, empty outcomes, skips, todo, cancellations or failures cannot pass.
Output is represented by byte counts and hashes, not disclosed stdout/stderr.
This does not authenticate execution records or make mutable scripts safe.

## Acceptance

Use [quality gates](quality-gates.md) and the canonical
[JSON policy](../../quality-gates.json), never a second YAML gate file. Relevant
edits invalidate evidence and review. Required missing checks, unresolved
blocking findings, stale approval and exhausted attempts mean BLOCKED.
Exclusions need scope-specific independent justification, not a blanket "docs
only" waiver. [Recovery](failure-recovery.md) explains the next action.
