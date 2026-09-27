# Cleanup report

Reconciled 2026-09-27. Cleanup preserved history and unique work; there was no
force push, history rewrite, production deployment, publication, or default
branch deletion.

| Item                | Baseline                                | Action                                                              | Result                                              |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| Open pull requests  | 11 Dependabot PRs                       | Closed with rationale; deleted their bot branches                   | 0 open PRs                                          |
| Remote branches     | `main`, 3 feature, 11 Dependabot        | Removed bot branches and 2 merged/patch-equivalent feature branches | `main` plus unique admin branch                     |
| Local branches      | `main`, 4 stale/feature branches        | Removed 3 proven merged/equivalent branches                         | current hygiene branch, `main`, unique admin branch |
| Worktrees           | main plus clean merged Copilot worktree | Removed the stale Copilot worktree                                  | 1 worktree                                          |
| Actions runs        | 120                                     | Deleted 116 duplicate, bot, and retired-workflow runs               | 4 evidence-bearing runs                             |
| Deployment triggers | push + manual                           | Removed push; explicit manual ref/environment only                  | no automatic host deployment                        |
| Pages publication   | reachable from CI push                  | Split into manual-only workflow                                     | no automatic publication                            |
| Git history         | Copilot/bot and owner commits           | Audited and preserved                                               | no attribution rewrite                              |

Retained branch: `feature/frontend-pages-admin-console`. It contains unique
owner-only investigation/admin work not present on `main`; deleting it would
discard product work. Dependency PR content is reproducible and recorded as
CS-84, so closing those PRs did not discard unique human-authored changes.

**Verdict:** conservative cleanup complete; retained work and remaining risks
are explicit.
