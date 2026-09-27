# Documentation audit

Reconciled 2026-09-27 against repository state at `8adbe89c` and the workflow
changes on `chore/repository-hygiene`.

| Document                                    | Finding                                                                                | Action                                                                                            |
| ------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `docs/PROJECT-STATE.md`                     | Claimed every `main` push was a deployment candidate                                   | Corrected to manual-only deployment and Pages publication                                         |
| `docs/architecture/README.md`               | CI diagram showed push-triggered host and Pages deployment and understated V2 coverage | Corrected workflow topology and coverage wording                                                  |
| `docs/OPERATIONS/DEPLOYMENT.md`             | Led with shell deployment and did not identify the supported manual workflow           | Added explicit-ref protected-environment procedure; retained shell commands as recovery reference |
| `.github/prompts/ship-release.prompt.md`    | Described automatic deployment from `main`                                             | Corrected                                                                                         |
| Infrastructure agent instructions           | Described automatic deployment from `main`                                             | Corrected                                                                                         |
| `.ai` task/cleanup/implementation summaries | Stale or empty                                                                         | Replaced with current evidence-backed state                                                       |

The broader document set was not rewritten for style. Historical evidence and
specialized runbooks were retained. Remaining product truth is centralized in
[PROJECT-STATE.md](../docs/PROJECT-STATE.md), with machine state in
[backlog.json](backlog.json) and [progress.json](progress.json).

**Verdict:** release-path drift fixed; no known document now authorizes or
claims automatic deployment.
