// CS-68: the same guarantee `v2/scripts/check-test-registration.ts` gives the
// V2 workspace, for the root workspace's own test files.
//
// The V2 guard globs `v2/**` only, so root `scripts/` and `infra/` were
// unguarded — and two files were already silently unrun:
// `scripts/engineering-runner.test.mjs` (twenty cases covering the test runner
// and its TAP parser, including the malformed-totals cases that stop a runner
// reporting success it cannot substantiate) and
// `scripts/setup-admin-secret.test.mjs` (the encrypted admin's secret
// generation and its refusal to overwrite). Neither was named by any npm
// script or any workflow step.
//
// The bar here is deliberately higher than the V2 guard's. Being named by an
// npm script is not enough, because an npm script no workflow invokes is
// exactly the shape of the original defect: the safety net existing and being
// unreachable. A file counts as registered only when some workflow actually
// reaches it — directly, or through a chain of npm scripts.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';
import { reachableCommands, walk, workflowsExecuting } from './ci-reachability.mjs';

// stdout/stderr directly: this repository's lint forbids console.log, and a
// check whose entire output is a report has to reach stdout anyway.
const write = (message) => process.stdout.write(`${message}\n`);
const warn = (message) => process.stderr.write(`${message}\n`);

const root = process.argv[2]
  ? process.argv[2]
  : fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

/**
 * Every top-level directory is either scanned by this guard or explicitly
 * excluded with a reason, and the reason is VERIFIED rather than asserted.
 *
 * The directory list used to be three hand-written names, and a hand-maintained
 * list that describes the repository is the defect class this codebase keeps
 * hitting: `.gitattributes` vs `LF_ONLY`, `KNOWN_SEVERITIES` vs four literal
 * cells, `test:unit` vs the files that exist. Each diverged from the thing it
 * was supposed to describe, and each was found by a person rather than a check.
 * So the population comes from `git ls-files` and an unclassified directory
 * fails here.
 *
 *   scanned    walked for test files, which must then be executed by a workflow
 *   own-guard  has its own registration guard, with its own rules
 *   vitest     covered by the project globs in vitest.config.ts, which `npm test` runs
 *   no-tests   claims to contain no test files — and that claim is checked
 */
const SCANNED = ['scripts', 'infra', 'mobile-site'];

const EXCLUDED = {
  v2: {
    kind: 'own-guard',
    reason:
      'v2/scripts/check-test-registration.ts guards it, to a higher bar. Two guards over one tree would make one of them the stale one.',
  },
  apps: {
    kind: 'vitest',
    reason:
      "vitest.config.ts's node and web projects glob these, and `npm test` runs them; the paths are never named individually, so reachability cannot be answered by naming.",
  },
  packages: {
    kind: 'vitest',
    reason: "Same as apps: covered by vitest.config.ts's `packages/*/src/**/*.test.ts` glob.",
  },
  '.ai': { kind: 'no-tests', reason: 'Recorded engineering state, not code.' },
  '.github': { kind: 'no-tests', reason: 'Workflows, agents, prompts and instructions.' },
  '.vscode': { kind: 'no-tests', reason: 'Editor configuration.' },
  'START-HERE': { kind: 'no-tests', reason: 'Onboarding documents.' },
  design: { kind: 'no-tests', reason: 'Design references and one-off build scripts.' },
  docs: { kind: 'no-tests', reason: 'Documentation.' },
  seed: { kind: 'no-tests', reason: 'Seed data.' },
};

// `data/` is deliberately NOT here, and not scanned. It is gitignored in full
// (.gitignore: `data/`) and holds the owner's resumes, imports, recovery
// material and the SQLite database. Two consequences follow, and the second is
// the one that matters:
//
//   1. Nothing under it can be committed, so no workflow can ever execute a
//      test placed there. Scanning it would make this guard permanently red
//      with no honest way to go green.
//   2. Therefore a test written under `data/` is invisible coverage BY
//      CONSTRUCTION — exactly the defect CS-52 exists to prevent. A module that
//      needs a test needs to live somewhere tracked first.
//
// The claim is verified below rather than trusted: if `data/` ever stops being
// ignored, this guard says so instead of silently beginning to scan the owner's
// private files.
const IGNORED_BY_DESIGN = {
  data: 'Gitignored in full; holds owner resumes, imports and the database.',
};

function topLevelTrackedDirectories() {
  const listed = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
  assert.ok(
    listed.length > 100,
    `git listed only ${listed.length} tracked file(s), which cannot be this repository`,
  );
  const directories = new Set();
  for (const file of listed) {
    const slash = file.indexOf('/');
    if (slash > 0) directories.add(file.slice(0, slash));
  }
  return [...directories].sort();
}

const coverageProblems = [];
for (const directory of topLevelTrackedDirectories()) {
  if (SCANNED.includes(directory) || EXCLUDED[directory]) continue;
  coverageProblems.push(
    `${directory}/ is neither scanned for test files nor explicitly excluded. A test placed there ` +
      'would be invisible to every registration guard, which is the defect CS-52 exists to prevent.',
  );
}
for (const directory of [...SCANNED, ...Object.keys(EXCLUDED)]) {
  if (!topLevelTrackedDirectories().includes(directory)) {
    coverageProblems.push(
      `${directory}/ is classified but no longer exists. Remove the stale entry.`,
    );
  }
}
// A "no tests here" exclusion is a claim about the filesystem, so check it.
for (const [directory, { kind }] of Object.entries(EXCLUDED)) {
  if (kind !== 'no-tests') continue;
  const found = walk(
    join(root, directory),
    (entry) => /\.test\.(mjs|js|ts|tsx)$/.test(entry),
    root,
  );
  if (found.length > 0) {
    coverageProblems.push(
      `${directory}/ is excluded on the grounds that it holds no test files, but it now holds ` +
        `${found.length}: ${found.join(', ')}. Scan it or move them.`,
    );
  }
}
for (const [directory, reason] of Object.entries(IGNORED_BY_DESIGN)) {
  const ignored = spawnSync('git', ['check-ignore', '-q', `${directory}/`], { cwd: root });
  if (ignored.status !== 0) {
    coverageProblems.push(
      `${directory}/ is recorded as ignored by design (${reason}) but git no longer ignores it. ` +
        'Either it must be classified above, or the ignore rule has been lost.',
    );
  }
}

if (coverageProblems.length > 0) {
  warn(`\n${coverageProblems.length} directory-coverage problem(s):\n`);
  for (const problem of coverageProblems) warn(`  - ${problem}`);
  warn('');
}
assert.equal(
  coverageProblems.length,
  0,
  `${coverageProblems.length} directory/directories are unguarded`,
);

const present = SCANNED.flatMap((directory) =>
  walk(join(root, directory), (entry) => /\.test\.(mjs|js|ts)$/.test(entry), root),
);

// A run that finds almost no test files has failed to look, and must never be
// mistaken for "nothing to report". Six checks in this repository once passed
// while unable to look; this assertion is the difference.
assert.ok(
  present.length > 10,
  `Found only ${present.length} root-workspace test file(s) under ${SCANNED.join(', ')}, ` +
    'which means this check could not look rather than that everything is registered',
);

const resolution = reachableCommands(root);

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const scripts = manifest.scripts ?? {};
assert.ok(
  Object.keys(scripts).length > 10,
  'The root package.json exposes almost no scripts, so this check cannot have read it correctly',
);

// Every test path named anywhere — by a root npm script or by a workflow step —
// must exist. A script naming a deleted file fails at run time with a confusing
// error, or worse, is quietly tolerated by a glob.
const named = new Set();
for (const body of Object.values(scripts)) {
  // The negative lookahead keeps `tsconfig.test.json` from reading as a test
  // file called `tsconfig.test.js`.
  for (const match of String(body).matchAll(/[\w./-]+\.test\.(?:mjs|js|ts)(?![\w])/g))
    named.add(match[0]);
}
for (const steps of resolution.perWorkflow.values()) {
  for (const { directory, text } of steps) {
    if (directory !== '.') continue;
    for (const match of text.matchAll(/[\w./-]+\.test\.(?:mjs|js|ts)(?![\w])/g))
      named.add(match[0]);
  }
}

const missing = [...named].filter(
  (path) => !path.startsWith('v2/') && !path.includes('fixture') && !present.includes(path),
);

const unreachable = present.filter((file) => workflowsExecuting(file, resolution).length === 0);

if (missing.length > 0) {
  warn(
    `\n${missing.length} test file(s) are named by a script or workflow but do not exist:\n` +
      missing.map((file) => `  - ${file}`).join('\n'),
  );
}

if (unreachable.length > 0) {
  warn(
    `\n${unreachable.length} root-workspace test file(s) are executed by NO workflow, so they run nowhere:\n` +
      unreachable.map((file) => `  - ${file}`).join('\n') +
      '\n\nAdd each to an npm script that a workflow already runs (pages:test, engineering:test,\n' +
      'gates:test), or give it its own workflow step. Adding it to a script no workflow invokes\n' +
      'does NOT count — that is the defect this check exists to catch (CS-52, CS-68).\n',
  );
}

assert.equal(
  unreachable.length + missing.length,
  0,
  `${unreachable.length} unreachable and ${missing.length} missing root-workspace test file(s)`,
);

write(
  `PASS  all ${present.length} root-workspace test files are executed by a workflow ` +
    `(${resolution.workflowFiles.join(', ')})`,
);
