# Capability Matrix

Start here before promising automation. Evidence below combines inspected
[agent files](../../.github/agents), the [validator](../../scripts/engineering.mjs)
and the operator's reported native invocations in this assignment. Availability
is session-specific; configuration is not execution evidence.

| Capability                              | Observed state                                                                                             | Boundary or fallback                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Native specialists                      | Operator reports actual `functions.runSubagent` calls to CareerScope QA and Independent Reviewer this turn | Record their returned artifacts; this documentation delegate did not invoke them       |
| Roster and skills                       | Customization scan found 24 agents and 20 local skills                                                     | Use the [15-responsibility map](agent-matrix.md); no duplicate roles or skills         |
| File reads/edits and terminal           | Available; scoped reads, patches and pinned-Node checks executed here                                      | Claims constrain permission, not OS access; reviewers retain narrower grants           |
| Browser/Playwright                      | Surfaced in the parent session's tool inventory                                                            | No browser evidence produced here; availability does not prove a page or service works |
| Handoffs                                | Configured user transitions                                                                                | Not background autonomous scheduling                                                   |
| Agent Sessions/worktrees UI             | Activation unverified                                                                                      | Fresh user-opened session with a bounded brief; see [Git isolation](git-isolation.md)  |
| Git worktrees                           | Operator reports Git support and one existing worktree                                                     | No worktree or branch created; dirty shared-tree fallback uses literal claims          |
| SessionStart hook                       | Config and bounded handler exist; hook tests in baseline                                                   | Actual VS Code event firing unverified; see [hooks](hooks.md)                          |
| Task validation                         | `check`, `ready`, `status`, `verify`, `help` in inspected CLI                                              | Read-only record validation, not an agent dispatcher                                   |
| Schema-2 lifecycle/risk/failure records | Implemented in [contract validation](../../scripts/engineering-contract.mjs)                               | Legacy records remain schema 1; do not fabricate migration history                     |
| Fixed command-ID runner                 | Implemented; `help` and `list` inspected/executed                                                          | Opt-in local checks, no scheduling or state writes by the runner; not a sandbox        |
| MCP                                     | Existing repository server metadata and surfaced native tools only                                         | No credentials read; no server health claim without a successful scoped call           |
| Models, token counts and latency        | Picker chooses model; true token/provider latency telemetry unavailable                                    | Report unknown, never infer a model from intended-model prose                          |

## Environment

Actual workspace: Windows, `C:\Users\Admin\Desktop\careerscope`. Supplied Mac
paths are not paths on this host. The [baseline](baseline.md) records default
Node 22 as unsupported and existing pinned Node 26 as working; both
[root](../../package.json) and [CareerScope](../../package.json) require Node >=24.

From the repository root in PowerShell, this invocation was executed here:

```powershell
& ./data/windows-toolchain/node_modules/node/bin/node.exe scripts/engineering.mjs help
```

Use that executable for the documented Node commands on this machine. Do not
install a replacement, print environment values or invoke a launcher that loads
private configuration. Scope-only checks do not establish product readiness.
Continue with [limitations](limitations.md) and [task contract](task-contract.md).
