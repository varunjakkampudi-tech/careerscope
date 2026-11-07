# Stage 01 technical debt review

Owner roadmap: Stage 01, checklist 1.10, “Eliminate critical technical debt.”

## Result

No open critical or high-severity technical-debt findings were identified in the current source
review. The Stage 01 file audit accounts for all tracked files and reports zero open findings; the
source scan found no TODO, FIXME, XXX, or HACK markers. The current production and full dependency
audits report zero vulnerabilities.

This is a prioritized register, not a claim that every low-priority cleanup is complete. Two low
items remain visible below. Stage 01 closeout gates have passed; the accepted low-severity items
remain visible as follow-up work.

## Prioritized register

| ID     | Priority          | Finding                                                                                                                | Disposition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TD-001 | Moderate advisory | Historical minimatch advisory classification.                                                                          | **Closed:** the initial review treated `minimatch@3.1.5` as affected by GHSA-g3hv-75wg-m249. GitHub's current advisory lists affected versions as `>=7.0.0, <11.0.1`, so 3.1.5 is outside the affected range; 11.0.3 is patched. Both npm audits report zero vulnerabilities. No dependency change is needed for this advisory. See [the GitHub advisory](https://github.com/advisories/GHSA-g3hv-75wg-m249) and [DEPENDENCY-EXCEPTIONS](../security/DEPENDENCY-EXCEPTIONS.md) for the historical record. |
| TD-002 | Low               | About twenty exported schemas in `packages/shared/src/schemas.ts` have no consumers outside the package.               | **Open, deferred:** no runtime or user-facing defect was found in the Stage 01 review. Remove exports only after confirming callers and package contracts; this is not a critical or high blocker.                                                                                                                                                                                                                                                                                                        |
| TD-003 | Low               | S1-F014: PostgreSQL does not enforce lowercase storage for `users.email`; application write paths normalize addresses. | **Accepted risk:** consider a new migration after existing data is checked. Do not rewrite applied migrations or infer that a database constraint has been added.                                                                                                                                                                                                                                                                                                                                         |

## Verification

- Stage 01 file audit: 502 tracked files accounted for, no open findings.
- Source TODO/FIXME scan: no open markers in product code.
- `npm audit --omit=dev` and full `npm audit`: zero vulnerabilities on 2026-11-06.
- Local checks: unit, domain, PostgreSQL/Redis integration, lint, typecheck, security, architecture,
  traceability, complete file audit, and Prettier over all tracked files passed. The full local
  `npm run check` command also scans the user's preserved untracked Playwright YAML and stopped at
  that file's formatting; it was left untouched. Local Node is 22.23.2, below the repository's
  Node 24 requirement, so hosted Node 24 CI on the item PR is authoritative.

The approval and hosted CI evidence for the exact item PR SHA remain in the pull request and are
not inferred from local checks. Hostinger, server backups, and deployment are outside this review.
