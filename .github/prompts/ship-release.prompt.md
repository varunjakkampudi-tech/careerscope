---
agent: CareerScope Orchestrator
description: 'Release: promote QA tickets, run the gates, deploy to production, verify it landed, then clean up, update docs and close the release.'
---

# Ship A Release

Trigger: _"move QA tickets to ready and move to production"_.

Release preparation does not authorize shipping. Require explicit authorization
for the current push, deployment, publication and tag operation. Without it,
stop at a reviewed readiness report. Never infer standing authorization from
this file. A refused gate blocks release; do not bypass or reinterpret it.

Known blockers are recorded in docs/ai/initial-repository-audit.md: missing
findings can pass the legacy gate, and release:close does not validate supplied
commit provenance or frozen ticket scope. Until fixed and independently tested,
do not use those commands as sufficient release authorization or closure proof.

## Branching and naming

Trunk-based, because [deploy.yml](../workflows/deploy.yml) deploys `main` after
a required green CI run for that exact commit.

| Kind           | Branch                    | Example                        |
| -------------- | ------------------------- | ------------------------------ |
| Feature        | `feat/<ticket>-<slug>`    | `feat/CS-17-job-details`       |
| Fix            | `fix/<ticket>-<slug>`     | `fix/CS-2-webkit-row-overlap`  |
| Chore/cleanup  | `chore/<slug>`            | `chore/remove-dead-s3-adapter` |
| Docs           | `docs/<slug>`             | `docs/release-3-0-1`           |
| Infrastructure | `infra/<slug>`            | `infra/pause-container`        |
| Hotfix         | `hotfix/<version>-<slug>` | `hotfix/3.0.2-session-500`     |

Branches are short-lived and rebased on `main`, never long-running. Commits use
Conventional Commits with the ticket id: `fix(api): reject unknown cursor (CS-2)`.

Tags are `v<semver>` on the deployed commit, applied **after** the live check
passes — never before. A tag that points at something that never ran in
production is worse than no tag.

## 1. Promote

```
npm run tickets:update
npm run release:promote
```

`release:promote` refuses any QA ticket without acceptance criteria, evidence
and a completed QA step, and refuses the whole batch while a P0 or P1 finding is
open. If it refuses, fix the ticket or finish the work — do not edit state.

## 2. Clean up, with evidence

Remove only code nothing references, and prove it: search for every import and
usage first, then delete, then run the full gates. Anything larger — a
duplicated abstraction, a module that wants restructuring — becomes a **new
backlog ticket**, not a release-day edit.

Never delete a test, a check, or an unfamiliar file to make the tree tidy.

## 3. Update documentation and the repository

Documentation is a release deliverable, and the release gate asserts it.

- `README.md` — what the project is and does now
- [docs/PROJECT-STATE.md](../../docs/PROJECT-STATE.md) — feature status, what is deployed
- [docs/API-SURFACE.md](../../docs/API-SURFACE.md) — if any route or contract changed
- [docs/KNOWN-LIMITATIONS.md](../../docs/KNOWN-LIMITATIONS.md) — anything newly known
- `v2/ARCHITECTURE.md` — if a boundary, flow or topology changed
- `npm run version:sync` after a version bump

## 4. Gates

```
npm run typecheck && npm run lint && npm run test && npm run build && npm run format:check
npm --prefix v2 test
npm run gates:test
npm run pages:test            # if the static site or its pipeline changed
npm run test:ui               # if the UI changed
```

Then fill `.ai/release-plan.json` honestly — `ci`, `acceptance`, `deployment`,
`rollback`, `safety` — and run `npm run release:gate`. Record what actually ran.
A gate marked `pass` without a command behind it is a fabricated release.

## 5. Deploy

```
git push origin main
```

CI must go green for that commit; the Deploy workflow then ships it, builds the
images on the host and runs `check-provenance.sh` itself. Do not deploy around
CI, and do not use `override_ci` to bypass a failed or missing check.

Never restart the proxy alone — use `infra/v3/restart-stack.sh`.

## 6. Verify it actually landed

```
bash infra/v3/check-provenance.sh
node scripts/check-api-surface.mjs
npm run release:close -- --version <semver> --commit <sha>
npx prettier --write .ai/backlog.json
```

`release:close` reads the live `/api/health` and refuses to mark anything
`RELEASED` unless the running site reports that exact version. Unreachable is
not released; mismatched is not released. Reformat the backlog afterwards, or
`format:check` will fail on the next run.

## 7. Close the cycle

```
npm run agile:review
npm run agile:retro
npm run agile:carry
```

Update `.ai/progress.json` only where evidence changed, tag the release, and
push the tag.

## 8. Report

Say what shipped, the deployed commit and version, which gates ran and what
they returned, what was cleaned up, which docs changed, what became a new
ticket, and what remains unverified. If any step failed, the release is
`BLOCKED` — never `COMPLETE`.
