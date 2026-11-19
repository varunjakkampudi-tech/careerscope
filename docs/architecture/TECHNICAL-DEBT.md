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

- The current Stage 01 file audit accounts for 520 tracked files: 451 reviewed and 69 classified
  as not applicable source. It reports zero open findings; the accepted S1-F014 low-severity risk
  remains documented above.
- A source scan at the current `dev` revision found no product TODO, FIXME, XXX or HACK markers.
  Its only text match was the `XXXX` magic-value test fixture in `file-storage.test.ts`, not a
  debt marker.
- GitHub Actions run `43957299898` passed on exact current `dev` SHA
  `fad57ea3253024983f29183acefaee59328d0d01`. Quality gates passed `npm run check`, the production
  and full dependency advisory audits, and the remaining static and domain checks. The Services,
  integration, and browser job also passed. The production image build was skipped on this `dev`
  push and is not counted as a pass.
- Local verification recorded on 2026-11-06 used Node 22.23.2, below the repository's Node 24
  minimum; the exact-current hosted Node 24 run above is the authoritative current evidence.

These checks establish the registered critical/high technical-debt acceptance scope. They do not
claim that the two low-priority items or accepted S1-F014 risk have been removed. Hostinger, server
backups, and deployment remain outside this review.
