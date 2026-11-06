# Program progress

One row per roadmap stage. A stage is complete only when its gate in [GAP-MATRIX](GAP-MATRIX.md)
is met, its tests are recorded in [TEST-MATRIX](TEST-MATRIX.md), and every blocker that affects it
is listed in [BLOCKERS](BLOCKERS.md). Stages run one at a time. Deployment is last, after stage 20.

| Stage | Name                                 | Status      |
| ----- | ------------------------------------ | ----------- |
| 01    | Foundation, governance, architecture | Partial     |
| 02    | Authentication and account security  | Complete    |
| 03-20 | See roadmap                          | Not started |

Stage 01 file audit in progress: [STAGE-01-FILE-AUDIT](audits/STAGE-01-FILE-AUDIT.md); see the linked JSON record for current file counts. Stage 01 evidence: [FOUNDATIONS](FOUNDATIONS.md). Its enforced thirteen-item register is Complete,
but the crosswalk for the owner's separate fifteen-item master prompt remains Partial: the prompt's
full file-by-file audit is not evidenced, and cross-browser hosted acceptance must be tied to the
closing revision before this prompt's Stage 01 can close. See the Stage 01 master-prompt crosswalk.

Stage 02 evidence: [GAP-MATRIX](GAP-MATRIX.md) rows 2.01 to 2.20 and [TEST-MATRIX](TEST-MATRIX.md).
Commit `c12838e` passed the local gates, the integration suite, the Chromium browser suite, and
hosted CI on rerun `41221224982`. The first hosted run of `c12838e` failed in the flaky private
test-selection integration test, so that flake remains open. Owner decisions: B-02 closed (no second provider in stage 02); B-03
approved for deployment, pending counsel-approved legal text. Stage 02 is complete with these carried
to deployment.
