import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error - a plain .mjs check helper shared with the root workspace,
// which has no type declarations and deliberately none: it is a script, not a
// published module. The alternative is a second copy of the resolver, and two
// copies of "what does CI actually run" is exactly what F-52-1 was about.
import { reachableCommands, workflowsExecuting } from './ci-reachability.mjs';

/**
 * CS-52 structural half: a test file must not be able to become invisible.
 *
 * The instance defect was `ai-provider.test.ts` — CareerScope's only outbound
 * third-party integration, with a twelve-case matrix covering
 * key-never-logged, bounded reads, and fail-closed catalog checks — running in
 * NO workflow at all. The same shape had already been caught once as CS28-1
 * (`backfill-job-sightings.test.ts`), and once before that as R3 (a self-check
 * that tested for `--allow-net`, a Deno flag Node does not have, so it was
 * unconditionally true).
 *
 * Three occurrences of one defect class is not three mistakes, it is a
 * structural problem, and the structure is this: **CI names test files
 * individually.** `npm run test:unit` and `test:integration`
 * enumerate paths. A file named by neither runs nowhere. The `test` script
 * globs and would have caught it — but no workflow invokes `test`, so the
 * safety net exists and is unreachable.
 *
 * Fixing the instance (adding the file to a script) fixes one file. This fixes
 * the class: every `*.test.ts` in the canonical workspace must be claimed by at least one npm
 * script, and an unclaimed file fails loudly here instead of silently passing
 * everywhere.
 *
 * Deliberately NOT solved by pointing CI at the `test` glob. Six of these files
 * need PostgreSQL, Redis and LocalStack; running the glob in the no-services
 * job would fail, and running it only in the services job would make the fast
 * feedback loop slow. The scripts are enumerated for real reasons. This check
 * makes the enumeration honest rather than removing it.
 *
 * F-52-1: the bar used to be "named by some npm script", which is weaker than
 * CS-52's own statement of the problem — *coverage that exists but never
 * executes*. A script nobody invokes is the original defect exactly: the safety
 * net existing and being unreachable. So the bar is now the same one the root
 * guard uses, and from the same module: a test file counts as registered only
 * when a workflow actually reaches it, directly or through a chain of npm
 * scripts. Two guards on one defect class had two different bars; there is now
 * one bar, in one place.
 */

const repository = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
// Reachability is answered from the repository root, because that is where the
// workflows live and how they name paths.
const root = repository;
const resolution = reachableCommands(repository);

/** Every `*.test.ts` that actually exists, excluding build and dependency output. */
function testFiles(directory: string, found: string[] = []): string[] {
  for (const entry of readdirSync(directory)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) testFiles(absolute, found);
    else if (entry.endsWith('.test.ts')) found.push(relative(root, absolute).split(sep).join('/'));
  }
  return found;
}

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};

// Any script whose body names a `.test.ts` path counts as claiming it. Matching
// on the path rather than on the script name means a new `test:whatever` script
// is picked up automatically — the check must not itself need maintaining every
// time someone adds a runner, or it becomes the next stale enumeration.
const claimed = new Map<string, string[]>();
for (const [name, body] of Object.entries(manifest.scripts)) {
  for (const match of body.matchAll(/[\w./-]+\.test\.ts/g)) {
    const path = match[0];
    claimed.set(path, [...(claimed.get(path) ?? []), name]);
  }
}

const present = testFiles(root);

// A run that finds no test files at all has failed to look, and must never be
// mistaken for "nothing to report" — the exact failure this repository has been
// bitten by repeatedly.
assert.ok(
  present.length > 10,
  `Found only ${present.length} test files in the canonical workspace, which means this check could not look rather than that everything is registered`,
);

const orphans = present.filter((file) => workflowsExecuting(file, resolution).length === 0);
const missing = [...claimed.keys()].filter((file) => !present.includes(file));

for (const [file, scripts] of claimed) {
  if (scripts.length > 1) {
    console.log(`note: ${file} is claimed by ${scripts.length} scripts (${scripts.join(', ')})`);
  }
}

if (missing.length > 0) {
  console.error(
    `\npackage.json names ${missing.length} test file(s) that do not exist. A script naming a missing file fails at run time with a confusing error:\n` +
      missing.map((file) => `  - ${file}`).join('\n'),
  );
}

if (orphans.length > 0) {
  console.error(
    `\n${orphans.length} test file(s) are executed by NO workflow, so they run nowhere:\n` +
      orphans
        .map(
          (file) =>
            `  - ${file}${claimed.has(file) ? `  (named by ${claimed.get(file)!.join(', ')}, but no workflow invokes that script)` : '  (named by no npm script at all)'}`,
        )
        .join('\n') +
      '\n\nAdd each to the script that suits it — test:unit for anything needing no services,\n' +
      'test:integration for anything needing PostgreSQL, Redis or LocalStack, or its own step.\n' +
      'Being named by a script is not enough: the script has to be one a workflow runs,\n' +
      'because a safety net that exists and is unreachable is the original defect (CS-52).\n',
  );
}

assert.equal(
  orphans.length + missing.length,
  0,
  `${orphans.length} unexecuted and ${missing.length} missing test file(s)`,
);

console.log(
  `PASS  all ${present.length} canonical test files are executed by a workflow ` +
    `(${resolution.workflowFiles.join(', ')})`,
);
