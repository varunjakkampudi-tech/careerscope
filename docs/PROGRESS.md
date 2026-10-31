# Program progress

One row per roadmap stage. A stage is complete only when its gate in [GAP-MATRIX](GAP-MATRIX.md)
is met, its tests are recorded in [TEST-MATRIX](TEST-MATRIX.md), and every blocker that affects it
is listed in [BLOCKERS](BLOCKERS.md). Stages run one at a time. Deployment is last, after stage 20.

| Stage | Name                                 | Status                                                                                    |
| ----- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| 01    | Foundation, governance, architecture | Complete                                                                                  |
| 02    | Authentication and account security  | Implementation complete. Pending: browser suite and hosted CI on the commit that ships it |
| 03-20 | See roadmap                          | Not started                                                                               |

Stage 01 evidence: [FOUNDATIONS](FOUNDATIONS.md), 13 items Complete. The register is enforced by
`npm run traceability:check`.
