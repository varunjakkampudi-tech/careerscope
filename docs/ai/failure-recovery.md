# Failure Recovery

The full loop has **at most three remediation rounds**; smaller specialist
[bounds](orchestration.md#bounds-and-failures) still apply. This is operating
policy across tasks: schema 1 accepts task limits up to 20; schema 2 enforces
three retained remediation failures per task, not a global loop budget. It keeps
the INITIAL failure at attempt 0 and subsequent REMEDIATION failures at 1..3,
rejects repeated strategies and requires task ESCALATED when the third remains
unresolved. See [implemented lifecycle](state-machine.md).

## Diagnose Before Retrying

Capture task/check identity, content digest, command and exit, sanitized decisive
error, phase, prerequisites, and a stable failure signature. A signature should
identify the failing assertion/error class and relevant location, excluding
incidental timestamps/temp paths and private values. Never normalize away the
fact that input was missing or malformed. These are required report contents,
not permission to add arbitrary JSON fields. Schema-2 failure fields are defined
in [contract validation](../../scripts/engineering-contract.mjs); zero exit codes
with semantic failure and null exit codes are supported. Retain failed evidence
and link a successful same-command/check rerun with `resolvedBy`; passage requires
the rerun's current revision/digest. See [evidence](evidence-model.md).

Compare against the [baseline](baseline.md) using [evidence classifications](evidence-model.md).
QA red and reviewer CHANGES_REQUESTED are useful findings, not agent outages.
Repeat the same check after a cause-specific repair; changing the assertion,
threshold, gate applicability or reviewer merely to obtain green is prohibited.

| Failure                         | Recovery                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Reproducible regression         | Introducing builder repairs its owned slice; QA reruns; reviewer inspects new content                   |
| Baseline-existing failure       | Preserve signature and ownership; fix only with authorization; still blocks an applicable required gate |
| Missing tool/service/permission | Name exact prerequisite and owner; BLOCKED, no install/credential workaround                            |
| Malformed/unreadable state      | Fail closed; parent repairs canonical records from verified source, not an empty default                |
| Unknown/ambiguous result        | One bounded discriminating check; retain UNKNOWN until evidence distinguishes causes                    |
| Agent error/no useful return    | Clarify once, use an existing fallback, then split if feasible within remaining budget                  |
| Repeated unchanged signature    | Stop blind retries; escalate cause and required decision                                                |
| Exhausted budget                | Preserve all attempts/findings; BLOCKED with next owner and action                                      |

Reassignment, splitting and a fresh session do not reset the original budget.
Retain the link to the original task. A reviewer rejecting a real defect must
not be replaced to shop for approval. Re-review follows new evidence.

## Safe Resume

Before resuming, check current source/digest, competing claims, dependencies,
approval and remaining attempts. Re-establish missing prerequisites and rerun
affected checks. Do not restore another agent's files, blind-merge, mutate owner
data or infer that stale RUNNING prose means a process is alive. Escalate R5 to
the human. Parent-owned records must not be rewritten by a recovering delegate.
