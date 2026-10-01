# Observability

Observe recorded facts, not implied autonomous activity. The inspected
[CLI](../../scripts/engineering.mjs) exposes `status` with objective/task/gate
statuses, digest, readiness and completion blockers. `ready` reports eligible
task IDs without executing them. Invalid input is an error, never an empty
healthy dashboard. See [capabilities](capability-matrix.md) for pinned Node usage.

## Supported Measures

These are record-derived measures, not a claim that a dashboard already renders
them. Use only records that pass validation and retain the CLI's LEGACY_previous implementation or
EXPANDED_CareerScope assurance distinction. Neither authenticates agent activity.

| Measure                      | Definition and limitation                                                                             |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| Recorded completed tasks     | Count tasks with status COMPLETE; total is tasks.length                                               |
| Recorded completion fraction | COMPLETE task count / total task count; not product feature completion                                |
| Recorded blocked tasks       | Count tasks with status BLOCKED; show each blockedReason                                              |
| Attempts consumed            | Sum task.attempts; schema 2 validates this against retained REMEDIATION failures, not all invocations |
| Remaining per-task budget    | attemptLimit minus attempts; does not prove a global remediation cap                                  |
| Current eligible tasks       | Validator result.ready; dependent on revision, status, dependencies and conflicts                     |
| Recorded evidence outcomes   | Count PASS/FAIL evidence separately; records are not independent executions                           |
| Missing completion evidence  | result.completionErrors; retain distinct causes rather than a single percentage                       |

Canonical timestamps indicate when a record says it was created/updated; their
difference is **not** execution time, model latency or active effort. True token
counts, model cost, provider latency, live agent liveness and escaped-defect rate
are unknown without the requisite observations/denominator. Do not invent zeros
or rank agents by findings or speed. Schema-2 failure signatures and lifecycle
timestamps are available for recorded-history analysis, not measured runtime
telemetry; never fabricate them for legacy records.

## Audit Trail

The parent appends dated content-bound snapshots to [.ai/review-log.txt](../../.ai/review-log.txt)
and records actual invocations, checks, failures and decisions. Preserve history;
review labels are attributed, not signed or tamperproof. Baseline and post-change
results remain distinguishable. Sanitized errors should identify causes without
exposing secrets, user content or raw private tool payloads.

A configured hook or a stale RUNNING projection is not a heartbeat. Required
missing telemetry is explicit unknown/BLOCKED as appropriate, not proof that
work is happening. See [evidence](evidence-model.md) and [limitations](limitations.md).
