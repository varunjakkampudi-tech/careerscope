# Blockers

Each active blocker names the owner action and the stage it affects. A blocker does not imply a product defect.

| ID   | Blocker                                    | Affects    | Owner action                                                                                                     |
| ---- | ------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| B-03 | Enabling new-user registration (item 2.09) | Deployment | The owners approve the legal text and its public HTTPS URLs; then set `REGISTRATION_ENABLED=true` at deploy time |

B-03 is a deployment-time legal prerequisite and is outside the current in-scope roadmap work.

## Resolved blockers

- **B-04 — Prompt-scoped full file audit:** resolved. The full 1.01 file audit was independently
  approved at PR #18, exact SHA `5fa4776b7fe4ddd9c604c0d7d7fcec596d3d8964`. The current manifest
  accounts for all 501 tracked files and passes `npm run audit:stage01 -- --require-complete`.
- **B-02 — Second email provider:** owner decision recorded in [GAP-MATRIX](GAP-MATRIX.md): no second provider in Stage 02.
- **Stage 02 email and recovery decisions:** the Resend domain was verified, a live notice reached Delivered status and was confirmed in the owner's inbox, and the lost-email recovery policy was decided and built. See [GAP-MATRIX](GAP-MATRIX.md).
