# Engineering Baseline

Baseline `OS-BASELINE-20260919` was captured by a real **CareerScope QA**
subagent before the expanded OS contract implementation. Machine-readable
results: [baseline.json](baseline.json). The tree was already dirty (62 entries),
so this does not qualify a clean commit or production deployment.

## Results

Root typecheck, lint and build passed. Root tests passed: 1,047 tests in 67
files. Control-plane and hook tests passed: 131. Agent validation passed 53
checks; 20 skills were valid. Lint reported one existing no-console warning.

Existing failures: customization validation lacked current review metadata;
the initial audit document failed formatting. Strict engineering verification
correctly refused the unfinished objective. Do not reinterpret that refusal as
a successful completion check.

V2 integration and browser checks were not run: the known launcher consumes
private runtime configuration and persistent storage. Production provenance,
security review and dependency advisories were not established by this run.

## Reproduction

Use Node >=24. On this Windows workspace QA used the existing pinned Node
26.8.1 and npm 11.19.0 under `data/windows-toolchain/node_modules`, with their
Node and `.bin` directories first in the child process PATH. Default Node
22.23.2 does not satisfy the project requirement. No toolchain was installed.

```sh
node --test scripts/engineering.test.mjs scripts/engineering-hook.test.mjs
node scripts/check-agents.mjs
node scripts/check-customizations.mjs
node scripts/check-skills.mjs
node scripts/engineering.mjs check
node scripts/engineering.mjs verify
npm run typecheck
npm run lint
npm run build
npm run format:check
```

The plain test command may load a real `.env` through Vite. QA ran the same
suite through this API with isolated configuration/cache directories instead:

```js
import { startVitest } from 'vitest/node';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const isolated = join(tmpdir(), 'careerscope-os-baseline-' + randomUUID());
const runner = await startVitest(
  'test',
  [],
  { run: true, watch: false },
  { envDir: join(isolated, 'no-env'), cacheDir: join(isolated, 'cache') },
);
await runner?.close();
```

One initial build invocation had an incorrect nested npm PATH; correcting the
invocation passed without source changes. This is an execution error, not an
application regression. The build refreshed existing ignored output metadata;
Git status and 191 inspected engineering-file fingerprints remained unchanged.

## Comparison Rules

Preserve this baseline. Record post-change results separately with commands,
exit codes, revision and scoped content digest. A failure is BASELINE_EXISTING
only when this baseline demonstrates the same signature. Otherwise record
REGRESSION_INTRODUCED or UNKNOWN pending diagnosis; never infer unrelatedness.
The introducing task owns a regression until evidence disproves attribution.
Rerunning a passing command does not resolve an unexecuted integration gate.
