# Repository-Local Copilot Engineering

Use **CareerScope Orchestrator** in VS Code Copilot Chat. This setup reuses the
repository's specialist agents and skills; it does not require a paid model API,
another CLI, an installation, or another MCP server.

## Start Here

1. Read [project state](../PROJECT-STATE.md) to choose previous implementation or CareerScope.
2. Use [workflow](workflow.md) for the six repository prompts and their boundaries.
3. Check [quality gates](quality-gates.md) before making a completion claim.

For the expanded engineering OS, start with [capabilities](capability-matrix.md)
and [limitations](limitations.md), then write a [task contract](task-contract.md).
The [baseline](baseline.md) records actual pre-change QA; it is not completion
evidence for later edits. The workflow is operator/Copilot driven, not a daemon.

## Operating Contracts

- Plan: [risk](risk-model.md), [ownership](ownership.md),
  [Git isolation](git-isolation.md).
- Dispatch: [agent protocol](agent-protocol.md),
  [context strategy](context-strategy.md), [state machine](state-machine.md).
- Accept or recover: [evidence](evidence-model.md),
  [failure recovery](failure-recovery.md), [observability](observability.md).
- Integrate: [hooks](hooks.md), [MCP](mcp.md), [full loop](workflow.md).

The [validator](../../scripts/engineering.mjs) supports legacy schema 1 and
expanded schema 2; [contract validation](../../scripts/engineering-contract.mjs)
implements lifecycle, risk, baseline and failure rules. The separate
[runner](../../scripts/engineering-runner.mjs) executes opt-in fixed check IDs.
Implementation does not upgrade existing schema-1 records or establish completion.
No shadow YAML gate or ownership registry is used.

| Reference                                               | Purpose                                                         |
| ------------------------------------------------------- | --------------------------------------------------------------- |
| [Agent system](agent-system.md)                         | Native capabilities and their limits                            |
| [Agent matrix](agent-matrix.md)                         | Requested roles mapped to existing agents and skills            |
| [Orchestration](orchestration.md)                       | Dependencies, file claims, handoffs and bounded loops           |
| [Quality gates](quality-gates.md)                       | Evidence, check versus ready, completion                        |
| [Workflow](workflow.md)                                 | Audit, implement, review, QA, release preparation and full loop |
| [Troubleshooting](troubleshooting.md)                   | Discovery, blocked checks and manual fallback                   |
| [MCP](mcp.md)                                           | Existing server metadata and native-tool fallback               |
| [Architecture index](../architecture/README.md)         | Source-linked system and workflow diagrams                      |
| [Initial repository audit](initial-repository-audit.md) | Dated source evidence and unresolved findings                   |

## Scope And Evidence

This is an engineering workflow, not a production-readiness certificate. The
initial audit records the inspected revision and observed configuration. Its
historical results are not fresh verification of subsequent edits. Native
prompt/agent discovery and the complete VS Code UI loop still need end-to-end
operator verification.

Local scripts validate records; they do not schedule agents. Record only agents
actually invoked and checks actually run. Missing tools or evidence mean
**BLOCKED**, not simulated participation. Release preparation does not authorize
committing, pushing, publishing, deployment, or changes to production.
