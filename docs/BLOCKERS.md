# Blockers

Each active blocker names the owner action and the stage it affects. A blocker does not imply a product defect. The related checklist item remains gated until its acceptance evidence is complete.

| ID   | Blocker                                                           | Affects  | Owner action                                                                                                     |
| ---- | ----------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| B-03 | Enabling new-user registration (owner item 2.05; legacy row 2.09) | Stage 02 | Provide counsel-approved legal text and public HTTPS URLs; keep registration disabled until this evidence exists |

B-03 is an external legal approval prerequisite for owner checklist item 2.05. The checklist item remains gated until counsel-approved legal text and public HTTPS URLs are available. Hosting and deployment are excluded from the current roadmap scope.

## Resolved blockers

- **B-04 — Prompt-scoped full file audit:** resolved. The full 1.01 file audit was independently
  approved at PR #18, exact SHA `5fa4776b7fe4ddd9c604c0d7d7fcec596d3d8964`. The current manifest
  accounts for the current tracked-file set and passes `npm run audit:stage01 -- --require-complete`.
- **B-02 — Second email provider:** owner decision recorded in [GAP-MATRIX](GAP-MATRIX.md): no second provider in Stage 02.
- **Stage 02 email and recovery decisions:** the Resend domain was verified, a live notice reached Delivered status and was confirmed in the owner's inbox, and the lost-email recovery policy was decided and built. See [GAP-MATRIX](GAP-MATRIX.md).
