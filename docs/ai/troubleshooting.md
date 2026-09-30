# Troubleshooting

## Native Discovery

If a prompt is missing, confirm it is under `.github/prompts/` with a
`.prompt.md` extension and valid YAML frontmatter. The six new prompts select
`agent: CareerScope Orchestrator`; they do not override tools. Try
**Chat: Run Prompt...** or the prompt editor run button, and inspect customization
diagnostics. Do not install an extension or edit user settings merely to make a
repository check pass.

For missing delegation, inspect the Orchestrator's actual tool list for `agent`
and the target name in its `agents` allowlist. A handoff button is a user
transition, not proof that a subagent was invoked. Check the actual returned
result. Missing runtime capability means manual fallback or BLOCKED, never a
report written under an agent's name without its participation.

Native discovery and the complete UI workflow remain **end-to-end unverified**.
To close that gap, an operator must discover and run the prompts in VS Code,
observe a real allowlisted delegate return, confirm reviewer tool restrictions,
and exercise a bounded failure/manual fallback without fabricating state.

## Manual Fallback

Open a fresh chat or Agent Session with the named existing agent. Supply the
bounded brief from [orchestration](orchestration.md): requirements, current
content, sources, claims, dependencies, checks and round count. Return its actual
verdict and evidence to the Orchestrator. Record that this was manual, and keep
the review independent of the builder's conversation. Separate worktrees are
useful when available, but shared manifests and services still need coordination.

## Checks And Evidence

| Symptom                                          | Action                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `check` passes but work is incomplete            | Expected distinction: configuration validity does not establish `ready` or `verify`.                                          |
| Missing/malformed policy or state                | Refuse; obtain the delivered schema and repair under the assigned ownership. Never treat a parse error as empty success.      |
| Stale evidence after a patch                     | Rerun affected checks and obtain independent review of current content.                                                       |
| File claims overlap or dependencies cycle        | Stop conflicting work; revise the approved graph and serialize shared writers.                                                |
| Required tool/service/browser unavailable        | State the exact prerequisite and BLOCKED evidence. Do not install or touch production implicitly.                             |
| Terminal output belongs to another parallel task | Do not attribute it to your command. Serialize terminal use and rerun the scoped check.                                       |
| QA has no edit but can execute                   | Shell execution can write. Restrict commands/resources and inspect side effects; do not call this sandboxed read-only access. |
| Loop exhausted                                   | Preserve findings and counters; stop BLOCKED, even after reassignment.                                                        |
| Hook absent or not triggered                     | Hooks are optional preview assistance, not the completion gate or a security boundary.                                        |

Use [MCP guidance](mcp.md) for metadata-safe inspection and native-tool fallback.
Use [quality gates](quality-gates.md) for acceptance, not old test totals.

Use [limitations](limitations.md) as the engineering-OS limitation authority,
[baseline](baseline.md) for matching existing failures, and
[failure recovery](failure-recovery.md) for bounded remediation. A required
baseline-existing failure still blocks; it does not become a waiver.

## Drift Outside This Assignment

The 2026-09-20 source inspection found these claims outside the assigned edit
scope. They are findings, not fixes or a new canonical report/state file.
They are historical observations, **unverified current** in the expanded-OS
documentation pass; do not treat this table as a new deep product audit.

| Claim                                                                                | Source evidence and required follow-up                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Root README says CareerScope is an unfinished alpha and MinIO is the planned runtime | [Project state](../PROJECT-STATE.md) identifies deployed CareerScope; [production Compose](../../infra/compose.production.yml) mounts a private filesystem. README ownership here was limited to a small link; its product narrative needs a separately scoped reconciliation. |
| Frontend architecture says there is no React Query                                   | [CareerScope page](../../CareerScope/apps/web/src/app/page.tsx) imports TanStack Query and uses queries/mutations. Correct [frontend architecture](../FRONTEND-ARCHITECTURE.md) under its owner's scope.                                                                       |
| Known limitations attributes the single-writer reservation to the files worker       | [Production Compose](../../infra/compose.production.yml) mounts files-worker storage read-only; the API writes. Correct the ownership explanation in [known limitations](../KNOWN-LIMITATIONS.md), preserving the limitation itself.                                           |
| Release/CI checks imply more assurance than they enforce                             | The [initial audit](initial-repository-audit.md) records AI-03/04/10; [CI](../../.github/workflows/ci.yml) explicitly runs CareerScope unit-only coverage. Release hardening belongs to the authorized builder, not these docs.                                                |

The parent owns agent/tool/hook/state updates and the old release prompt; the
Senior Engineer owns the validator implementation. Their changes need independent
integration verification. These documents do not claim that either parallel
assignment is finished, or that live provenance was checked in this session.
