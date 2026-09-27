# QA Report — CS-8 "Readers of canonical state may treat unreadable as empty"

Independent verification run 2026-09-22, session start ~17:09 IST. All commands
run for real from repo root unless noted. Docker Desktop was stopped at session
start and was started by QA to run the v2 suite (see V2 tests notes).

## Summary verdict

**PASS** on CS-8's own acceptance criteria and its dedicated gates
(`gates:test`, `check-state-readers.mjs`, live corruption re-tests, ESLint on
the touched files). **ONE REAL DEFECT FOUND**: `scripts/check-agents.mjs`, as
it stands on disk right now, fails `prettier --check` (see finding below) —
this must be fixed before merge/commit. A second-order finding: the very files
under review (`scripts/check-agents.mjs`, `scripts/check-state-readers.mjs`,
`.ai/findings.json`, `.ai/backlog.json`) were edited by the builder _while this
QA pass was in progress_ (mtimes 17:16–17:28, after my first "PASS" checks at
~17:10). My final verdict is based on the file contents as they exist right
now (confirmed by re-running every check a second time against current disk
state), not on the first pass.

Two further findings, both **pre-existing and outside CS-8's diff** (confirmed
by `git diff --stat` / `git status --porcelain` on the affected files showing
no CS-8-authored changes): a real assertion failure in
`apps/web/src/routes/PublicJobs.test.tsx`, and flaky 5000ms timeouts in
`apps/api/src/routes/production.test.ts` and (intermittently)
`apps/web/src/routes/Login.test.tsx`, worse under the heavy concurrent Docker
load this session required for the v2 suite. Reported for completeness; not
attributable to this change.

---

## 1. `npm run gates:test` (repo root)

Ran three times across the session (before and after the concurrent edits
described above). Final run, current file state:

```
> npm run gates:test
> npm run release:gate:test && npm run agile:gate:test && npm run state-readers:test && npm run deploy:gate:test && npm run eol:check && npm run progress:check && npm run agents:check

release:gate:test  -> ALL GATES PROVEN (18/18 PASS)
agile:gate:test    -> ALL AGILE GATES PROVEN (all PASS)
state-readers:test -> ALL STATE READERS PROVEN (24/24 PASS)
deploy:gate:test   -> "deploy CI gate behaves" (all PASS)
eol:check          -> PASS  no CR bytes in 653 LF-only files
progress:check     -> PASS  12 areas, 12 measured with evidence, 0 honestly unmeasured
agents:check       -> "agent configuration valid" (all PASS, 0 FAIL)

Exit code: 0
```

Searched the full output for `^FAIL` (anchored) and for any bare `FAIL`
substring: zero real FAIL lines. (The only "FAIL"-looking substrings are inside
test case _names_ such as "a failed run refuses" and "tests failing but CI
claims green" — these are PASS lines whose names contain the word "fail".)

Confirmed by running `npm run gates:test` a second, isolated time with all
output suppressed except `$LASTEXITCODE`: **exit 0**.

`state-readers:test` count grew from 19 to 24 PASS lines between my first and
final run — the builder added 5 more mutation cases (absent `LOOP-STATE.json`,
absent `.ai/CAREERSCOPE-PROGRESS.md`) to `check-state-readers.mjs` mid-session.
All 24 are PASS in the final run; see §2.

## 2. `node scripts/check-state-readers.mjs` (direct)

Final run against current disk state:

```
PASS  engineering-ui: valid state produces no stateErrors
PASS  engineering-ui: malformed backlog.json falls back to items:[]
PASS  engineering-ui: malformed backlog.json is reported in stateErrors
PASS  engineering-ui: malformed findings.json falls back to findings:[]
PASS  engineering-ui: malformed findings.json is reported in stateErrors
PASS  engineering-ui: malformed progress.json falls back to areas:[]
PASS  engineering-ui: malformed progress.json is reported in stateErrors
PASS  engineering-ui: malformed LOOP-STATE.json falls back to {}
PASS  engineering-ui: malformed LOOP-STATE.json is reported in stateErrors
PASS  engineering-ui: absent progress.json falls back to areas:[]
PASS  engineering-ui: absent progress.json is NOT reported as a state error
PASS  control-center: valid progress.json renders without an UNREADABLE line
PASS  control-center: malformed progress.json renders UNREADABLE, not "No progress matrix found"
PASS  check-agents: valid state reaches the final summary line
PASS  check-agents: malformed LOOP-STATE.json does not crash (reaches its own summary)
PASS  check-agents: malformed LOOP-STATE.json is reported by name, not a stack trace
PASS  check-agents: malformed LOOP-STATE.json exits non-zero
PASS  check-agents: malformed progress.json reported by name, not a stack trace
PASS  check-agents: malformed progress.json still reaches the final summary line
PASS  check-agents: absent LOOP-STATE.json does not crash (reaches its own summary)
PASS  check-agents: absent LOOP-STATE.json is reported by name, not a stack trace
PASS  check-agents: absent LOOP-STATE.json exits non-zero
PASS  check-agents: absent CAREERSCOPE-PROGRESS.md does not crash (reaches its own summary)
PASS  check-agents: absent CAREERSCOPE-PROGRESS.md is reported by name, not a stack trace
PASS  check-agents: absent CAREERSCOPE-PROGRESS.md exits non-zero

ALL STATE READERS PROVEN
EXIT CODE: 0
```

24 PASS, 0 FAIL, exit 0. (My earlier run, before the mid-session edit, showed
19 PASS/exit 0 — both are genuine passing states of two different, valid
revisions of the same file; reporting the final one as authoritative.)

## 3. Independent corruption (my own, not the shipped test script)

Backed up with `Copy-Item` before every corruption; restored after; verified
with `git status --porcelain .ai/` and `git diff --stat` that nothing was left
corrupted.

**3a. `engineering-ui.mjs` — corrupted `.ai/findings.json` myself:**
Wrote `{ this is not valid json !!!` to `.ai/findings.json`, then:

```
node -e "import('./scripts/engineering-ui.mjs').then(m => { const s = m.snapshot(); console.log('findings:', JSON.stringify(s.findings)); console.log('stateErrors:', JSON.stringify(s.stateErrors, null, 2)); })"

findings: {"findings":[]}
stateErrors: [
  ".ai\\findings.json is not valid JSON: Expected property name or '}' in JSON at position 2 (line 1 column 3)"
]
```

Confirmed with my own eyes: the corrupted file does NOT silently present as
"zero findings" — `stateErrors` names the exact file and the JSON parse error.
Restored: `git diff --stat .ai/findings.json` after restore showed the exact
same 38-line diff (32 insertions/6 deletions) present _before_ I touched it —
i.e. the pre-existing builder edit (finding R4 addition), not new damage from
my test. `git status --porcelain .ai/` showed no residue.

**3b. `control-center.mjs` — corrupted `.ai/progress.json` myself:**
Wrote `{{{ broken json` to `.ai/progress.json` (was previously 100% clean per
`git diff --stat`), then ran the real script directly:

```
node scripts/control-center.mjs

  PROGRESS   (from .ai/progress.json)
      UNREADABLE — Expected property name or '}' in JSON at position 1 (line 1 column 2)
      This is not "no progress data". Fix the file before trusting this screen.
```

Confirmed: clear UNREADABLE line with the real parse error, not "No progress
matrix found." Bonus check, `check-agents.mjs` against the same corrupted
file (before restoring):

```
FAIL .ai/progress.json is valid JSON (Expected property name or '}' in JSON at position 1 (line 1 column 2))
FAIL progress.json covers 12 areas (unreadable)
FAIL progress.json and the Markdown agree
...
3 failure(s)
EXIT: 1
```

Reaches the full 51-line summary (does not crash), names the file, exits
non-zero. Restored `.ai/progress.json`: `git status --porcelain .ai/progress.json`
and `git diff --stat .ai/progress.json` both produced **zero output** —
fully and exactly restored (it was untouched in the working tree before my
test, and is untouched after).

Final check: `git status --porcelain .ai/` matches the exact same file list
that was dirty at the very start of the session — no residue from any of my
corruption tests.

## 4. ESLint / Prettier on the five files

```
npx eslint scripts/engineering-ui.mjs scripts/control-center.mjs scripts/check-agents.mjs scripts/check-state-readers.mjs eslint.config.js
ESLINT EXIT: 0        (zero errors, zero warnings)
```

```
npx prettier --check scripts/engineering-ui.mjs scripts/control-center.mjs scripts/check-agents.mjs scripts/check-state-readers.mjs eslint.config.js
Checking formatting...
[warn] scripts/check-agents.mjs
[warn] Code style issues found in the above file. Run Prettier with --write to fix.
PRETTIER EXIT: 1
```

**FAIL.** Confirmed reproducible on three separate invocations (isolated
single-file check, the original five-file check, and `npm run format:check`
at root, see §6). Root cause identified with
`npx prettier scripts/check-agents.mjs | git diff --no-index scripts/check-agents.mjs -`:
one line exceeds the configured print width and Prettier wants it wrapped:

```diff
-const overall = progressText !== null ? /^\*\*Overall Status:\*\*\s*(.+)$/m.exec(progressText) : null;
+const overall =
+  progressText !== null ? /^\*\*Overall Status:\*\*\s*(.+)$/m.exec(progressText) : null;
```

This line was introduced by an edit made to `scripts/check-agents.mjs`
_during this QA session_ (file mtime 17:16:26, after my first, passing,
ESLint/Prettier check at ~17:10 which was run against an earlier, differently
sized diff — 61 insertions vs. the current 70). ESLint does not catch this
(ESLint exit 0); only Prettier does. **This is a real, currently-reproducible
defect that must be fixed (one line rewrap) before this ticket can close.**
Not a false positive — reproduced 3 times independently, including via the
project's own `format:check` script.

## 5. `.ai/findings.json` and `.ai/backlog.json` valid JSON

```
node -e "JSON.parse(require('fs').readFileSync('.ai/findings.json','utf8')); console.log('findings.json: valid JSON')"
findings.json: valid JSON

node -e "JSON.parse(require('fs').readFileSync('.ai/backlog.json','utf8')); console.log('backlog.json: valid JSON')"
backlog.json: valid JSON
```

Both valid. Inspected the CS-8 entry directly: `status: "QA"`,
`currentStep: "QA"` (already set, contrary to the builder's note that it
might not yet say "QA" — it does, as of the final state I read).
`.ai/findings.json` carries finding R4 with `status: "FIXED"`, describing
exactly the three-file defect and fix as summarized in the task.

## 6. Full harness — repeated for completeness

| Check             | Command                                                                                            | Result                                       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| V2 typecheck      | `node data/windows-toolchain/node_modules/node/bin/node.exe data/windows-v2/run.mjs run typecheck` | **PASS**                                     | `tsc -b` clean, `next typegen` "Types generated successfully", exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| V2 lint           | same launcher, `run lint`                                                                          | **PASS**                                     | `eslint ...` + web workspace eslint, exit 0, no errors/warnings printed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| V2 format:check   | same launcher, `run format:check`                                                                  | **PASS**                                     | "All matched files use Prettier code style!", exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| V2 build          | same launcher, `run build`                                                                         | **PASS**                                     | `tsc -b` + `next build` — "Compiled successfully", 5/5 static pages generated, exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| V2 test           | same launcher, `test` (57 node:test cases, run twice)                                              | **1 FAIL / 56 pass, both runs**              | `tests 57 / pass 56 / fail 1` both times. Failure: `BullMQ preserves durable completion, recovery, retry budgets and cancellation` in `packages/core/src/bull-queue.test.ts` — `error: canceling statement due to statement timeout` (Postgres code 57014), reproducible in 2 consecutive runs. **This file is untracked as changed** (`git status --porcelain v2/packages/core/src/bull-queue.test.ts` = clean) — pre-existing, not part of CS-8's diff. Likely environment-driven (fresh Docker services + heavy concurrent host load from this same QA session; 9 containers running simultaneously including an unrelated V1/OraOne stack). Flagging for the record, not blocking CS-8.                                                                                                                                                                                                                                                                                                                                                      |
| Root typecheck    | `npm run typecheck`                                                                                | **PASS**                                     | `tsc --build --force && tsc -p tsconfig.test.json && tsc -p tsconfig.test.web.json`, exit 0, no errors                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Root lint         | `npm run lint`                                                                                     | **PASS (1 pre-existing warning)**            | `eslint .` → `1 problem (0 errors, 1 warning)` — `design/build-refined-dark.mjs:663` unrelated `no-console` warning, not in CS-8's file list, exit 0                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Root format:check | `npm run format:check`                                                                             | **FAIL**                                     | `prettier --check .` → `[warn] docs/ai/baseline.json`, `[warn] docs/ai/baseline.md`, `[warn] scripts/check-agents.mjs`, "Code style issues found in 3 files", exit 1. First two files predate this session (mtime 2026-09-20, unrelated to CS-8). `scripts/check-agents.mjs` is the real, in-scope failure described in §4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Root tests        | `npm test` (`vitest run`, 1047 tests, run 3×)                                                      | **2–5 FAIL depending on host load, never 0** | Run 1: `4 failed \| 1043 passed (1047)`. Run 2 (heaviest concurrent load, v2 Docker services still up): `5 failed \| 1042 passed (1047)`. Run 3 (after stopping v2 Docker services): `2 failed \| 1045 passed (1047)` — the 2 failures present in every run: `apps/api/src/routes/production.test.ts > serves the production shell...` (`Error: Test timed out in 5000ms`) and `apps/web/src/routes/PublicJobs.test.tsx > shows only the public snapshot...` (`TestingLibraryElementError: Unable to find role="link" and name "React developer"` — a real, deterministic assertion failure, not a timeout). Neither test file, nor anything they import, is part of CS-8's diff (`git status --porcelain` shows no CS-8 changes to `apps/api` or `apps/web`); both routes' surrounding files (`LeadTable.tsx`, `page.tsx`, etc.) already show unrelated `M` modifications in the working tree predating this QA session. Pre-existing, out of CS-8's scope, but real and currently failing — flagged for the relevant builder, not this ticket. |

## Acceptance criteria — cited evidence

**AC1: "Every reader of .ai/\*.json distinguishes absent, valid and unparseable."**
**MET.** `engineering-ui.mjs`'s `read()` now records a `stateErrors` entry only
for parse failures, never for absence (§3a, and the dedicated
`engineering-ui: absent progress.json is NOT reported as a state error` PASS
in §2). `control-center.mjs`'s `progress()` returns `{parseError}` distinctly
from its `[]` absent-case (§3b). `check-agents.mjs`'s new `readJSON()` and the
new `.ai/CAREERSCOPE-PROGRESS.md` guard report named FAILs for both missing
and unparseable, distinctly worded ("is readable (missing)" vs. "is valid
JSON (<parse error>)") — see the diff and the live corrupted-file run in §3b.

**AC2: "Unparseable refuses; it is never reported as no findings."**
**MET**, demonstrated three independent ways: my own live corruption of
`findings.json` (§3a: `stateErrors` names the file, `findings` still shows
the empty fallback but is no longer the _only_ signal), my own live
corruption of `progress.json` against both `control-center.mjs` (UNREADABLE,
not "No progress matrix found") and `check-agents.mjs` (named FAIL, exit 1,
not a silent pass) in §3b.

**AC3: "Each is mutation-tested with all three cases, malformed included."**
**MET** for the four canonical files audited
(`backlog.json`/`findings.json`/`progress.json`/`LOOP-STATE.json`) across all
three readers, plus `.ai/CAREERSCOPE-PROGRESS.md` in `check-agents.mjs` — 24
mutation cases, all PASS, verified directly (§2) and via `gates:test`
wiring (§1). Absent, valid and malformed are each covered per file (e.g. lines
"malformed progress.json...", "absent progress.json...", and the baseline
"valid state produces no stateErrors" case).

## Final status

**CS-8's own scope: PASS**, all three acceptance criteria independently
verified against live, hand-corrupted files and the shipped mutation-test
suite (24/24), with `gates:test` green end-to-end.

**BLOCKING before merge: `scripts/check-agents.mjs` fails `npm run format:check`
/ `npx prettier --check`** right now, on disk, reproduced 3 times — a one-line
wrap. Route back to the builder for a `prettier --write` pass (do not hand-edit
around it) and re-run `npm run format:check` to confirm exit 0 before this
ticket moves past QA.

**Not blocking CS-8, reported for the record:** two pre-existing root-test
failures outside CS-8's diff (`production.test.ts` timeout,
`PublicJobs.test.tsx` assertion failure) and one pre-existing v2 test failure
(`bull-queue.test.ts` Postgres statement timeout, likely load-related under
this session's heavy concurrent Docker usage). None of the touched files for
any of these three are part of CS-8's change.

---

# QA Report — CS-29 "Deployed app consumes shared packages as built files, not dependencies"

Independent verification run 2026-09-22, ~19:20-19:50 IST, on
C:\Users\Admin\Desktop\CareerScope (Windows). Working tree was NOT edited by
QA. Docker services were already running for v2 but with the wrong port
mapping (base compose only, not the Windows override) - QA recreated them
via the pinned launcher (`data\windows-v2\run.mjs --services up -d`), which
correctly moved Postgres to the 127.0.0.1:5435 mapping the launcher's env
expects. All 6 requested test files were also run directly with a
manually-corrected `DATABASE_URL` (port 5435) since bypassing the launcher's
npm wrapper meant reading `v2/.env` verbatim (port 55433).

## Summary verdict: PASS

CS-29's three acceptance criteria are met by the working-tree diff as it
stands:

1. **"v2 depends on the shared packages through workspace resolution, not
   relative dist paths"** - CONFIRMED. `v2/node_modules/@job-radar/{providers,
matching,shared,resume}` are real Windows junctions resolving to the root
   `packages/*` directories (see §2). All 9 source-site imports across
   `v2/apps/workers/search/src/collect.ts`,
   `v2/apps/workers/search/src/collect.test.ts`,
   `v2/packages/core/src/{jobs,profile,resume-parser,resume-parser-child,
resumes,database.test}.ts` now import bare `@job-radar/providers` /
   `@job-radar/matching` / `@job-radar/shared` / `@job-radar/resume`, not
   `../../../../packages/*/dist/*.js`. A whole-repo grep (§5) found no
   remaining relative `packages/\w+/dist` **import** sites; the only
   surviving hits are documentation prose, a multi-stage Dockerfile `COPY`
   (build-artifact staging, not a JS import), and
   `infra/v3/check-full-disk.mjs`, which imports **v2's own** local
   `v2/packages/core/dist/*` (a different, pre-existing, untouched-by-this-
   diff pattern, unrelated to the root `@job-radar/*` packages this ticket
   is about).
2. **"A stale or missing build fails loudly at start rather than being
   silently consumed"** - CONFIRMED live. Renamed `packages/providers/dist`
   away, ran `node -e "import('@job-radar/providers')..."` from `v2/`, got
   `ERR_MODULE_NOT_FOUND` (not a silent resolve to something else, not an
   empty module). Restored the directory immediately; `git status --porcelain
packages/providers` was empty afterward and `packages/providers/dist`
   still has all 41 original entries; a follow-up import succeeded normally.
3. **"Split out of CS-5 so it can ship in days without waiting on the full
   retirement"** - CONFIRMED for the specific package.json/import-site diff:
   no V1 code paths, no V1 removal, no full-retirement work is present in the
   `@job-radar/*` dependency-wiring changes. NOTE (scope observation, not a
   CS-29 defect): the _working tree as a whole_ also contains a large,
   unrelated, uncommitted OpenAPI/Swagger feature (`v2/apps/api/src/openapi.ts`,
   `v2/apps/api/src/app.ts`, `v2/apps/api/package.json` swagger deps, ~700
   new lines in `v2/packages/core/src/database.test.ts`) and an unrelated
   permission-check rewrite in `v2/packages/core/src/resume-parser-child.ts`
   (Node 25 `--allow-net` handling) plus a widened `--allow-fs-read` grant in
   `v2/packages/core/src/resume-parser.ts`. None of this is V1-retirement
   work, but it is bundled in the same dirty working tree and should not be
   attributed to, or block, the CS-29 diff itself; flagging so it isn't
   accidentally squashed into the same commit as CS-29.

## 1. V2 checks (via `data\windows-v2\run.mjs`, pinned Node 26.8.1)

```
npm run typecheck  -> exit 0 ("Types generated successfully")
npm run lint       -> exit 0 (eslint packages apps/api apps/workers scripts ... ; web lint clean)
npm run format:check -> exit 0 ("All matched files use Prettier code style!")
npm run build      -> exit 0 (tsc -b; Next.js 16.3.5 build compiled, 5 static routes generated)
```

`npm run test` (packages/core/src/_.test.ts + apps/workers/search/src/_.test.ts,
via node --test, after `npm run build:core`):

- 1st attempt: FAILED at ECONNREFUSED 127.0.0.1:5435 (Postgres was still
  running under the base compose port 55433, not yet recreated under the
  Windows override) - environment setup issue, fixed by
  `run.mjs --services up -d`.
- 2nd attempt (services now correctly mapped): `tests 57, pass 56, fail 1`
  (`packages\core\src\database.test.ts` "partial search outcomes are atomic,
  owner-scoped, terminal and usable through the API" -> `error: terminating
connection due to administrator command`, a mid-test Postgres connection
  reset, not a code assertion failure).
- 3rd attempt (immediate re-run, no code or config changes): `tests 57, pass
57, fail 0`, exit 0. Confirms the 2nd-attempt failure was transient
  infra flakiness (a Postgres connection getting killed under this Windows
  Docker setup), not a regression from the CS-29 diff - the failing test
  exercises HTTP/DB plumbing unrelated to the `@job-radar/*` import change
  and passed cleanly moments later with zero code changes in between.

## 2. `@job-radar/*` junctions in `v2/node_modules`

```
v2\node_modules\@job-radar\providers -> Junction -> C:\...\CareerScope\packages\providers
v2\node_modules\@job-radar\matching  -> Junction -> C:\...\CareerScope\packages\matching
v2\node_modules\@job-radar\shared    -> Junction -> C:\...\CareerScope\packages\shared
v2\node_modules\@job-radar\resume    -> Junction -> C:\...\CareerScope\packages\resume
```

All four confirmed real filesystem junctions (Windows equivalent of a
workspace symlink) pointing at the root-level source packages, not copies.

## 3. The 6 requested test files, run directly (node --test, pinned Node

26.8.1, DATABASE_URL port corrected to 5435 to match the recreated
Postgres container; REDIS_URL/LOCAL_AWS_ENDPOINT taken from v2/.env
unchanged):

| File                                    | tests | pass | fail | notes                                            |
| --------------------------------------- | ----- | ---- | ---- | ------------------------------------------------ |
| packages/core/src/database.test.ts      | 13    | 13   | 0    | exit 0                                           |
| apps/workers/search/src/collect.test.ts | 14    | 14   | 0    | exit 0 (~59s, includes a real 55s deadline test) |
| packages/core/src/resumes.test.ts       | 2     | 2    | 0    | exit 0                                           |
| packages/core/src/market.test.ts        | 2     | 2    | 0    | exit 0                                           |
| packages/core/src/queue.test.ts         | 2     | 2    | 0    | exit 0                                           |
| packages/core/src/runtime.test.ts       | 3     | 3    | 0    | exit 0                                           |

Total: 36 tests, 36 pass, 0 fail across the 6 files run individually.

`packages/core/src/bull-queue.test.ts` (optional, run anyway): confirmed by
inspecting its imports first (`node:*`, `bullmq`, `drizzle-orm/node-postgres/
migrator`, `@careerscope/core`, local `./bull-queue.js`, `./dispatch.js` -
no `@job-radar/*`, no relative `packages/*/dist` path) - so it is provably
out of scope for this fix either way. Ran it anyway: `tests 2, pass 2, fail
0`, exit 0. No flakiness observed this run.

## 4. Missing-build failure mode (live test)

```
Get-ChildItem packages\providers\dist   # 41 real entries (index.js, http.js, ...) before rename
Rename-Item packages\providers\dist dist_disabled_qa
cd v2; node -e "import('@job-radar/providers').then(()=>console.log('bug')).catch(e=>console.log(e.code, e.message))"
-> ERR_MODULE_NOT_FOUND | Cannot find module 'C:\...\v2\node_modules\@job-radar\providers\dist\index.js' imported from ...
Rename-Item packages\providers\dist_disabled_qa dist   # restored immediately
git status --porcelain packages/providers   -> (empty)
Test-Path packages\providers\dist           -> True
Get-ChildItem packages\providers\dist | count -> 41 (all original entries intact)
node -e "import('@job-radar/providers').then(m=>console.log('ok', typeof m.createRemoteOkProvider))"
-> ok function   (import works again post-restore)
```

Confirms a missing build fails loudly (ERR_MODULE_NOT_FOUND, uncaught unless
the caller explicitly catches it) rather than silently resolving to nothing
or stale content.

## 5. Whole-repo grep for remaining relative dist-path imports

`git grep -n -E "packages/[A-Za-z0-9_-]+/dist"` (tracked files) plus a scan of
untracked files, both excluding node_modules:

```
.ai/backlog.json          - prose describing the resume-parser permission fix, not code
.ai/findings.json         - prose, not code
.github/skills/careerscope-architecture/SKILL.md - doc prose ("imports ... from packages/shared/dist")
infra/Dockerfile          - COPY --from=build .../packages/{shared,resume,matching,providers}/dist ... (multi-stage build artifact staging, not a JS/TS import statement)
infra/v3/check-full-disk.mjs - imports v2's OWN packages/core/dist (a different, pre-existing, untouched pattern; not the root @job-radar/* packages this ticket addresses)
```

No remaining relative `packages/*/dist` **import statements** for the four
`@job-radar/*` packages were found anywhere in the repo outside of what this
diff already fixed.

## 6. Root workspace checks

```
npm run typecheck    -> exit 0
npm run lint         -> exit 0 (1 pre-existing warning, unrelated file design/build-refined-dark.mjs: no-console)
npm run format:check -> exit 1 - FAILS: "docs/ai/baseline.json", "docs/ai/baseline.md" need formatting.
                         These are untracked (`git status --porcelain docs/ai` -> "?? docs/ai/"),
                         unrelated to CS-29 (no @job-radar or packages/*/dist content), and not
                         touched by this diff. Reporting as a real, currently-failing command,
                         but not attributable to the CS-29 fix under review.
npm test             -> Test Files 67 passed (67), Tests 1047 passed (1047), exit 0
```

## Bottom line

CS-29's fix (file: dependencies + junctions + 9 import-site edits) is
independently verified: typecheck/lint/format/build/test all pass for v2 on a
clean run; the shared-package junctions are real; a missing build now fails
loudly with `ERR_MODULE_NOT_FOUND`; no missed relative dist-path imports
remain for the affected packages; and the diff itself carries no V1-retirement
scope. The one real, currently-failing command found in this session
(`npm run format:check` at the repo root, due to untracked `docs/ai/baseline.*`
files) is unrelated to CS-29 and should be raised separately, not treated as a
blocker for this ticket. The one v2 test failure seen mid-session was
confirmed transient (passed on immediate re-run with no changes).

---

# QA Report — CS-28 "Two different openings can be merged into one"

Independent verification run 2026-09-22, ~22:59–23:20 IST, repo root
`C:\Users\Admin\Desktop\CareerScope`. Working tree changes are uncommitted;
nothing was stashed, reset or checked out. All commands below were actually
executed this session; output is trimmed for length but numbers are verbatim.

## Verdict

**Functionally: PASS.** The dedup fix in `packages/providers/src/normalize.ts`
(`resolveFingerprintGroup` / `disambiguateFingerprint`) is real and
non-vacuous — proven by reverting it to the old single-key merge and watching
exactly the two new split-detection tests fail (see §4). The new
`job_sightings` recompute (`v2/scripts/backfill-job-sightings.ts`) is
correctly tested (6/6, including a real Postgres integration test). The
`collect.ts` wiring correctly threads the disambiguated fingerprint through to
`sourceLinks`/`postedAt`, confirmed both by the existing suite and by an
independent 3-provider/4-lead scenario I designed myself (§5), which also
fails under the reintroduced bug.

**Gate-level: FAIL.** `npm run format:check` in `v2/` genuinely fails on 4
files that are part of this changeset (§2). This is not one of the
pre-approved pre-existing warnings — it is new, in-scope, and must go back to
the builder before merge.

All other requested checks (typecheck, lint, unit, integration, root
workspace) are clean. Full detail below.

## 1. Root workspace (`npm run typecheck` / `lint` / `format:check` / `test`)

```
> npm run typecheck
> tsc --build --force && tsc -p tsconfig.test.json && tsc -p tsconfig.test.web.json
```

Exit 0, no diagnostics.

```
> npm run lint
> eslint .
C:\Users\Admin\Desktop\CareerScope\design\build-refined-dark.mjs
  663:1  warning  Unexpected console statement...  no-console
✖ 1 problem (0 errors, 1 warning)
```

0 errors. The 1 warning is in `design/build-refined-dark.mjs`, not a CS-28
file — pre-existing, out of scope.

```
> npm run format:check
> prettier --check .
[warn] .ai/QA-REPORT.md
[warn] docs/ai/baseline.json
[warn] docs/ai/baseline.md
Code style issues found in 3 files.
```

Exactly the 3 files called out as pre-existing/expected in the task. **No
other files flagged** — confirms `packages/providers/src/normalize.ts`,
`normalize.test.ts` and `packages/shared/src/schemas.ts` are clean at the root
level.

```
> npm test
> vitest run
 Test Files  67 passed (67)
      Tests  1055 passed (1055)
   Duration  76.31s
```

1055 passed (1055). No skips.

## 2. V2 workspace, via `data/windows-v2/run.mjs` (Node 26.8.1 toolchain)

Docker services were brought up with `docker compose --env-file .env -f
compose.yml up -d --wait` directly at first — this was **wrong**: it binds
Postgres on host port 55433, inside Windows' reserved dynamic-port range
55403–55502, and skips the `data/windows-v2/compose.yml` overlay that remaps
it to 5435. Caught, torn down, and restarted correctly:

```
node data/windows-toolchain/node_modules/node/bin/node.exe data/windows-v2/run.mjs --services up -d --wait
Container careerscope-v2-postgres-1    Healthy
Container careerscope-v2-redis-1       Healthy
Container careerscope-v2-redis-queue-1 Healthy
Container careerscope-v2-localstack-1  Healthy
```

```
> npm run typecheck   (v2)
tsc -b && next typegen && tsc --noEmit ...
✓ Types generated successfully
```

Exit 0, no diagnostics.

```
> npm run lint   (v2)
eslint packages apps/api apps/workers scripts drizzle.config.ts eslint.config.mjs
  (no output)
npm run lint --workspace @careerscope/web
  (no output)
```

Exit 0, 0 errors, 0 warnings.

```
> npm run format:check   (v2)
> prettier --check .
[warn] apps/workers/search/src/collect.test.ts
[warn] apps/workers/search/src/collect.ts
[warn] scripts/backfill-job-sightings.test.ts
[warn] scripts/backfill-job-sightings.ts
Code style issues found in 4 files.
```

**FAIL — exit 1.** All 4 flagged files are part of this ticket's changeset.
I verified this is not a false positive from `.prettierignore` interference
(root's `.prettierignore` excludes `v2/` wholesale, which would silently
no-op a check run from repo root with `v2/...` paths — I hit that trap first
and discarded the misleading "pass" it gave). Run correctly from inside
`v2/`, against the same Prettier config, the failure is real. Concrete diffs
(`prettier` output vs. current file, via `git diff --no-index`):

- `apps/workers/search/src/collect.ts` — a 4-argument `jobFingerprint(...)`
  call exceeds printWidth 100 unwrapped; Prettier wants it wrapped one
  arg/line.
- `apps/workers/search/src/collect.test.ts` — the `await collect(...)` call
  in "two distinct reqs from one source..." is wrapped across 5 lines but
  fits Prettier's printWidth on one line; Prettier wants it collapsed.
- `v2/scripts/backfill-job-sightings.ts` — one stray trailing blank line at
  EOF.
- `v2/scripts/backfill-job-sightings.test.ts` — the `test(name, async () =>
{...})` call is wrapped as `test(\n  'name',\n  async () => {...` where
  Prettier wants `test('name', async () => {` on one line (cascading
  reindentation of the whole test body), plus `jobs: typeof reqOne[]` should
  be `jobs: (typeof reqOne)[]`.

None of these are semantic — no logic changes needed — but the gate fails as
written, and this task's remit is to report, not to fix (fixing needs the
`edit` tool the QA agent does not have). **Hand back to the builder**:
`npm run format --prefix v2` (i.e. `prettier --write .` from `v2/`) would
resolve all 4 in one pass.

```
> npm run test:unit   (v2)
✔ ... (35 tests, incl. "two distinct reqs from one source ... stay two leads")
ℹ tests 35  pass 35  fail 0  skipped 0
```

```
> npm run test:integration   (v2)
✔ ... (26 tests, incl. database.test.ts's posting-evidence / pipeline tests)
ℹ tests 26  pass 26  fail 0  skipped 0
```

```
> npm run test:backfill-job-sightings   (v2)
✔ replay accumulates sightings and repost_count in run order, matching the live upsert
✔ a run with a null postedAt keeps the previous claimed date rather than clearing it
✔ keeps a genuinely split posting as its own row, not folded into its sibling
✔ scopes sightings per owner even when two owners share a fingerprint
✔ returns an empty map for no history
✔ rebuildJobSightings replaces drifted job_sightings state with a fresh replay of search_jobs
ℹ tests 6  pass 6  fail 0  skipped 0
```

All new/related tests pass, including the one that actually opens an
isolated Postgres database, runs two `completeCollection` cycles with the
two-split fixture from the ticket, and diffs the recomputed `job_sightings`
against a corrupted seed.

## 3. `npx vitest run packages/providers/src/normalize.test.ts` (repo root)

```
 Test Files  1 passed (1)
      Tests  56 passed (56)
```

56/56, full file, no skips.

## 4. Non-vacuousness of the core fix (mutation test)

Captured `git diff packages/providers/src/normalize.ts` and a SHA-256 of the
file before touching anything (`A79F5636A87C2AB4F958B7C0323A91FA759970D698068D5A345A2C4CD9569467`).
Replaced `resolveFingerprintGroup`'s body with the old vacuous single-key
merge (`return [jobs.reduce(mergeDuplicates)];`), leaving everything else
untouched, and re-ran the same file:

```
❯ dedupeJobs (9)
  × keeps two distinct reqs from the same source apart, even with an identical title, company and city
  × does not guess which of two same-source reqs an unrelated source belongs to
 Test Files  1 failed (1)
      Tests  2 failed | 54 passed (56)
```

Exactly the two split-detection tests fail — every other test (including the
"gives a split posting a fingerprint that is the same on every call" and
"still collapses a genuine cross-source duplicate" tests, which are true
either way and so don't discriminate) keeps passing, as expected. This is the
right failure signature for a non-vacuous fix.

Restored the file from the pre-mutation copy and verified byte-for-byte
identity two ways: SHA-256 (`A79F5636A87...` — matches) and
`Compare-Object` on the `git diff` patch text before vs. after (empty diff).
Re-ran `normalize.test.ts`: 56/56 again.

## 5. Independent end-to-end scenario through `collect()`

Existing coverage only exercises the split case with **one** source
contributing two reqs. I wrote and ran (as a temporary standalone file,
deleted afterward — never committed or left behind) a scenario with **three**
providers in one `collect()` call:

- `remoteok` yields two genuinely different reqs (`req-1`, `req-2`) under one
  fingerprint (the "split" case).
- `himalayas` yields one more posting that also collides on the exact same
  fingerprint (title/company/city) — the "unrelated third source" case the
  code's own comment says must never be guessed into either split req.
- `greenhouse` yields a completely unrelated fourth job (different title), to
  confirm the split logic in one fingerprint bucket doesn't leak into an
  unrelated bucket in the same run.

Asserted: `status === 'completed'`, exactly 4 leads with 4 distinct
fingerprints, each of the three colliding postings keeps `sourceLinks`
scoped to only its own URL (the literal false-merge evidence-corruption this
ticket exists to prevent), each keeps its own distinct `postedAt`, and
per-source `outcomes.accepted` counts (2/1/1) are correct.

First run against the real (correct) code: **passed** in one iteration after
fixing two of my own test bugs (an invalid v2 source enum value and a missing
`.000Z` on expected ISO timestamps — both my mistakes, not product bugs).

Then I discovered `@job-radar/providers` in `v2/node_modules` is a filesystem
junction to the _pre-built_ `packages/providers/dist/`, not the live
TypeScript source — so my first mutation-of-source-only attempt against this
v2-side test silently didn't reproduce the bug (dist still had the fix
baked in). I rebuilt `packages/providers` (`tsc -b --force`) with the
mutated source in place, confirmed the mutated logic actually landed in
`dist/normalize.js`, and reran:

```
✖ QA-CS28: ... req-1, req-2, the himalayas scrape and the unrelated Frontend Engineer must all survive as distinct leads
  2 !== 4
```

Confirms the new scenario is genuinely non-vacuous end-to-end, not just at
the unit level — the false-merge bug collapses these 4 postings down to 2.

Restored `normalize.ts` from the same pre-mutation backup, rebuilt
`packages/providers` again, and verified `dist/normalize.js` is byte-for-byte
identical to its pre-mutation state (SHA-256
`68F6AB28694393A87618F722965A22CC249841EDF8CA2D2EF528F762C999095F` both
before and after). Reran the new scenario once more: passed. Deleted the
temporary test file (`v2/apps/workers/search/src/collect.qa-cs28.test.ts`
never existed in git and does not exist on disk now). `dist/` is
git-ignored, so none of this rebuilding touched tracked state either way.

## 6. Final `git status` / working-tree integrity

`git status --porcelain` captured before starting and again at the very end:
identical, verified with `Compare-Object` (zero differing lines).
`packages/providers/src/normalize.ts` SHA-256 confirmed identical
before/after (`A79F5636A87C2AB4F958B7C0323A91FA759970D698068D5A345A2C4CD9569467`).
No stray files, no leftover QA fixtures, no changes to any file outside what
was already modified/untracked at session start.

Note (unrelated to CS-28, reported for completeness only): the working tree
at session start already carries a very large amount of uncommitted,
unrelated change (68 modified + numerous untracked files spanning docs,
`.ai/`, `.github/`, scoring/matching, resume parsing, etc.) beyond the 8
files/areas CS-28's own file list names. None of that was touched, evaluated,
or attributed to CS-28 by this pass; it is out of scope for this ticket's
verification and is exactly as it was found.
---

# QA Report — CS-3 "Proxy restart strands every service behind a healthy-looking 502"

Independent verification run 2026-09-23, session ~06:02 IST. All commands run for
real from repo root (Windows host; bash steps via `C:\Program Files\Git\bin\bash.exe`)
unless noted.

## Summary verdict

**PASS.** `infra/v3/check-proxy-recovery.sh` passes all 14 assertions against the
real, unmodified `infra/v3/recover-proxy.sh`. The state machine was traced by
hand and has no path where a single bad check (below `PROXY_CONFIRM_THRESHOLD`)
can trigger a restart, and no path where the cooldown circuit breaker can be
bypassed. The test suite was proven non-vacuous by mutating a scratch copy to
remove the confirm-threshold gate: the "no restart on the first bad check
alone" assertion then failed with a real, specific mismatch (`expected '0', got
'1'`), and the real files were reconfirmed unmodified and still 14/14 afterward.
`restart-stack.sh` was read and its behaviour (restart proxy, restart dependents
in dependency order, verify from inside the proxy network namespace) matches
what the ticket claims it does. The systemd unit/timer/installer are internally
consistent: the installed script path, the explicit absolute
`PROXY_RESTART_SCRIPT` in the service unit, and the `/opt/careerscope/infra/v3`
checkout path used elsewhere in `docs/OPERATIONS/DEPLOYMENT.md` all agree, and
the timer's 2-minute cadence is consistent with a ~4-6 minute recovery claim
(2-3 confirm-then-restart cycles). CI wiring for the new step is present and
correctly placed in the `verify` job, self-contained (stubbed curl/restart
script, no real host). Root typecheck, lint, format:check and the full root
`npm test` are clean against the known pre-existing baseline. CS-24/CS-25 are
unaffected: monitoring is fully clean and backup is 17/19 with only the 2
known Windows-permission-reporting failures (0600/0700 mode checks, which
cannot report correctly on an NTFS/Windows filesystem).

No defects found in the CS-3 change itself.

## 1. `check-proxy-recovery.sh` — full real output (14/14)

Command:

```
bash infra/v3/check-proxy-recovery.sh
```

Full output:

```
== healthy: no restart, no alert
PASS no restart on a healthy check
PASS no alert on a healthy check
== a single bad check is not enough to act (confirm threshold)
PASS no restart on the first bad check alone
PASS no alert on the first bad check alone
== a confirmed outage (threshold reached) triggers exactly one restart
PASS restart-stack.sh is invoked exactly once
PASS at least one alert is sent for the confirmed outage
== circuit breaker: still down, but inside the cooldown window - does not restart again
PASS restart-stack.sh is still only invoked once (not twice)
== after the cooldown window elapses, still down - restarts again
PASS restart-stack.sh is invoked a second time once the cooldown has elapsed
== recovery is announced once, then no more once it stays healthy
PASS recovery alert fires
PASS staying healthy does not re-alert
== a restart-stack.sh failure is still alerted, not silently absorbed
PASS restart-stack.sh was invoked
PASS a failed restart still alerts
all proxy-recovery checks passed
```

Exit code: 0. All 14 named assertions are PASS, matching every scenario the
task called for: healthy no-op, single-bad-check non-trigger, confirmed-outage
single restart, in-cooldown non-retrigger, post-cooldown retrigger, one-shot
recovery announcement with no re-alert while healthy, and alert-on-restart-failure.

## 2. Hand-trace of the state machine (`infra/v3/recover-proxy.sh`, read in full)

Read the entire script. Key structure:

- `healthy` is computed purely from the curl probe against `MONITOR_URL` (same
  symptom check as CS-24's monitor.sh): curl failure OR missing `"status":"ok"`
  in the body ⇒ unhealthy.
- State (`CONSECUTIVE`, `LAST_RESTART`) is read from `$state_file` at the top of
  every run, defaulting to 0 if absent.
- **Healthy branch**: if healthy, `CONSECUTIVE` is unconditionally reset to 0
  and the script exits 0 immediately — no path through the restart logic is
  reachable here at all. Recovery is announced only if the _prior_ consecutive
  count was `>= CONFIRM_THRESHOLD`, so a recovery alert fires only after a
  confirmed (not a single-blip) outage, exactly once (next healthy run finds
  `CONSECUTIVE` already 0 and stays silent).
- **Unhealthy branch**: `consecutive` is incremented. Immediately after that,
  `if [ "$consecutive" -lt "$CONFIRM_THRESHOLD" ]; then ... exit 0; fi` — this
  is an unconditional early exit with no fallthrough (the `fi` is followed
  directly by the cooldown check, meaning code reaches the cooldown/restart
  logic **only** when this condition is false, i.e. only once
  `consecutive >= CONFIRM_THRESHOLD`). There is no other branch, flag, or
  variable that can cause a jump into the restart logic while
  `consecutive < CONFIRM_THRESHOLD` — the single `if/exit 0/fi` gate is the
  only control-flow path in the function, and it always evaluates the same
  comparison against the same freshly-incremented `$consecutive`.
  **Conclusion: no, there is no path where a single bad check below threshold
  can trigger a restart.** Confirmed empirically in §3 below by removing this
  exact gate and watching the assertion fail.
- **Cooldown branch**: reached only after the threshold gate above is passed.
  `if [ "$((now - last_restart)) -lt "$COOLDOWN_SECONDS" ]; then` sends the
  "still down, not retrying" alert and exits 0 without ever reaching the
  `send_alert "...running restart-stack.sh automatically"` / `"$RESTART_SCRIPT"`
  invocation lines below it. Those restart-invocation lines are physically
  unreachable except by falling through both the confirm-threshold gate above
  and the cooldown gate — there is no `goto`, no early flag-based bypass, and
  `last_restart` is only ever updated to `$now` in the one place right after the
  actual restart invocation, so there is no way to reset/forge it from the
  unhealthy branch itself. **Conclusion: no, the cooldown check cannot be
  bypassed** — it is a single unconditional gate directly in the sequential
  path to the restart invocation, with no alternate route around it.

## 3. Proving the suite is non-vacuous (mutation test)

Made a scratch copy of both scripts in a `mktemp -d` directory (never the real
files), replaced the confirm-threshold gate
(`if [ "$consecutive" -lt "$CONFIRM_THRESHOLD" ]; then`) with `if false; then` in
the scratch `recover-proxy.sh` (so it always falls through and acts on the very
first bad check), pointed a scratch copy of `check-proxy-recovery.sh` at that
mutated script, and ran it.

Confirmed the mutation actually took effect (diff showed the real file differs
from the scratch file — the `sed` replacement is present).

Result running the scratch harness against the mutated script:

```
== a single bad check is not enough to act (confirm threshold)
FAIL no restart on the first bad check alone :: expected '0', got '1'
FAIL no alert on the first bad check alone :: expected '0', got '2'
...
2 check(s) failed
```

This is exactly the expected, specific mismatch: with the gate removed, the
first bad check now invokes `restart-stack.sh` once (`got '1'`) and sends two
alerts instead of zero. The suite is not vacuously green — it genuinely detects
this regression.

Both scratch files lived only under a `mktemp -d` path and were removed
(`rm -rf "$tmp"` / `trap ... EXIT`) at the end of the run. Verified afterward
with `git status --porcelain infra/v3/recover-proxy.sh infra/v3/check-proxy-recovery.sh`
— both show as untracked new files (`??`), no modification marker (`M`), and
re-running the real, untouched suite again gave the identical 14/14 PASS
output shown in §1.

## 4. `restart-stack.sh` — read-only verification

Read in full. Header comment and body confirm: because every service uses
`network_mode: service:proxy`, restarting the proxy alone destroys and rebuilds
the single shared network namespace, which strands every dependent container
attached to the now-dead old namespace (all still individually "healthy" on
their own healthchecks — this is exactly the "healthy-looking 502" in the
ticket title). The script therefore, in order:

1. Restarts `proxy`.
2. Restarts the dependents in dependency order
   (`postgres redis localstack api web publisher search files`), re-attaching
   them to the new namespace.
3. Polls `docker ps` for up to ~60s waiting for no `unhealthy`/`starting`
   containers.
4. Verifies the origin from _inside_ the proxy's own network namespace
   (`docker exec careerscope-proxy-1 wget ...` against `web` and `api`), which
   is the only vantage point that would actually catch the orphaned-namespace
   failure — checking from the host or from each container's own healthcheck
   would not.
5. On failure, prints an explicit `--force-recreate` escape hatch and exits 1;
   on success, prints "restart complete" and exits 0.

This matches the ticket's description exactly: restart proxy → dependents in
order → verify from inside the proxy namespace. `recover-proxy.sh` treats this
script's exit code as the sole signal of restart success/failure and alerts on
non-zero, matching what was found in §2.

## 5. systemd unit / timer / installer consistency

- `setup-proxy-recovery.sh` installs `recover-proxy.sh` to
  `/usr/local/bin/careerscope-recover-proxy.sh` and both unit files to
  `/etc/systemd/system/`. `careerscope-proxy-recovery.service`'s `ExecStart`
  references exactly `/usr/local/bin/careerscope-recover-proxy.sh` — matches.
- The service unit sets `Environment=PROXY_RESTART_SCRIPT=/opt/careerscope/infra/v3/restart-stack.sh`
  explicitly, with a comment explaining why: `recover-proxy.sh`'s own default
  (relative to `${BASH_SOURCE[0]}`) would resolve to `/usr/local/bin/` once
  installed there, which is wrong. Confirmed this is not left to the script's
  own default.
- Confirmed `/opt/careerscope/infra/v3` is indeed the real deployed checkout
  path used throughout `docs/OPERATIONS/DEPLOYMENT.md` (`grep` hit 11 times,
  including `cd /opt/careerscope/infra/v3 && ...` deploy-sequence lines and
  `bash /opt/careerscope/infra/v3/restart-stack.sh` for the manual recovery
  instructions) — the service unit's absolute path matches the actual
  deployment target exactly, not just superficially.
- Timer cadence: `OnUnitActiveSec=2min` (`OnBootSec=1min` for the first run),
  with a comment stating this is faster than CS-24 monitor's 5-minute cadence
  on purpose. Design doc's claimed "recovers within roughly 4-6 minutes" is
  consistent with the default `PROXY_CONFIRM_THRESHOLD=2`: bad check 1 (up to
  2min in), confirming bad check 2 (up to 2min later, triggers the restart) —
  2 cycles ≈ 4min, 3 cycles (allowing one scheduling slip) ≈ 6min. Consistent.
- State directory (`/var/lib/careerscope-monitor`) and env file
  (`/etc/careerscope-monitor.env`) are explicitly documented as shared with
  CS-24's `careerscope-monitor.service`/`.timer` — installer checks for an
  existing env file before overwriting, so re-running this installer after
  CS-24 is already deployed does not clobber CS-24's webhook config.

## 6. CI wiring

`.github/workflows/ci.yml`, `verify` job, found at lines 100-101:

```yaml
# Self-contained against stub curl/restart-stack.sh binaries - same
# reasoning as CS-24's monitor test.
- name: Test infra proxy recovery (CS-3)
  run: bash infra/v3/check-proxy-recovery.sh
```

Placed immediately after "Test infra database backup (CS-25)" and before the
V2 test step, inside the same `verify` job as the CS-24 monitor step
("Test infra host monitor (CS-24)") and CS-25 backup step — same job, same
self-contained-stub reasoning, correctly grouped with the other infra/v3
check-*.sh steps that need no real deployed host. Present and correctly placed.

## 7. Root typecheck / lint

```
npx tsc --noEmit -p .
```

Exit code: 0. Clean, no output.

```
npm run lint
```

```
> job-radar@1.3.4 lint
> eslint .

C:\Users\Admin\Desktop\CareerScope\design\build-refined-dark.mjs
  663:1  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console

✖ 1 problem (0 errors, 1 warning)
```

Exit code: 0. Exactly the one pre-existing, unrelated warning expected —
0 errors, no new warnings introduced by CS-3 (which touched no lintable JS/TS
files at all — `infra/v3` is shell scripts and systemd units).

## 8. Root format:check

```
npm run format:check
```

```
> job-radar@1.3.4 format:check
> prettier --check .

Checking formatting...
[warn] .ai/QA-REPORT.md
[warn] docs/ai/baseline.json
[warn] docs/ai/baseline.md
[warn] Code style issues found in 3 files. Run Prettier with --write to fix.
```

Exit code: 1 (prettier's own convention for "issues found"), but exactly the 3
pre-existing, unrelated files called out in the task brief — `.ai/QA-REPORT.md`
(this file — pre-existing before this session's edits), `docs/ai/baseline.json`,
`docs/ai/baseline.md`. No new file flagged. CS-3's shell scripts and systemd
units are outside Prettier's scope entirely.

## 9. Root test suite (full)

```
npm test
```

```
 Test Files  67 passed (67)
      Tests  1055 passed (1055)
   Start at  06:04:56
   Duration  69.19s
```

Exit code: 0. 1055/1055 passed, 0 skipped, 0 failed.

## 10. CS-24 / CS-25 regression check

```
bash infra/v3/check-monitoring.sh
```

All 17 named assertions PASS (unreachable/unhealthy/stopped/stale/unreadable-
backlog/ok classification, alert dedup + re-notify window, one-shot recovery
alert, insecure-webhook refusal, webhook-URL redaction) — fully clean, exit 0.

```
bash infra/v3/check-backup.sh
```

17 of 19 named assertions PASS. The 2 failures are exactly the expected,
pre-existing Windows-permission-reporting limitation:

```
FAIL promoted dump is root-restrictable (0600) :: expected '600', got '644'
FAIL backup dir is root-only (0700) :: expected '700', got '755'
```

Both are `chmod` mode-bit assertions that cannot report correctly on the
NTFS-backed filesystem this session runs on (Git Bash on Windows does not
support POSIX permission bits the way a real Linux host does) — not a CS-3 or
CS-25 regression. Everything else (dump/restore/promote, retention, webhook
alerting, staging-file cleanup, byte-identical untouched-on-failure dump)
passed.

CS-24 and CS-25 are unaffected by the CS-3 change.

## Verdict

**PASS.**

- CS-3's own acceptance criteria (Caddy crash recovers without operator
  action, or is detected and alerted; proven by killing Caddy and observing
  the result) are satisfied by the automated `check-proxy-recovery.sh`
  simulation of exactly that scenario (confirmed outage → automatic
  `restart-stack.sh` invocation → alert either way), since a real Caddy kill
  against a real deployed host was not available in this session (no such
  host exists here) — this is the same class of substitution CS-24/CS-25's
  own stub-based CI tests already use, and is what the task brief itself
  specified running.
- No path exists for a single bad check to trigger a restart, and no path
  exists to bypass the cooldown circuit breaker (§2), confirmed both by
  manual trace and by an empirical mutation test that fails in exactly the
  expected way when the guard is removed (§3).
- `restart-stack.sh`'s actual behaviour matches what CS-3 claims it
  automates (§4).
- systemd unit/timer/installer paths and cadence are internally consistent
  and match the documented deployment layout (§5).
- CI wiring is present, correctly placed, and self-contained (§6).
- Root typecheck/lint/format/test are all clean against the known baseline,
  with no new failures introduced (§§7-9).
- CS-24/CS-25 are unaffected (§10).

Nothing needs to change.

---

# QA Report — CS-49 "Dashboard: real route using the extracted shared shell, no invented metrics"

Independent verification run 2026-09-23, ~11:30–12:05 IST. All commands run for
real against the live repo/stack. Area under test:
`v2/apps/web/src/app/dashboard/page.tsx`,
`v2/apps/web/src/components/dashboard-shell.tsx`,
`v2/apps/web/src/components/dashboard-shell.module.css`.

## Governance flag before anything else

`.ai/backlog.json` CS-49 is recorded as `"status": "DISCOVERY"` and its own
acceptance criteria explicitly say: (a) "does not implement ... any AI
Assistant panel (out of scope ... AI work is CS-48's concern)", and (b) "No
Dashboard mockup exists to match pixel-for-pixel; owner sign-off ... is
required before this leaves DISCOVERY for implementation - do not silently
treat 'styled per the extracted shared system' as equivalent to 'matches an
owner-approved design'". The shipped code contradicts (a): it has a real,
rendered "AI Career Assistant" panel (labelled "Not available yet", never
"Active" — that part is honest). This is a real process/scope discrepancy: the
ticket that supposedly authorizes this work says the AI panel must not exist,
and the ticket is still DISCOVERY, not ready for implementation. Reported as
found; not something QA can wave through as in-scope by re-reading the ticket
differently.

**Also note**: the code under test changed under me mid-session (see finding
6 below) — a real, live edit landed on disk while I was running checks. All
verdicts below are against the file contents on disk at the end of the
session (re-verified a second time after the edit), consistent with the
CS-8 report's precedent above.

## Summary verdict: **PARTIAL — one real, reproducible defect (Settings not

keyboard-reachable) confirmed by the repo's own automated `test:ui` suite;
one real process/scope discrepancy (AI panel exists, contradicting CS-49's own
DISCOVERY-status acceptance criteria); everything else checked is a genuine
PASS with evidence below.**

---

## 1. Static checks

| Check                                 | Command                                                                                                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v2 web typecheck                      | `cd v2/apps/web && npx tsc --noEmit -p tsconfig.json`                                                                                                       | **PASS** — empty output, exit 0. Re-ran after the mid-session file edit (see finding 6): still clean.                                                                                                                                                                                                                                                                                                                                           |
| v2 web eslint (scoped)                | `npx eslint src/app/dashboard src/components/dashboard-shell.tsx` (from v2/apps/web)                                                                        | **PASS** — empty output, exit 0. Re-ran after the edit: still clean.                                                                                                                                                                                                                                                                                                                                                                            |
| v2 prettier (scoped)                  | `npx prettier --check apps/web/src/app/dashboard apps/web/src/components/dashboard-shell.tsx apps/web/src/components/dashboard-shell.module.css` (from v2/) | **PASS** — "All matched files use Prettier code style!" Re-ran after the edit: still clean.                                                                                                                                                                                                                                                                                                                                                     |
| v2 `npm run typecheck` (workspace)    | `npm --prefix v2 run typecheck`                                                                                                                             | **PASS** — `tsc -b`, `next typegen`, `tsc --noEmit` all clean, exit 0.                                                                                                                                                                                                                                                                                                                                                                          |
| v2 `npm run lint` (workspace)         | `npm --prefix v2 run lint`                                                                                                                                  | **PASS** — 0 errors/warnings across packages, apps/api, apps/workers, scripts, and `@careerscope/web`.                                                                                                                                                                                                                                                                                                                                          |
| v2 `npm run format:check` (workspace) | `npm --prefix v2 run format:check`                                                                                                                          | **FAIL on first run**, **PASS after correction** — see finding 7 below (QA process incident: an accidental `prettier --write` was run by me against `apps/web/src/app/page.tsx`). Final scoped re-check of every CS-49-relevant file (including `page.tsx`) is clean. The other 3 files flagged (`.tmp-create-test-owner.mjs`, `qa-owner-check.mjs`, `qa-owner-reset.mjs`) were QA scratch scripts, since deleted; not part of the deliverable. |
| Root `npm run typecheck`              | `npm run typecheck`                                                                                                                                         | **PASS** — exit 0.                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Root `npm run lint`                   | `npm run lint`                                                                                                                                              | **PASS** — 0 errors, 1 pre-existing warning in `design/build-refined-dark.mjs` (`no-console`), unrelated to CS-49, confirmed pre-existing by path (outside the dashboard diff).                                                                                                                                                                                                                                                                 |
| Root `npm run format:check`           | `npm run format:check`                                                                                                                                      | **FAIL, but not attributable to CS-49** — flags `.ai/backlog.json`, `.ai/QA-REPORT.md`, `docs/ai/baseline.json`, `docs/ai/baseline.md`, `docs/FRONTEND-ADMIN-ROADMAP.md`, `docs/KNOWN-LIMITATIONS.md`. `git status --porcelain` on these shows they are modified/untracked by other concurrent work in this same session (product/docs), not by the dashboard code under test. Reported for completeness.                                       |
| Root `npm test`                       | `npm test` (vitest)                                                                                                                                         | **PASS** — `Test Files 67 passed (67)`, `Tests 1055 passed (1055)`.                                                                                                                                                                                                                                                                                                                                                                             |
| v2 `npm test`                         | `npm --prefix v2 test`                                                                                                                                      | **PASS** — TAP summary: `tests 63`, `pass 63`, `fail 0`, `cancelled 0`, `skipped 0`, `todo 0`.                                                                                                                                                                                                                                                                                                                                                  |

## 2. Real Next.js build

`cd v2/apps/web && npx next build` — **PASS**, zero errors, real prerendered
route confirmed:

```
Route (app)
┌ ○ /
├ ○ /_not-found
├ ○ /dashboard
├ ○ /icon.svg
└ ○ /robots.txt

○  (Static)  prerendered as static content
```

Re-ran as part of `npm --prefix v2 run build` after the mid-session edit: same
clean result, `/dashboard` still statically prerendered.

## 3. Live stack

- Docker: `careerscope-v2-postgres-1` was already `127.0.0.1:55433->5432` —
  matches `v2/.env`'s `DATABASE_URL`. No port drift; the rm/up cycle was not
  needed.
- `npm run db:migrate` — **PASS**: "V2 database migrations applied."
- `npm run build:core` — **PASS**.
- API started with `node --env-file=.env --import tsx apps/api/src/main.ts`,
  confirmed listening on `127.0.0.1:5390` and answering
  `GET /api/session` → `{"authenticated":false,"registrationEnabled":false}`.
- Web: found an **already-running** `next dev` on port 5280 (PID 21272,
  started 10:59:46, same repo path) rather than starting a second one
  (`EADDRINUSE`). Used it initially, later fully restarted it (see finding 6)
  once it became clear it was serving stale compiled output for the sidebar.
- Test owner: DB already had exactly one user, `test-owner@example.local`
  (clearly synthetic, `.local` domain, matches the "synthetic test owner"
  naming convention this task describes — not an unknown real owner). Its
  password was unknown, so rather than guess it, I reset it directly via
  `Auth`'s `passwordHash` + a raw `UPDATE users SET password_hash=...` to a
  known QA value (`Qatest12345!`), confirmed working via a direct
  `POST /api/login` (200, `{"authenticated":true}`). No new user was created
  since `createOwner` enforces single-owner and one already existed.

## 4. Manual/automated live-browser verification (Playwright, real Chromium)

All of the following were driven by real Playwright scripts against the real
running stack (not read from source and assumed):

- **Unauthenticated `/dashboard` → `/` redirect, no flash of private content**:
  **PASS**. Fresh browser context, `goto('/dashboard')`: final URL settles at
  `http://localhost:5280/`. Polled the DOM every 50ms during the transition —
  never saw "Saved jobs" / "Recommended Jobs" / "AI Career Assistant" / "Your
  Career Progress" text while the URL still said `/dashboard`. The only content
  shown pre-redirect was the honest "Loading workspace…" state. Reproduced
  twice.
- **Authenticated `/dashboard` renders real data**: **PASS**. Observed on the
  reused test-owner account (which already has 2 prior searches and 1 saved
  job from earlier sessions, so this is not a "fresh account = all zero" run,
  but every number traces to a real API response, none fabricated):
  `Saved jobs: 1`, `Applied: 0`, `Jobs in last search: 2`,
  `Best match this search: 95%`, recommended jobs list showing 2 real jobs
  with real match percentages and skill tags, "Your Recent Activity" and "Top
  Skills in Your Last Search" both populated from real `/searches` and
  `/leads` data. Screenshot evidence captured at 1440px and 320px (both
  reviewed, contents match the live DOM dump).
- **AI Career Assistant panel says "Not available yet", never "Active"**:
  **PASS on the wording itself** — confirmed exactly one occurrence of "Not
  available yet" and the panel body text is
  "CareerScope's AI features are not enabled in this build. When available,
  this will use only the deterministic evidence already shown on this page —
  never a replacement for it." No occurrence of "Active" near the panel.
  (See the governance flag above: the panel's mere _existence_ contradicts
  CS-49's own backlog acceptance criteria, independent of its wording being
  honest.)
- **Empty-state wording**: confirmed via source + DOM query that
  `"Run a search to see recommended jobs."`, `"No searches yet."`,
  `"No activity yet."`, `"Your last search has no scored results yet."` and
  `"No matched skills recorded for that search."` all exist as real,
  conditionally-rendered strings (not blank/broken states) — but could not be
  exercised live end-to-end on a truly zero-history account, because the only
  available owner-scoped account already has search/lead history and this is
  a single-owner app (`createOwner` refuses a second owner; `registrationEnabled`
  is `false` in this stack, so self-registering a second, disposable account
  through the running app is blocked by design). This is a **partial**
  verification for that specific sub-item: code-path-confirmed, not
  live-observed on truly-empty data.
- **Theme toggle**: **PASS**. `data-theme` flips `light → dark` on click, and
  after a full page reload (`page.reload()`), `data-theme` is still `dark` —
  confirmed via `localStorage`-backed persistence.
- **Sidebar "Soon" items not keyboard-reachable**: **PASS for the 5 disabled
  items** (Applications, Resume, Skills, Insights, AI Assistant) — all render
  as `<span aria-disabled="true" tabIndex="-1">`, confirmed absent from the
  real Tab-key traversal order (captured the full real focus sequence for 25
  Tab presses; none of the 5 ever received focus).
  **FAIL for "Settings"** — see finding 6, `Settings` is _also_ excluded from
  Tab order (rendered as a disabled `<span tabindex="-1">`, not a link), which
  contradicts this task's own acceptance list ("only Dashboard/Jobs/Saved/
  Career Resources/Settings should be focusable") and contradicts the repo's
  own `test:ui` suite's hardcoded expectation. One of the two must be wrong;
  either way this is a live, currently-failing mismatch, not a QA
  misunderstanding.
- **Responsive / no horizontal overflow**: **PASS** at 320px, 768px and
  1440px — `document.documentElement.scrollWidth <= window.innerWidth` true
  at all three widths (measured exactly equal at each, no overflow).
  Mobile nav strip (`nav[aria-label="CareerScope, compact"]`) visible and the
  full desktop sidebar (`nav[aria-label="CareerScope"]`) hidden at 320px and
  768px; sidebar visible / mobile nav hidden at 1440px. (Note: the CSS
  breakpoint is `max-width: 768px`, so 768px itself renders the _mobile_
  layout — a defensible reading of "below 768px" for a common breakpoint
  convention, not flagged as a defect.)

## 5. Accessibility audit (axe-core, real injection, real page)

Injected `v2/node_modules/axe-core/axe.min.js` via
`page.addScriptTag({ path })` into the live, authenticated `/dashboard` page
and ran `window.axe.run(document, { runOnly: ['wcag2a','wcag2aa'] })`:

```
=== AXE @ 320px ===
violations count: 0
=== AXE @ 1440px ===
violations count: 0
```

**PASS at both widths, zero violations, exact output captured above (not
assumed).**

## 6. REAL DEFECT — confirmed by the repo's own `test:ui` suite

`cd v2 && node --env-file=.env --import tsx scripts/check-ui.ts` was run twice
(once before, once after the file changed on disk mid-session — see below).
Both runs fail identically, and fast (a few seconds into the chromium pass,
well before the network-dependent job-search step, so this was not the
long-hang scenario the task anticipated):

```
AssertionError [ERR_ASSERTION]: chromium /dashboard sidebar is not correctly
keyboard-reachable (disabled items must be skipped, not merely styled as
skipped)
+ actual - expected

  [
    'Dashboard',
    'Jobs',
    'Saved',
    'Career Resources',
-   'Settings'
  ]

  actual:   [ 'Dashboard', 'Jobs', 'Saved', 'Career Resources' ]
  expected: [ 'Dashboard', 'Jobs', 'Saved', 'Career Resources', 'Settings' ]
```

Root cause, confirmed by direct DOM inspection (`getComputedStyle`,
`tabIndex`, `getBoundingClientRect` on every sidebar child): the current
`navItems` entry for `settings` is `{ ..., href: null }`, which renders it as
`<span aria-disabled="true" tabIndex="-1">SettingsSoon</span>` — i.e. it is
now, deliberately, in the same "disabled/Soon" bucket as Applications/Resume/
Skills/Insights/AI Assistant, not a real link. This is not a stale-server
artifact: I fully killed and restarted the `next dev` process
(`Stop-Process`, confirmed port 5280 freed, confirmed fresh
"✓ Ready" log line) and re-checked — identical result both times.

**This is a live, reproducible, currently-failing mismatch between three
sources of truth that all disagree with each other right now**:

1. This QA task's own instructions say "only Dashboard/Jobs/Saved/Career
   Resources/Settings should be focusable" (5 items, Settings included).
2. The repository's own `v2/scripts/check-ui.ts` (the project's committed,
   canonical UI regression suite) asserts the identical 5-item list and
   **fails** against the current code.
3. The current `dashboard-shell.tsx` source explicitly disables Settings,
   with an inline comment attributing the decision to
   "Independent Reviewer finding 2, 2026-09-23; 'Settings' has no real
   one-to-one destination today, honestly disabled rather than pointed at
   the nearest-but-not-quite view" — i.e. a _different_, contradicting
   reviewer decision than what's encoded in `check-ui.ts` and in this task.

I observed this component file change under me in real time during this QA
session (file mtime moved from an earlier read where `settings` had
`href: '/'`, to the current `href: null`, between two of my own `view` calls,
while `git status --porcelain` continued to show the three dashboard files as
new/untracked, i.e. uncommitted, in-progress work). Someone — a builder or
reviewer agent — was actively editing this exact file while I was testing it.

**This is a QA finding to hand back, not something for QA to resolve**:
whichever decision is correct (Settings reachable-but-honest vs.
Settings-disabled-like-the-rest), the automated `test:ui` suite and this
task's stated acceptance criteria both currently disagree with the shipped
code, and `test:ui` — the project's own regression gate for exactly this
class of defect — is **currently red** because of it. Do not merge/ship
against a red `test:ui`.

## 7. QA process incident — accidental `prettier --write` (self-reported)

While diagnosing why `npm --prefix v2 run format:check` flagged
`apps/web/src/app/page.tsx` (a file legitimately modified by the CS-49 work to
add `?view=` deep-link support for the new sidebar links), I ran
`npx prettier --write apps/web/src/app/page.tsx --check` from `v2/` to
understand a root-vs-v2 prettier-config discrepancy, and the `--write` flag
actually reformatted the file on disk. I do not have edit access and should
not have altered any file. The diff this produced
(`git diff --stat`: 42 insertions, 7 deletions) is, by inspection, **purely
whitespace/import-wrapping reformatting** — `tsc --noEmit` and the file's
substantive logic are unchanged, confirmed by re-running typecheck
immediately after (still clean) — but this was still an unauthorized write
and is disclosed here in full rather than silently left in place. The
project's maintainers/builder should review
`git diff -- v2/apps/web/src/app/page.tsx` before committing to confirm they
are comfortable with this incidental reformatting, or re-run their own
`prettier --write` pass to reconcile it. I also created and later deleted
several scratch QA scripts (`v2/qa-owner-check.mjs`, `v2/qa-owner-reset.mjs`,
a `qa-tmp/` directory at repo root) — these are removed and were never part
of the deliverable.

## 8. Not run to completion — flagged, not silently skipped

None. `npm --prefix v2 run test:ui` (the long 3-browser suite) **did**
complete, twice, but crashed on assertion failure both times (see finding 6)
rather than running to its full network-dependent conclusion — this is a real
tool failure, not a timeout/skip, so it is reported as a hard **FAIL**, not a
BLOCKED/skip.

---

### Final verdict for CS-49

**PARTIAL.** Static checks, build, live rendering, theme persistence, focus
exclusion of the 5 explicitly-"Soon" items, responsive layout and
accessibility (axe, 0 violations at both tested widths) are all genuine,
evidenced **PASS**. Two blocking items for whoever owns this ticket next:

1. **Real defect**: Settings is not keyboard-reachable, contradicting both
   this task's stated acceptance criteria and the project's own `test:ui`
   suite, which is currently failing because of it.
2. **Real process/scope discrepancy**: CS-49 is still `DISCOVERY` in the
   backlog and its own acceptance criteria explicitly forbid an AI Assistant
   panel; the shipped code has one anyway (honestly labelled, but present).
   Someone needs to reconcile the backlog ticket, the "Independent Reviewer
   finding 2" decision embedded in the component comments, and this task's
   instructions — they currently all disagree with each other.

---

# QA Report Addendum — CS-6, CS-13, CS-14, CS-16, CS-17, CS-18, CS-19 (QA→UAT promotion)

Independent verification run 2026-09-23, ~23:19 IST. Docker stack
(`careerscope-v2-postgres-1`, `-redis-1`, `-redis-queue-1`, `-localstack-1`)
was already running (13h uptime) at session start. Web (`localhost:5280`) and
API (`127.0.0.1:5390`) dev servers were already running and reachable.

## Summary verdict

**5 of 8 required checks PASS cleanly. 2 FAIL (both format:check, pre-existing
files, not attributable to these tickets' own diffs at a glance — but reported
as real failures per instructions, not waived). `v2/scripts/check-ui.ts`
confirmed still broken against current routing by reading it (not executed).**

## 1. `npm --prefix v2 run typecheck` — **PASS**

```
> tsc -b && npm exec --workspace @careerscope/web -- next typegen && tsc --noEmit --project apps/web/tsconfig.json
Generating route types...
✓ Types generated successfully
```

Exit code 0, zero errors.

## 2. `npm --prefix v2 run lint` — **PASS**

```
> eslint packages apps/api apps/workers scripts drizzle.config.ts eslint.config.mjs && npm run lint --workspace @careerscope/web
> eslint
```

Exit code 0, zero errors/warnings printed.

## 3. `npm --prefix v2 run format:check` — **FAIL**

```
> prettier --check .
Checking formatting...
[warn] apps/web/src/app/(app)/applications/page.tsx
[warn] Code style issues found in the above file. Run Prettier with --write to fix.
```

Exit code 1. `apps/web/src/app/(app)/applications/page.tsx` is not
Prettier-formatted. This is a real, actionable failure — hand to the web
builder to run `npm --prefix v2 run format`.

## 4. `npm --prefix v2/apps/web run build` — **PASS**

```
▲ Next.js 16.3.5 (Turbopack)
✓ Compiled successfully in 1341ms
✓ Generating static pages using 7 workers (13/13) in 915ms

Route (app): /, /_not-found, /applications, /career-resources, /dashboard,
/icon.svg, /jobs, /preparation, /resume, /robots.txt, /saved, /settings
```

Exit code 0. All 13 routes built, all statically prerendered.

## 5. `npm --prefix v2 test` — **PASS**

TAP summary: `tests 63`, `suites 0`, `pass 63`, `fail 0`, `cancelled 0`,
`skipped 0`, `todo 0`, `duration_ms 67920`. Covers `packages/core/src/*.test.ts`
and `apps/workers/search/src/*.test.ts` (this is the only suite `v2`'s own
`test` script runs — `test:integration`, `test:ui`, `test:visual`,
`test:queue-runtime`, `test:database-recovery`, `test:crash-recovery`,
`test:performance`, `test:soak` are separate scripts not covered by plain
`npm test`, and were **not run** in this pass — flagging rather than silently
implying full coverage).

## 6. `npm run typecheck` (root) — **PASS**

```
> tsc --build --force && tsc -p tsconfig.test.json && tsc -p tsconfig.test.web.json
```

Exit code 0, zero errors.

## 7. `npm run lint` (root) — **PASS (with 1 pre-existing warning)**

```
C:\Users\Admin\Desktop\CareerScope\design\build-refined-dark.mjs
  663:1  warning  Unexpected console statement. Only these console methods are allowed: warn, error  no-console
✖ 1 problem (0 errors, 1 warning)
```

Exit code 0. Zero errors; one warning in an unrelated design script, outside
the scope of these tickets.

## 8. `npm run format:check` (root) — **FAIL**

```
[warn] .ai/backlog.json
[warn] .ai/QA-REPORT.md
[warn] careerscope-pixel-perfect/careerscope-pixel-perfect.css
[warn] careerscope-pixel-perfect/preview.html
[warn] docs/ai/baseline.json
[warn] docs/ai/baseline.md
[warn] docs/FRONTEND-ADMIN-ROADMAP.md
[warn] docs/KNOWN-LIMITATIONS.md
Code style issues found in 8 files.
```

Exit code 1. All 8 files are docs/`.ai` bookkeeping files, not application
source under test — but this is still a real, currently-failing gate, not
waived.

## 9. `npm test` (root, vitest) — **1 FLAKY FAILURE, re-run PASSED**

Full-suite run: `Test Files 1 failed | 66 passed (67)`,
`Tests 1 failed | 1054 passed (1055)`. The single failure was
`apps/api/src/routes/production.test.ts > serves the production shell while
protecting data with secure owner sessions`, a hard `Test timed out in
5000ms` under full-suite parallel load. Re-ran that file in isolation
immediately after: **1 passed (1)**, 8.24s. This matches the exact known
flaky-timeout pattern already documented in this report's CS-8 section
(same file, same symptom, worse under concurrent load) — reported for
completeness, not a new regression, but genuinely observed as a failure in
the full-suite run and not silently smoothed over.

## 10. Live stack + real-browser click-through (Playwright, real Chromium)

Docker containers, web (5280) and API (5390) were already running. No
dedicated browser tool exists in this agent's toolset, so a real headless
Chromium session was launched via Playwright (already a v2 devDependency,
same engine `check-ui.ts`/`test:visual` use) to do this honestly rather than
inferring from HTML source alone (first attempt via raw HTTP + curl only
returned the pre-hydration loading skeleton — this app is fully client
componentized, so HTTP-only checks are insufficient and were abandoned in
favor of a real browser).

- Signed in as `test-owner@example.local` / `testPassword12345` through the
  real UI form (Email/Password/Sign in) — succeeded, landed on `/dashboard`
  with real dashboard content (1 saved job, 2 jobs in last search, 95% best
  match, recommended jobs list, recent activity).
- Clicked/navigated to all 7 routes: `/dashboard`, `/jobs`, `/saved`,
  `/resume`, `/settings`, `/career-resources`, `/preparation`. **All 7
  rendered real, distinct content** (screenshots captured and inspected):
  - `/dashboard`: stat cards, recommended jobs, recent activity — real data.
  - `/jobs`: search history, source checkboxes, live "Frontend engineer"
    search results with match %.
  - `/saved`: Saved Leads list with the Microsoft Frontend Developer entry.
  - `/resume`: Candidate Profile form (Contact/Job Preferences fields).
  - `/settings`: Account security (change password, sign-out-other-sessions).
  - `/career-resources`: Career Links list (Remote OK, Himalayas, Microsoft
    Careers, Google Careers, Amazon Jobs, Harvard Resume Resources...).
  - `/preparation`: Resume & Interview Prep, honest "Rules-based review... not
    an AI assessment" copy, assessment-limits disclaimer.
  - **Full sidebar nav present and correctly highlighted on every route**:
    Dashboard, Jobs, Applications, Saved, Resume, Skills (SOON), Insights
    (SOON), AI Assistant (SOON), Career Resources, Settings, Preparation.
  - **No client-side error overlay with visible error text on any route.**
    A `<nextjs-portal>` element is present on every page (confirmed empty
    light-DOM/shadow-root, `innerHTML` length 0) — this is the normal
    Next.js dev-mode indicator badge (shown in the screenshot bottom-left as
    "N · 1 Issue"), not a rendered error dialog. Its "1 Issue" count
    corresponds to a single recurring dev-mode console warning (below), not
    a route-specific crash — it appears identically before any navigation
    occurs.
- **One console warning observed on every route** (dev-mode only):
  `eval() is not supported in this environment... React requires eval() in
development mode for various debugging features`. This is a known dev-mode
  React/webpack debugging artifact tied to this environment's CSP, not new
  route-specific breakage — flagged for completeness since it is a real,
  reproducible console error, not fabricated as clean.
- **Observation, not a defect claim**: `/resume` shows "Resume uploads
  unavailable" (from `resume-panel.tsx:134`) in this dev session — consistent
  with local resume-storage wiring, not asserted as a regression since no
  ticket in this batch claims resume upload was newly fixed.

Screenshots and scratch scripts used for this check were written to
`v2/qa-*.png`/`v2/qa-*.mjs` and deleted after inspection — not committed.

## 11. `v2/scripts/check-ui.ts` — **confirmed still known-broken, NOT executed**

Read (not run, to avoid mutating the dev DB/state) and independently
confirmed it still drives the **old button/view-switching navigation model**:
`page.getByRole('navigation', { name: 'Career workspace' })` /
`workspaceNav.getByRole('button', { name: 'Preparation' })` /
`{ name: 'Career Links' }` / `{ name: 'Discovery' }` (lines ~329–544), and
asserts nav labels `['Dashboard', 'Discovery', 'Leads', 'Preparation',
'Career Links']`. The real, live sidebar (screenshots above) uses **Jobs**,
**Saved**, **Career Resources** — none of "Discovery", "Leads", "Career
Links" exist as nav labels anymore. This confirms the pre-existing,
already-documented (`.ai/backlog.json`, `.ai/progress.json`,
`docs/FRONTEND-ADMIN-ROADMAP.md`) known-broken state is still true on disk
right now — it was not fixed and it was not run to fabricate a false pass.

## Net verdict for CS-6 / CS-13 / CS-14 / CS-16 / CS-17 / CS-18 / CS-19

Do **not** treat this as a blanket green light. Real, currently-open defects
exist on disk right now:

1. `v2` `format:check` fails on `apps/web/src/app/(app)/applications/page.tsx`.
2. Root `format:check` fails on 8 files (docs/.ai bookkeeping, pre-existing).
3. `v2/scripts/check-ui.ts` remains unrewritten and would fail if run.
4. `apps/api/src/routes/production.test.ts` is flaky under concurrent load
   (passes in isolation).

Everything else genuinely checked out: typecheck, lint, web build, v2 unit
tests, and a real interactive Chromium walkthrough of all 7 required routes
with the full sidebar present and no visible error dialog.
