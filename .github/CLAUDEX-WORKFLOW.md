# Claudex Loop — CareerScope operating guide

Cross-model workflow for CareerScope: one model plans, a different model reviews,
and whoever built something never grades it.

Upstream: [chaseai-yt/claudex-loop](https://github.com/chaseai-yt/claudex-loop)
(MIT). Installed from commit `8cf5e2c`.

---

## Read this first: what the coordinator actually is

**GitHub Copilot cannot host this workflow.** The skill runs inside a Claude Code
or Codex session — the _host_ session is the coordinator, and it drives the other
provider through its CLI. There is no Copilot host adapter upstream.

What Copilot can legitimately do:

- prepare the plan, the branch and the proof commands
- tell you the exact `claudex …` line to run
- read `PLAN.md` and `PLAN-REVIEW-LOG.md` afterwards and act on the findings

What Copilot must not do is claim to _be_ the independent reviewer. It is the
agent doing the building in this repository, and a builder grading its own work
is the single thing this workflow exists to prevent.

---

## Roles

| Role        | Who                                                | Writes?                    |
| ----------- | -------------------------------------------------- | -------------------------- |
| Coordinator | the Claude Code or Codex session you start         | yes, via the builder       |
| Reviewer    | the **other** provider, fresh session              | **no — read-only**         |
| Builder     | `builder=claude` or `builder=codex`                | yes, within the repository |
| Inspector   | the provider that did **not** build, fresh session | **no — read-only**         |

The inspector always follows the builder choice and is always the opposite
provider. That is enforced by the skill, not by convention.

---

## Current environment status

Recorded 2026-09-18 on this machine. Re-verify rather than trusting this table.

| Component      | Status                                                          |
| -------------- | --------------------------------------------------------------- |
| `git`          | 2.55.0.windows.4                                                |
| `node`         | v22.23.2 (repo tooling pins its own newer Node)                 |
| `npm`          | 11.19.0                                                         |
| `python`       | 3.14.6 — meets the 3.10+ requirement                            |
| `codex`        | codex-cli 0.155.0 — **logged in (ChatGPT)**                     |
| `claude`       | 2.1.276 — **NOT logged in**                                     |
| Skills         | all four installed in `~/.agents/skills` and `~/.claude/skills` |
| Upstream tests | 23/23 passing on this machine                                   |

### Two things block a full cross-provider run

1. **Claude Code is not authenticated.** Run `claude login` yourself. Never paste
   a credential into a chat with an agent, including this one.
2. **`gpt-6-astra` is not available on this Codex account.** Requesting it fails
   with `400 … not supported when using Codex with a ChatGPT account`. The
   observed default model is **`gpt-5.5`**.

Until Claude Code is authenticated, only single-provider Codex runs work, and a
Codex-built change reviewed by Codex **is not an independent review**. Say so in
the log rather than recording it as one.

---

## Model identity

Record all three, every time, because they disagree more often than expected:

- **requested** model (what you asked for)
- **observed** model (what the CLI reported using)
- **CLI version**

There is no silent fallback. A model that is unavailable produces a non-zero
exit, and that stays a failure. It is never rewritten as an approval or quietly
swapped for a different model.

---

## Commands

Run these **inside a Claude Code or Codex session**, not in PowerShell:

```
claudex this feature — plan and implement it
claudex this plan, mode=review, rounds=5
claudex this feature, builder=codex, reviewer_model=gpt-6-astra
claudex this feature, builder=claude, reviewer_model=claude-fable-5-1
```

In Codex the skill is `$claudex-loop`; in Claude Code it is `/claudex-loop`.
`codex-review` and `codex-build` are the explicit Codex-only compatibility
commands. `claudex-route` only recommends who should do a job — a recommendation
launches nothing and authorizes nothing.

### Bounds

| Control                 | Value here | Meaning                           |
| ----------------------- | ---------- | --------------------------------- |
| `rounds`                | **5**      | plan-review rounds                |
| `MAX_FIX_ROUNDS`        | **2**      | build-fix attempts                |
| `MAX_INSPECTION_ROUNDS` | **2**      | inspection plus one re-inspection |

These caps exist so the loop terminates. An exhausted budget is a reported
outcome, not a retry signal.

---

## Files

- `PLAN.md` — what to build, with observable acceptance criteria
- `PLAN-REVIEW-LOG.md` — findings, dispositions, models, proof, open uncertainty

Neither exists in this repository yet. The skill creates them on first run. If
you already have a plan somewhere else, pass `plan=docs/whatever.md` instead of
moving it — do not let a tool overwrite existing project documents.

---

## Review boundaries

- Reviewers and inspectors are **read-only**. Codex reviews use its read-only
  shell sandbox; Claude reviews expose file read and search only, with
  customizations disabled and **no MCP tools**.
- Do not hand a reviewer a write-capable MCP integration. This repository's
  `.vscode/mcp.json` includes write-capable servers; those belong to the
  interactive developer session, not to a review session.
- Builders may write **only inside this repository**.
- Unrelated working-tree changes must survive. Nothing resets or discards work
  that the task did not create.
- Use an isolated `git worktree` when two models could edit simultaneously. A
  worktree protects concurrent edits; it is **not** a security sandbox.

---

## What approval means

Approval requires a **structured review result**. None of the following is
approval:

- a CLI exiting with code 0
- an output file existing
- a session starting

That first one is not hypothetical here. On this machine `claude auth status`
exits **0** while reporting `loggedIn: false`.

An approval binds to the plan's path and SHA256. Change the plan and the
approval is void. An inspection binds to the pre-build commit and a fingerprint
of the inspected changes, including staged and untracked files — later edits
need a fresh inspection.

`BLOCKED`, execution failures and exhausted round budgets are surfaced as
themselves. Zero findings is a valid result; a high finding count is not a
quality score.

---

## Default process for CareerScope UI/UX work

```
recon → requirements → UI/UX plan → independent review → revision → approval
      → implementation → build/typecheck/lint/tests → fresh inspection
      → fixes → fresh inspection
```

If the coordinator takes over the fixes, those edits are newly authored and need
another independent inspection. Mixed authorship gets recorded per part.

### Proof commands

The reviewer should be given commands that actually prove the deliverable, and
for this repository those are:

```bash
# V2 (the deployed stack)
npm --prefix v2 run typecheck
npm --prefix v2 run lint
npm --prefix v2 run build
npm --prefix v2 test

# Root workspace
npm run typecheck
npm run lint
npm test
npm run format:check
```

Deployment-related claims are proved on the host, not asserted:

```bash
bash /opt/careerscope/infra/v3/check-provenance.sh
bash /opt/careerscope/infra/v3/check-host-firewall.sh
```

---

## Failure handling

| Symptom                            | Do this                                                 |
| ---------------------------------- | ------------------------------------------------------- |
| `claude` reports `loggedIn: false` | run `claude login` yourself; do not route around it     |
| requested model unsupported        | stop, record requested vs observed, decide deliberately |
| reviewer returns `BLOCKED`         | it is blocked; fix the plan                             |
| round budget exhausted             | report it; do not silently re-run                       |
| reviewer authored the code         | it is not an independent review; label it accurately    |

---

## Invoking from VS Code

The skill needs a CLI session, so start one in the integrated terminal:

```powershell
claude      # then: /claudex-loop …
codex       # then: $claudex-loop …
```

`.vscode/tasks.json` has tasks that open each CLI in the workspace folder.
They use `${workspaceFolder}` and resolve the CLI from `PATH`, so nothing
machine-specific is committed.

Updating the skills:

```powershell
git -C "$env:USERPROFILE\.claudex-src\claudex-loop" pull
Copy-Item -Recurse -Force "$env:USERPROFILE\.claudex-src\claudex-loop\skills\*" "$env:USERPROFILE\.agents\skills\"
Copy-Item -Recurse -Force "$env:USERPROFILE\.claudex-src\claudex-loop\skills\*" "$env:USERPROFILE\.claude\skills\"
```
