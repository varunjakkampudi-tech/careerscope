# Program progress

One row per roadmap stage. A stage is complete only when its gate in [GAP-MATRIX](GAP-MATRIX.md)
is met, its tests are recorded in [TEST-MATRIX](TEST-MATRIX.md), and every blocker that affects it
is listed in [BLOCKERS](BLOCKERS.md). Stages run one at a time. Deployment is last, after stage 20.

| Stage | Name                                 | Status      |
| ----- | ------------------------------------ | ----------- |
| 01    | Foundation, governance, architecture | Partial     |
| 02    | Authentication and account security  | Complete    |
| 03-20 | See roadmap                          | Not started |

Stage 01 file audit: [STAGE-01-FILE-AUDIT](audits/STAGE-01-FILE-AUDIT.md); the current JSON record accounts for all 501 tracked files and passes the complete-coverage gate. The owner’s prompt item 1.01 was independently approved at PR #18, exact SHA `5fa4776b7fe4ddd9c604c0d7d7fcec596d3d8964`. Stage 01 remains Partial because other checklist items and final cross-browser hosted acceptance are still outstanding. See the [FOUNDATIONS](FOUNDATIONS.md) crosswalk.

Owner 22-stage roadmap item 1.07, API/OpenAPI contracts, is verified for the registered route surface; see [API-OPENAPI-REVIEW](architecture/API-OPENAPI-REVIEW.md). The 13-item repository foundations register has its own numbering; its item 1.07 refers to migration integrity and is tracked separately in [FOUNDATIONS](FOUNDATIONS.md).

Owner 22-stage roadmap item 1.08, browser acceptance, passed on all three Playwright engines in hosted pull-request run `42250586504` for exact SHA `faaff952a43bd7f23db6caaf545d704a994a8e50`; see [UI-VERIFICATION](UI-VERIFICATION.md). Stage 01 close-out still requires a final cross-browser run on its closing revision.

Owner 22-stage roadmap item 1.09, standardized error handling, is verified locally for the API and web client, including database-backed 409 and 507 cases; see [API-SURFACE](API-SURFACE.md) and [TEST-MATRIX](TEST-MATRIX.md). Hosted Node 24 CI on the item PR remains the release gate.

Owner 22-stage roadmap item 1.10, critical technical debt, has no open critical or high file-audit findings or source TODO/FIXME markers. The current dependency audit reports zero vulnerabilities; the stale minimatch exception was closed. Low-severity cleanup (unused exported schemas) and the accepted low audit risk remain documented and are not critical blockers. Local unit, integration, lint, typecheck and security checks passed; `npm run check` was blocked at repository-wide formatting because it included the preserved untracked Playwright artifact. See [TEST-MATRIX](TEST-MATRIX.md) and [DEPENDENCY-EXCEPTIONS](security/DEPENDENCY-EXCEPTIONS.md). Local Node is 22.23.2; hosted Node 24 CI on the item PR remains the release gate.

Stage 02 evidence: [GAP-MATRIX](GAP-MATRIX.md) rows 2.01 to 2.20 and [TEST-MATRIX](TEST-MATRIX.md).
Commit `c12838e` passed the local gates, the integration suite, the Chromium browser suite, and
hosted CI on rerun `41221224982`. The first hosted run of `c12838e` failed in the flaky private
test-selection integration test, so that flake remains open. Owner decisions: B-02 closed (no second provider in stage 02); B-03
approved for deployment, pending counsel-approved legal text. Stage 02 is complete with these carried
to deployment.
