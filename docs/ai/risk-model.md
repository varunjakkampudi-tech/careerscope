# Risk Model

Schema 2 enforces the following exact role/check mapping from
[`RISK_ROLES`](../../scripts/engineering-contract.mjs). Schema 1 does not enforce
these contracts. The operator classifies risk from the highest credible effect,
including command side effects; the validator does not infer risk from a diff.

| Class | Required roles                                                        |
| ----- | --------------------------------------------------------------------- |
| R0    | documentation                                                         |
| R1    | testing, code-review                                                  |
| R2    | testing, code-review, performance                                     |
| R3    | testing, architecture, security, integration, regression, code-review |
| R4    | testing, cto, architecture, security, regression, code-review         |
| R5    | testing, cto, architecture, security, regression, code-review         |

Each required role needs current independent approval. Only testing/performance
checks in R1/R2 may be excluded with a reason; their role approval is still
required. Applicable checks need successful current evidence. These role keys
are not agent IDs or proof of specialist invocation.

`approvalRequired` can require human approval at any risk level; R5 always
requires it before assignment and is never automatically ready. Missing required
approval requires BLOCKED. R4 does not automatically require human approval in
the validator; repository authorization rules still apply.

R5 is never granted by a role ceiling, passing gates, "full loop", or approval
to edit docs. Irreversible migration, secret access and external submission
remain prohibited unless specifically authorized; some repository prohibitions
remain absolute even with a broadly worded request. AI stays off, auto-apply on
hold, and Naukri legitimate-access only.

## Escalation

Classify before dispatch. If source inspection reveals a higher-risk effect,
stop and revise the approved contract, reviewer set and checks. Read-only advice
may analyze R5, but no agent autonomously executes it. The
[role matrix](agent-matrix.md) caps default execution scope, not review depth.

The implemented [runner](../../scripts/engineering-runner.mjs) accepts fixed
check IDs and validates engineering artifacts before execution. It does not
derive commands from task/evidence text or grant action-specific authorization.
It uses the current Node executable without a shell, with bounded time/output
and a filtered environment. Mutable allowlisted scripts still require review:
this is not a sandbox or scheduler.
