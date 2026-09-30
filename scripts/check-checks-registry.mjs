// CS-52: no executable check may sit in this repository unclassified.
//
// The systemic defect was not that a particular check failed to run. It was
// that the repository contained a large set of `check-*` scripts and nobody
// could say, per script, whether it ran in CI, needed a live host, or was a
// developer tool — so their mere existence was repeatedly read as evidence.
// A forensic audit had to mark crash recovery, database recovery, queue
// runtime behaviour and disk exhaustion NOT VERIFIED, not because the checks
// were missing but because nothing executed them.
//
// This is the structural fix. `scripts/checks-registry.json` must classify
// every discovered check, and each classification is verified against what the
// workflows actually do:
//
//   ci            runs on every push and pull request. Must be reachable from a
//                 push/pull_request-triggered workflow.
//   deploy        runs during deployment against the live host, over ssh. Must
//                 be reachable from the deploy workflow — it proves the deployed
//                 origin, not the commit, so it is not CI coverage.
//   on-demand     runs in CI infrastructure, but only when dispatched or
//                 scheduled. Must be reachable, and only from a workflow that
//                 is not push/pull_request triggered.
//   operator-only requires a live deployed host. Must be reachable from NO
//                 workflow — its existence is explicitly NOT evidence that
//                 anything has been verified.
//   manual        a developer tool: needs arguments, a local baseline, or
//                 hardware CI does not have. Must be reachable from NO
//                 workflow.
//
// The two negative classifications are checked as strictly as the positive
// ones. A check quietly wired into CI while still recorded as operator-only
// would make the registry lie in the safe-looking direction, which is exactly
// the failure mode this file exists to prevent.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { reachableCommands, walk, workflowsExecuting } from './ci-reachability.mjs';

// stdout/stderr directly: this repository's lint forbids console.log, and a
// check whose entire output is a report has to reach stdout anyway.
const write = (message) => process.stdout.write(`${message}\n`);
const warn = (message) => process.stderr.write(`${message}\n`);

const rootArgument = process.argv.find((argument) => argument.startsWith('--root='));
const root = rootArgument
  ? rootArgument.slice('--root='.length)
  : fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const report = process.argv.includes('--report');

const CLASSIFICATIONS = new Set(['ci', 'deploy', 'on-demand', 'operator-only', 'manual']);
const searched = ['scripts', 'scripts', 'infra'];
const isCheck = (entry) =>
  /^(?:check|benchmark|visual)-[\w.-]+\.(?:ts|mjs|sh)$/.test(entry) && !entry.includes('.test.');

const present = searched.flatMap((directory) => walk(join(root, directory), isCheck, root)).sort();

// "Found nothing" is never an answer here. Under-discovery would silently empty
// the registry's obligations and report success.
assert.ok(
  present.length > 15,
  `Discovered only ${present.length} executable check(s) under ${searched.join(', ')}, ` +
    'which means this check could not look rather than that the repository has none',
);

const resolution = reachableCommands(root);
const executedBy = new Map(present.map((file) => [file, workflowsExecuting(file, resolution)]));

if (report) {
  const draft = present.map((path) => {
    const workflows = executedBy.get(path);
    const automatic = workflows.some((workflow) => {
      const trigger = resolution.triggers.get(workflow);
      return trigger.push || trigger.pullRequest;
    });
    return {
      path,
      classification: workflows.length === 0 ? 'UNCLASSIFIED' : automatic ? 'ci' : 'on-demand',
      workflows,
    };
  });
  write(JSON.stringify(draft, null, 2));
  process.exit(0);
}

const registryPath = join(root, 'scripts', 'checks-registry.json');
// An unreadable or unparseable registry is a hard failure. Treating it as an
// empty list would turn "we cannot tell" into "nothing to report" — the precise
// substitution that once produced "no open P0 or P1" from a corrupt file.
const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
assert.ok(Array.isArray(registry.checks), `${registryPath} has no "checks" array`);
assert.ok(
  registry.checks.length > 15,
  `${registryPath} lists only ${registry.checks.length} check(s), which cannot be the whole repository`,
);

const entries = new Map();
const problems = [];
for (const entry of registry.checks) {
  assert.ok(
    typeof entry?.path === 'string' && entry.path.length > 0,
    'A registry entry has no path',
  );
  assert.ok(
    CLASSIFICATIONS.has(entry.classification),
    `${entry.path}: classification "${entry.classification}" is not one of ${[...CLASSIFICATIONS].join(', ')}`,
  );
  assert.ok(
    typeof entry.reason === 'string' && entry.reason.trim().length >= 20,
    `${entry.path}: needs a substantive reason, not "${entry.reason ?? ''}"`,
  );
  assert.ok(!entries.has(entry.path), `${entry.path} is listed twice`);
  entries.set(entry.path, entry);
}

for (const path of present) {
  if (!entries.has(path)) {
    problems.push(
      `${path}: UNCLASSIFIED. Add it to scripts/checks-registry.json as ci, on-demand, ` +
        'operator-only or manual, with a reason. An unclassified check is one whose existence ' +
        'will eventually be mistaken for evidence (CS-52).',
    );
  }
}

for (const [path, entry] of entries) {
  if (!present.includes(path)) {
    problems.push(
      `${path}: listed in the registry but no such file exists. Remove the stale entry.`,
    );
    continue;
  }
  const workflows = executedBy.get(path) ?? [];
  // deploy.yml is push-triggered too, but what it runs happens on the live host
  // after shipping. Counting it as CI coverage would let a check that only ever
  // touches production masquerade as a check on the commit.
  const automatic = workflows.filter((workflow) => {
    if (workflow === 'deploy.yml') return false;
    const trigger = resolution.triggers.get(workflow);
    return trigger.push || trigger.pullRequest;
  });

  if (entry.classification === 'ci' && automatic.length === 0) {
    problems.push(
      `${path}: classified "ci" but no push or pull_request workflow executes it` +
        (workflows.length > 0 ? ` (only ${workflows.join(', ')}, which is not automatic).` : '.'),
    );
  }
  if (entry.classification === 'deploy' && !workflows.includes('deploy.yml')) {
    problems.push(
      `${path}: classified "deploy" but deploy.yml does not execute it` +
        (workflows.length > 0 ? ` (only ${workflows.join(', ')}).` : '.'),
    );
  }
  if (entry.classification === 'on-demand') {
    if (workflows.length === 0) {
      problems.push(`${path}: classified "on-demand" but no workflow executes it at all.`);
    } else if (automatic.length > 0) {
      problems.push(
        `${path}: classified "on-demand" but ${automatic.join(', ')} runs it on every push or pull request. ` +
          'Reclassify it "ci" so the registry stops understating the coverage.',
      );
    }
  }
  if (
    (entry.classification === 'operator-only' || entry.classification === 'manual') &&
    workflows.length > 0
  ) {
    problems.push(
      `${path}: classified "${entry.classification}" — which asserts its existence is NOT evidence — ` +
        `but ${workflows.join(', ')} actually executes it. The registry is understating real coverage; fix the classification.`,
    );
  }
}

if (problems.length > 0) {
  warn(`\n${problems.length} classification problem(s):\n`);
  for (const problem of problems) warn(`  - ${problem}`);
  warn('');
}
assert.equal(
  problems.length,
  0,
  `${problems.length} executable check(s) are misclassified or unclassified`,
);

const counts = {};
for (const entry of entries.values())
  counts[entry.classification] = (counts[entry.classification] ?? 0) + 1;
write(
  `PASS  all ${present.length} executable checks are classified and each classification matches what the workflows do\n` +
    Object.entries(counts)
      .sort()
      .map(([name, count]) => `      ${name}: ${count}`)
      .join('\n'),
);
