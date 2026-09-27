#!/usr/bin/env node
// Enforces the Node version floor once, loudly, at the front of the gates.
//
// Why this exists, and it is worth reading because it is a better bug than the
// one that produced it:
//
// This repository declares Node >=24 in four separate places, and CI runs 24.
// A whole night of local verification — typecheck, lint, unit suites, gate
// suites, browser suites — was nonetheless run on v22.23.2, two majors below
// the declared minimum, and every one of those suites reported green.
//
// Exactly one thing noticed: `scripts/engineering-runner.test.mjs`. The runner
// spawns `node --test --test-isolation=none`, Node 22 rejects that flag
// outright ("bad option", exit 9, zero bytes of output), so the child produced
// no TAP at all, the artefact recorded `totals: null, success: false`, and five
// total-enforcement cases failed. The suite was right. It refused to report
// totals it could not substantiate, which is precisely its stated job — and it
// was briefly mistaken for a release blocker and nearly "fixed".
//
// A version floor that only one test enforces, by accident, through a flag
// incompatibility, is not a floor. This makes it explicit and unmissable, and
// it makes the four declarations check each other: two independent lists of
// "what version do we need" is one list too many, which is the same defect
// class as .gitattributes and check-line-endings.mjs diverging over `.txt`.
//
// It fails rather than warns. A warning at the top of a long gate chain is a
// warning nobody reads, and the cost of the alternative was a night of
// evidence that has to be re-qualified.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const write = (message) => process.stdout.write(`${message}\n`);
const warn = (message) => process.stderr.write(`${message}\n`);

const rootArgument = process.argv.find((argument) => argument.startsWith('--root='));
const root = rootArgument
  ? rootArgument.slice('--root='.length)
  : fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');

function fail(message) {
  warn(`::error::${message}`);
  process.exit(1);
}

function readJson(relative) {
  const path = join(root, relative);
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    // Unreadable is not "no requirement". A missing manifest must never be
    // read as permission to run on anything.
    fail(
      `Could not read ${relative} (${error.message}). Refusing to assume any Node version is acceptable.`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(
      `${relative} did not parse (${error.message}). Refusing to assume any Node version is acceptable.`,
    );
  }
}

/**
 * Accepts only the two forms this repository actually uses: `>=24` and
 * `>=24.0.0`. Anything else fails rather than being guessed at — a range this
 * does not understand must not be silently treated as satisfied.
 */
function majorFromRange(range, source) {
  const match = /^>=\s*(\d+)(?:\.\d+)?(?:\.\d+)?$/.exec(String(range).trim());
  if (!match) {
    fail(
      `${source} declares the Node range "${range}", which this check does not understand. ` +
        'Teach it the new form rather than leaving the floor unenforced.',
    );
  }
  return Number(match[1]);
}

function majorFromPlain(value, source) {
  const match = /^v?(\d+)(?:\.\d+)?(?:\.\d+)?$/.exec(String(value).trim());
  if (!match) fail(`${source} declares "${value}", which is not a recognisable Node version.`);
  return Number(match[1]);
}

const declarations = [];

const rootManifest = readJson('package.json');
if (!rootManifest.engines?.node)
  fail('package.json declares no engines.node. The floor has to be written down somewhere.');
declarations.push({
  source: 'package.json engines.node',
  raw: rootManifest.engines.node,
  major: majorFromRange(rootManifest.engines.node, 'package.json'),
});

const v2Manifest = readJson('v2/package.json');
if (!v2Manifest.engines?.node) fail('v2/package.json declares no engines.node.');
declarations.push({
  source: 'v2/package.json engines.node',
  raw: v2Manifest.engines.node,
  major: majorFromRange(v2Manifest.engines.node, 'v2/package.json'),
});

let nvmrc;
try {
  nvmrc = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
} catch (error) {
  // N-3: absent was treated more leniently than corrupt — a garbage .nvmrc
  // failed loudly while a missing one silently contributed no declaration.
  // That is backwards: a lost declaration is exactly the "cannot look" case,
  // and it is the quiet one that erodes the floor.
  fail(
    `Could not read .nvmrc (${error.message}). A missing declaration is a lost declaration, not an absent requirement.`,
  );
}
if (!nvmrc) fail('.nvmrc is empty. A blank version declaration is not the same as no requirement.');
declarations.push({ source: '.nvmrc', raw: nvmrc, major: majorFromPlain(nvmrc, '.nvmrc') });

// N-1: every workflow that pins a Node version is part of the same claim, so
// the workflows are discovered rather than listed. A hand-written list of three
// names was the third hand-maintained list in this file's own subject matter: a
// new workflow pinning a different major would have been invisible, and a
// renamed one would silently have contributed nothing.
const workflowDirectory = join(root, '.github', 'workflows');
let workflowNames;
try {
  workflowNames = readdirSync(workflowDirectory).filter((name) => /\.ya?ml$/.test(name));
} catch (error) {
  fail(`Could not list ${workflowDirectory} (${error.message}).`);
}
if (workflowNames.length === 0) {
  fail(
    `No workflows found under ${workflowDirectory}. Refusing to report agreement among nothing.`,
  );
}
for (const name of workflowNames) {
  const text = readFileSync(join(workflowDirectory, name), 'utf8');
  const pinned = /^\s*NODE_VERSION:\s*'?"?(\d+)(?:\.\d+)?'?"?\s*$/m.exec(text);
  if (pinned)
    declarations.push({
      source: `.github/workflows/${name} NODE_VERSION`,
      raw: pinned[1],
      major: majorFromPlain(pinned[1], `.github/workflows/${name}`),
    });
}

// Structural, not just numeric: the three file-based declarations are each
// required by name, so losing one cannot be absorbed by a count. A bare
// threshold tolerated dropping two silently once the workflows were globbed.
for (const required of ['package.json engines.node', 'v2/package.json engines.node', '.nvmrc']) {
  if (!declarations.some((declaration) => declaration.source === required)) {
    fail(
      `The declaration from ${required} is missing. Every source must be present, not merely enough of them.`,
    );
  }
}
if (!declarations.some((declaration) => declaration.source.startsWith('.github/workflows/'))) {
  fail('No workflow pins NODE_VERSION. CI would then run on whatever the runner defaults to.');
}
if (declarations.length < 4) {
  fail(
    `Found only ${declarations.length} Node version declaration(s). This repository has at least four, ` +
      'so this check could not look rather than that the declarations are consistent.',
  );
}

// Two independent lists of "what version do we need" is one list too many.
const majors = [...new Set(declarations.map((declaration) => declaration.major))];
if (majors.length > 1) {
  for (const declaration of declarations)
    warn(`  ${declaration.source} => ${declaration.raw} (major ${declaration.major})`);
  fail(
    `The Node version floor is declared inconsistently (majors: ${majors.join(', ')}). ` +
      'One of these is going to be the stale one, and nothing would say which.',
  );
}

const required = majors[0];
// N-2: this was `Number(process.versions.node.split('.')[0])`, and `NaN < 24`
// is false — so an unparseable running version PASSED, and the summary would
// have printed "PASS Node vNaN satisfies the floor of 24". Every other input in
// this file is validated and refuses when it cannot be read; this one was
// coerced, in the check whose entire thesis is that an unenforced floor is not
// a floor. It goes through the same validator as .nvmrc.
const running = majorFromPlain(process.versions.node, 'the running Node runtime');

if (running < required) {
  for (const declaration of declarations) warn(`  ${declaration.source} => ${declaration.raw}`);
  warn('');
  warn(`  running: v${process.versions.node}`);
  warn('');
  warn('  Results obtained below the floor are not evidence about this project. A whole night of');
  warn(
    '  local verification once ran on v22.23.2 and reported green; the single suite that noticed',
  );
  warn('  did so only because Node 22 rejects a flag the test runner passes, and it was briefly');
  warn('  mistaken for a release blocker.');
  fail(
    `Node v${process.versions.node} is below the required major ${required}. Install Node ${required} (see .nvmrc) and re-run.`,
  );
}

write(
  `PASS  Node v${process.versions.node} satisfies the floor of ${required}, ` +
    `declared consistently in ${declarations.length} places`,
);
