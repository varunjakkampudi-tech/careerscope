#!/usr/bin/env node
// Type-checks the canonical test files, and refuses to report success on an empty
// file set.
//
// `tsc -p tsconfig.test.json` alone is not enough, because a tsconfig whose
// `include` stops matching resolves ZERO files and type-checks perfectly. That
// is the empty-loop defect in a build config, and it is invisible in exactly
// the way the original `exclude` was: nothing errors, nothing is checked, the
// exit code is 0. The same shape as a validator reporting "no entries yet" for
// a file holding three.
//
// So the file count is asserted against a floor before any green result is
// believed. The project resolves the canonical test files — including the
// packages/core, 4 in scripts, and apps/workers/search; apps/api has none yet,
// and the one outside is apps/web (covered by its own Next project). If that
// number falls,
// something stopped being checked and this says so instead of passing.
//
// The project also covers the 19 non-test `.ts` files in scripts, which were
// in NO tsconfig at all: `tsconfig.json` references only packages/core,
// apps/workers/search and apps/api. That gap hid a too-narrow parameter type in
// check-crash-recovery.ts — the crash-recovery check this repository runs in
// CI — and eleven unguarded null dereferences across it and check-ui.ts, each
// of which would have failed a check for a reason unrelated to its subject.
// The floor below counts test files only; the script files are covered by the
// same run.
//
// A precise note on scope, because the earlier wording here was wrong.
// tsconfig.test.json explicitly includes apps/workers/search so its test file
// is checked directly rather than relying on a production-file dependency to
// pull only collect.ts into the resolved file set.
//
// The exit status of tsc is part of the verdict (S1-F038). A configuration error
// such as an invalid option is reported on a `.json` line that the `.ts` pattern
// used to skip, and the run still printed PASS with status 0 from this script.

import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const write = (message) => process.stdout.write(`${message}\n`);
const warn = (message) => process.stderr.write(`${message}\n`);

// Raising this is a decision; it should never drift down silently.
export const MINIMUM_TEST_FILES = 16;

/**
 * Decide the outcome from tsc's exit status and its combined output.
 *
 * Pure, so the decision is tested without running the compiler. Any nonzero or
 * missing status fails, and so does any `error TSnnnn` line whatever it names:
 * a `.ts` file with a location, a `.json` config with a location, or a global
 * error with no location at all.
 */
export function decide({ status, output, minimum = MINIMUM_TEST_FILES }) {
  const lines = output.split(/\r?\n/);
  const resolved = lines.filter(
    (line) => /\.test\.ts$/.test(line.trim()) && !line.includes('node_modules'),
  );
  const errors = lines.filter((line) => /\berror TS\d+:/.test(line));

  if (resolved.length < minimum) {
    return {
      verdict: 'REFUSE',
      resolved,
      errors,
      reason:
        `tsconfig.test.json resolved only ${resolved.length} test file(s), expected at least ` +
        `${minimum}. A project that includes nothing type-checks perfectly — this is the ` +
        'empty-loop defect in a build config, and it must fail rather than pass.',
    };
  }
  if (status !== 0 || errors.length > 0) {
    return {
      verdict: 'FAIL',
      resolved,
      errors,
      reason:
        status === 0
          ? `${errors.length} type error line(s)`
          : `tsc exited ${status === null ? 'without a status' : status}`,
    };
  }
  return { verdict: 'PASS', resolved, errors, reason: '' };
}

const root = fileURLToPath(new URL('../..', import.meta.url)).replace(/[\\/]$/, '');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // Invoke the compiler's own entry point with this Node, rather than going
  // through `npx`: a .cmd shim needs a shell on Windows, and a shell is one more
  // thing that can fail in a way that looks like a clean type-check.
  const compiler = fileURLToPath(new URL('../../node_modules/typescript/bin/tsc', import.meta.url));
  const result = spawnSync(
    process.execPath,
    [compiler, '-p', 'tsconfig.test.json', '--noEmit', '--listFiles'],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  if (result.error) {
    warn(
      `::error::Could not run tsc (${result.error.message}). Refusing to report a type-check that did not happen.`,
    );
    process.exit(1);
  }

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const decision = decide({ status: result.status, output });

  if (decision.verdict === 'REFUSE') {
    warn(`::error::${decision.reason}`);
    for (const file of decision.resolved) warn(`  resolved: ${file.trim()}`);
    process.exit(1);
  }

  if (decision.verdict === 'FAIL') {
    for (const line of decision.errors) warn(`  ${line}`);
    const byFile = new Map();
    for (const line of decision.errors) {
      const file = line.split('(')[0];
      byFile.set(file, (byFile.get(file) ?? 0) + 1);
    }

    // Test and non-test files are counted and worded separately. This used to
    // report every errored path as "a test file", which was wrong in the way
    // that matters most for a message an operator acts on: when collect.ts — a
    // production worker file, reached as a dependency — was failing, it was
    // labelled a test file AND given the explanation below, which is false for
    // it. Being believed is this script's entire value, so it has to be accurate
    // about what it found and not only about whether it found something.
    const isTest = (file) => /\.test\.ts$/.test(file);
    const tests = [...byFile].filter(([file]) => isTest(file));
    const others = [...byFile].filter(([file]) => !isTest(file));
    const describe = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;

    warn(
      `\n::error::${decision.reason} across ` +
        [
          tests.length > 0 ? describe(tests.length, 'test file') : '',
          others.length > 0 ? describe(others.length, 'non-test file') : '',
        ]
          .filter(Boolean)
          .join(' and ') +
        ':',
    );
    for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1])) {
      warn(`  ${String(count).padStart(4)}  ${file}${isTest(file) ? '' : '   (not a test file)'}`);
    }

    if (tests.length > 0) {
      warn(
        '\nThe test files were never type-checked before: `tsc -b` skips them because the package ' +
          'builds exclude test files so they do not reach dist. A test can therefore hold a type ' +
          'that collapses to `never` and asserts nothing at all.',
      );
    }
    if (others.length > 0) {
      warn(
        '\nThe non-test file(s) above are production or tooling code reached as a dependency of a ' +
          'file this project includes. They are a real defect in that code — not a test-typing ' +
          'artefact — and the explanation above does not apply to them.',
      );
    }
    process.exit(1);
  }

  write(`PASS  ${decision.resolved.length} canonical test files type-check clean (no emit)`);
}
