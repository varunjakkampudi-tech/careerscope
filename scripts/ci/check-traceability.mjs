#!/usr/bin/env node
// Validates docs/TRACEABILITY.md: every row must name implementing files that
// exist, and either covering test files that exist or the literal NOT COVERED.
// A covering test file must also be listed in a package.json script that CI executes
// (test:unit, test:integration, test:domain, test:ui, test:query-budget and gates:test, with the
// npm scripts they call), or be followed by an explicit `(manual)` marker.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MATRIX = 'docs/TRACEABILITY.md';
const NOT_COVERED = 'NOT COVERED';
const TEST_PATH = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$)|^(?:scripts\/tests|tests)\//;

function cells(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

const paths = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
const MANUAL = /`([^`]+)`\s*\(manual\)/g;

/** Scripts that the CI workflow runs, directly or through `npm run` references. */
const CI_ROOTS = [
  'test:unit',
  'test:integration',
  'test:domain',
  'test:ui',
  'test:query-budget',
  'gates:test',
];

export function ciExecutedText(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const scripts = manifest.scripts ?? {};
  const seen = new Set();
  const pending = [...CI_ROOTS];
  let text = '';
  while (pending.length) {
    const name = pending.pop();
    if (seen.has(name) || typeof scripts[name] !== 'string') continue;
    seen.add(name);
    text += `\n${scripts[name]}`;
    for (const match of scripts[name].matchAll(/npm run ([\w:-]+)/g)) pending.push(match[1]);
  }
  return text;
}

/** Every file under docs/ except the index itself, as a path relative to docs/. */
function documentFiles(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory())
      files.push(...documentFiles(join(directory, entry.name), `${relative}/`));
    else if (relative !== 'README.md') files.push(relative);
  }
  return files.sort();
}

/** docs/README.md claims to link every document under docs/; returns the documents it does not link. */
export function checkDocsIndex(root) {
  const docs = join(root, 'docs');
  const index = join(docs, 'README.md');
  if (!existsSync(index)) return ['docs/README.md is missing'];
  const linked = new Set(
    [...readFileSync(index, 'utf8').matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)].map((match) =>
      match[1].replace(/^\.\//, ''),
    ),
  );
  return documentFiles(docs)
    .filter((file) => !linked.has(file))
    .map((file) => `docs/README.md does not link docs/${file}`);
}

export function analyze(root) {
  const errors = [];
  const file = join(root, MATRIX);
  if (!existsSync(file)) return { errors: [`${MATRIX} is missing`], rows: 0, notCovered: 0 };
  const seen = new Set();
  const executed = new Set(
    existsSync(join(root, 'package.json')) ? ciExecutedText(root).split(/\s+/) : [],
  );
  let rows = 0;
  let notCovered = 0;

  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('|')) continue;
    const columns = cells(line);
    if (!/^[A-Z]+-\d+$/.test(columns[0])) continue;
    rows += 1;
    const [id, requirement, source, implementing, tests] = columns;
    const fail = (message) => errors.push(`${id}: ${message}`);
    if (columns.length !== 5) {
      fail(`expected 5 columns, found ${columns.length}`);
      continue;
    }
    if (seen.has(id)) fail('duplicate ID');
    seen.add(id);
    if (!requirement) fail('requirement is empty');

    const link = /\]\(([^)#]+)(?:#[^)]*)?\)/.exec(source);
    if (!link) fail('source doc must be a markdown link');
    else if (!existsSync(resolve(root, 'docs', link[1]))) fail(`source doc not found: ${link[1]}`);

    const implementingFiles = paths(implementing);
    if (!implementingFiles.length) fail('no implementing files');
    for (const path of implementingFiles)
      if (!existsSync(join(root, path))) fail(`implementing file not found: ${path}`);

    const testFiles = paths(tests);
    if (tests === NOT_COVERED) notCovered += 1;
    else if (!testFiles.length) fail(`tests must list test files or say ${NOT_COVERED}`);
    const manual = new Set([...tests.matchAll(MANUAL)].map((match) => match[1]));
    for (const path of testFiles) {
      if (!TEST_PATH.test(path)) fail(`not a test file: ${path}`);
      else if (!existsSync(join(root, path))) fail(`test file not found: ${path}`);
      else if (!executed.has(path) && !manual.has(path))
        fail(
          `test file is not run by any CI script (test:unit, test:integration, test:domain, test:ui, gates:test); add it to one or mark it "(manual)": ${path}`,
        );
      else if (manual.has(path) && executed.has(path))
        fail(`test file is marked (manual) but a CI script runs it: ${path}`);
    }
  }
  if (!rows) errors.push(`${MATRIX} contains no requirement rows`);
  return { errors, rows, notCovered };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv.find((value) => value.startsWith('--root='));
  const root = argument
    ? resolve(argument.slice('--root='.length))
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { errors, rows, notCovered } = analyze(root);
  errors.push(...checkDocsIndex(root));
  if (errors.length) {
    for (const error of errors) console.error(`::error file=${MATRIX}::${error}`);
    console.error(`FAIL ${errors.length} traceability problem(s)`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS traceability: ${rows} rows, ${notCovered} NOT COVERED\n`);
  }

  // Stage 1.02: the same gate validates the v12 requirement inventory, so CI cannot pass with a
  // NOT_ASSESSED clause, a stale source digest or an IMPLEMENTED clause that has no CI-run test.
  const { checkRequirements, summaryLine } = await import('./check-requirements-inventory.mjs');
  const requirements = await checkRequirements(root, ciExecutedText(root));
  if (requirements.errors.length) {
    for (const error of requirements.errors)
      console.error(`::error file=docs/requirements/V12-REQUIREMENT-INVENTORY.json::${error}`);
    console.error(`FAIL ${requirements.errors.length} requirement inventory problem(s)`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS v12 requirement inventory: ${summaryLine(requirements)}\n`);
  }
}
