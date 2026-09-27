# Task Contract

Before dispatch, the Orchestrator turns an approved goal into the smallest
testable task. This is a **normative handoff contract**, not a JSON schema.
[engineering.mjs](../../scripts/engineering.mjs) and its `help` define accepted
fields alongside [contract validation](../../scripts/engineering-contract.mjs).
Both schemas reject extra fields. Schema 2 is implemented, but a schema-1 record
does not acquire replayable history by changing its version number. Preserve
legacy records when real history is unavailable; begin new schema-2 work with
actual events, a compatible baseline and the [risk-role mapping](risk-model.md).

## Required Brief

| Item                 | Required content                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------ |
| Identity and purpose | Task/requirement IDs, objective, non-goals, V1/V2/tooling boundary                         |
| Acceptance           | Observable behavior, negative/malformed cases, exact evidence needed                       |
| Authority and risk   | Existing user authorization, [risk class](risk-model.md), approval gaps                    |
| Ownership            | Existing agent, literal allowed paths, explicit forbidden paths, generated side effects    |
| Dependencies         | Predecessor task IDs and consumed artifacts; no implicit ordering                          |
| Starting point       | Revision plus scoped content digest, relevant baseline and current failure signatures      |
| Context              | Minimum source/test links and applicable instructions/skills, not a repository dump        |
| Verification         | Focused checks, isolation prerequisites, independent reviewer, wider gates when applicable |
| Budget and recovery  | Current attempt count, maximum three remediation rounds, stop/escalation condition         |
| Return               | Changed files, checks/results/artifacts, findings, unverified requirements and next owner  |

Dependencies must be acyclic and finished before consumption. `ready` only
reports eligible recorded tasks; it does not grant scope or start agents.
Never use `ownership.yml` or a second quality-gate YAML as a parallel authority.
Canonical task claims are in [.ai/engineering.json](../../.ai/engineering.json),
and gate policy is [quality-gates.json](../../quality-gates.json).

## This Assignment

Documentation owns approved `docs/ai` corrections and the existing architecture
index, excluding all historical `docs/ai/baseline*` artifacts; no new files or
completion record are authorized. Runtime builder owns only its approved
engineering script files. Parent alone integrates `.github`, package/state and
review records. Directory exclusions in this prose must become **enumerated
literal file claims**, not glob or negation syntax unsupported by the validator.

No application/config edits, installs, secrets, Git mutations or shipping are
authorized. Preserve concurrent edits. A new dependency, shared file or risk
increase requires a revised approved contract, not opportunistic expansion.
Continue with [agent protocol](agent-protocol.md) and [ownership](ownership.md).
