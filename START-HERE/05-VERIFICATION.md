# Verification

Which command proves which claim. Run the one that matches what you are about to
assert, and report its real output.

---

## The standard

A claim needs evidence someone actually read.

| Not evidence          | Evidence                                              |
| --------------------- | ----------------------------------------------------- |
| "tests pass"          | `1047 passed (1047)`                                  |
| exit code 0           | the output, read                                      |
| "the check succeeded" | the check shown to fail when the property is violated |
| an output file exists | its contents match what was expected                  |
| "deployed"            | commit SHA + provenance + live health response        |

A **skipped** test is not a passing test. Report skips and say why.

## Everyday

```bash
npm run typecheck        # canonical workspace and test files
npm run lint
npm test                 # expect 1047 passed (1047), 67 files
npm run format:check
node scripts/check-agents.mjs    # expect "agent configuration valid" (37 checks)
```

## Browser and accessibility

```bash
npm run test:ui                  # canonical API/UI in Chromium, Firefox, WebKit
npm run pages:workspace:test     # public Pages artifact
node scripts/check-admin-ui.mjs  # encrypted admin
```

`test:ui` builds first. It exercises three engines; a WebKit-only layout defect
has shipped here before, so a chromium-only pass is not a pass.

## Storage, queue and crash behaviour

Run these when touching storage, workers, the outbox or migrations:

```bash
npm run test:crash-recovery
npm run test:database-recovery
npm run test:queue-runtime
npm run test:performance     # 8 concurrent, 30s, asserts p50/p95/p99
```

## Deployment

```bash
infra/check-provenance.sh        # what is ACTUALLY deployed
curl -s https://careerscope.tech/api/health
infra/restart-stack.sh           # the only supported restart
```

Never restart the proxy alone — every service shares its network namespace and
will be stranded behind a 502 while still reporting healthy.

## Live security probes

Expected responses, all verified previously:

```
unauthenticated request   401
cross-origin request      403
origin-less request       403
foreign Host header       421
POST /api/auth/register   404     (no public signup)
bad credentials           401
```

## Negative proof

For any check that matters, prove it can fail:

```
1. run it clean            → PASS, exit 0
2. break the property      → FAIL, exit 1, with a message naming the problem
3. restore                 → PASS, exit 0
```

Record all three. Four checks in this repository have passed while structurally
unable to detect failure; two of those were inside validators written to prevent
exactly that. A validator that has only ever been green is not evidence.

Examples that should each produce a red:

| Break                                        | Expected failure                         |
| -------------------------------------------- | ---------------------------------------- |
| remove a delegation from the Orchestrator    | `check-agents.mjs` fails                 |
| change a percent in `.ai/progress.json` only | JSON/Markdown drift check fails          |
| mark an agent busy with no active agent      | LOOP-STATE consistency check fails       |
| grant a reviewer an `edit` tool              | permission check fails                   |
| corrupt a migration invariant                | migration test fails                     |
| hide the browser binary                      | browser test reports skipped, not passed |

## Before saying "done"

Requirements met · no open P0/P1 · gates green with output read · docs updated
if behaviour changed · diff reviewed for unrelated changes · `.ai/` and
`review.txt` updated · live verified if runtime-affecting.
