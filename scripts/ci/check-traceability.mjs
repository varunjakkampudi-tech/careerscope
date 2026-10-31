#!/usr/bin/env node
// Validates docs/TRACEABILITY.md: every row must name implementing files that
// exist, and either covering test files that exist or the literal NOT COVERED.
// A covering test file must also be listed in a package.json script that CI executes
// (test:unit, test:integration, test:domain, test:ui, test:query-budget and gates:test, with the
// npm scripts they call), or be followed by an explicit `(manual)` marker.
//
// Every tracked test file (*.test.ts, *.test.mjs, *.test.js) must also be named by a CI-run script or
// by a workflow step that runs on push or pull_request (not a dispatch-only step or job), or be marked
// `path` (manual) in docs/STAGE-1.md or docs/TRACEABILITY.md.
//
// It also validates docs/STAGE-1.md (exactly the 15 owner items 1.01 to 1.15, each with a status,
// evidence and a gate; an item marked Complete may cite only files that exist and tests that a CI
// script runs) and that the Stage 1.02 prose in docs/TRACEABILITY.md quotes the counts of the
// v12 inventory.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { isDispatchOnly, runCommandsOf } from './workflow-steps.mjs';

export { isDispatchOnly };

const MATRIX = 'docs/TRACEABILITY.md';
const STAGE_FILE = 'docs/STAGE-1.md';
const STAGE_ITEMS = Array.from(
  { length: 15 },
  (_, index) => `1.${String(index + 1).padStart(2, '0')}`,
);
const STAGE_STATUSES = ['Complete', 'Open'];
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

export function ciExecutedText(root, extraText = '') {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const scripts = manifest.scripts ?? {};
  const seen = new Set();
  const pending = [...CI_ROOTS];
  for (const match of extraText.matchAll(/npm run ([\w:-]+)/g)) pending.push(match[1]);
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

/**
 * The `run` text of every workflow step that executes on push or pull_request: a step whose own `if`
 * is dispatch-only, or that sits in a job whose `if` is dispatch-only, is left out. A workflow that
 * does not parse contributes nothing, so its tests surface as orphans instead of being trusted.
 */
export function workflowRunText(root) {
  const directory = join(root, '.github', 'workflows');
  if (!existsSync(directory)) return '';
  const commands = [];
  for (const name of readdirSync(directory).filter((entry) => /\.ya?ml$/.test(entry))) {
    let document;
    try {
      document = parseYaml(readFileSync(join(directory, name), 'utf8'));
    } catch {
      continue;
    }
    commands.push(...runCommandsOf(document));
  }
  return commands.join('\n');
}

const ORPHAN_CANDIDATE = /\.test\.(?:ts|mjs|js)$/;
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', 'dist', '.next', 'coverage']);

function walk(root, directory = '') {
  const files = [];
  for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...walk(root, relative));
    } else files.push(relative);
  }
  return files;
}

/** Tracked files from git; a directory that is not a git checkout is walked instead. */
function trackedFiles(root) {
  const result = spawnSync('git', ['-C', root, 'ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status === 0 && result.stdout) return result.stdout.split('\0').filter(Boolean);
  return walk(root);
}

const BEFORE_PATH = /[\s"'`=]/;
const AFTER_PATH = /[\s"'`;)]/;

/** True when `text` names `path` as a whole path token (not as the tail of a longer path). */
function mentionsPath(text, path) {
  for (let at = text.indexOf(path); at !== -1; at = text.indexOf(path, at + 1)) {
    const before = at === 0 ? ' ' : text[at - 1];
    const after = text[at + path.length] ?? ' ';
    if (BEFORE_PATH.test(before) && AFTER_PATH.test(after)) return true;
  }
  return false;
}

/**
 * Tracked test files (*.test.ts, *.test.mjs, *.test.js, so also *.integration.test.ts) that no CI-run
 * script or push/pull_request workflow step names and that are not marked `path` (manual) in the Stage 1 register or
 * the traceability matrix. Returns the orphan paths.
 */
export function findOrphanTests(root, files = trackedFiles(root)) {
  const workflows = workflowRunText(root);
  const text = `${existsSync(join(root, 'package.json')) ? ciExecutedText(root, workflows) : ''}\n${workflows}`;
  const manual = new Set();
  for (const doc of [STAGE_FILE, MATRIX])
    if (existsSync(join(root, doc)))
      for (const match of readFileSync(join(root, doc), 'utf8').matchAll(MANUAL))
        manual.add(match[1]);
  return files
    .filter((file) => ORPHAN_CANDIDATE.test(file) && existsSync(join(root, file)))
    .filter((file) => !manual.has(file))
    .filter((file) => !mentionsPath(text, file))
    .sort();
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

/** Splits docs/STAGE-1.md into its `## 1.NN` sections and their `- **Field:** text` bullets. */
export function parseStage(text) {
  const sections = [];
  let current = null;
  let field = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = /^## (\d+\.\d+)\b\s*(.*)$/.exec(line);
    if (heading) {
      current = { id: heading[1], title: heading[2].trim(), fields: {} };
      sections.push(current);
      field = null;
      continue;
    }
    if (/^#{1,2} /.test(line)) {
      current = null;
      field = null;
      continue;
    }
    if (!current) continue;
    const bullet = /^- \*\*([A-Za-z ]+):\*\*\s*(.*)$/.exec(line);
    if (bullet) {
      field = bullet[1];
      current.fields[field] = [...(current.fields[field] ?? []), bullet[2]];
    } else if (field && line.trim() && /^\s/.test(line)) {
      const values = current.fields[field];
      values[values.length - 1] += ` ${line.trim()}`;
    } else if (!line.trim()) field = null;
  }
  return sections;
}

/** Problems with docs/STAGE-1.md. Complete items are held to the CI-run rule; Open items need a gap. */
export function analyzeStage(root) {
  const errors = [];
  const file = join(root, STAGE_FILE);
  if (!existsSync(file)) return { errors: [`${STAGE_FILE} is missing`], items: 0, complete: 0 };
  const executed = new Set(
    existsSync(join(root, 'package.json')) ? ciExecutedText(root).split(/\s+/) : [],
  );
  const sections = parseStage(readFileSync(file, 'utf8'));
  const ids = sections.map((section) => section.id);
  if (ids.join(',') !== STAGE_ITEMS.join(','))
    errors.push(
      `${STAGE_FILE} must have exactly the 15 items ${STAGE_ITEMS[0]} to ${STAGE_ITEMS[14]} once each, in order; found ${ids.length}: ${ids.join(', ') || 'none'}`,
    );
  let complete = 0;
  for (const section of sections) {
    const fail = (message) => errors.push(`${section.id}: ${message}`);
    const one = (name) => {
      const values = section.fields[name] ?? [];
      if (values.length > 1) fail(`has ${values.length} "${name}" lines, expected one`);
      return (values[0] ?? '').trim();
    };
    const status = one('Status');
    if (!STAGE_STATUSES.includes(status))
      fail(`Status must be one of ${STAGE_STATUSES.join(', ')}, found "${status}"`);
    if (!section.title) fail('heading has no title');
    for (const name of ['Evidence', 'Gate', 'Verify']) if (!one(name)) fail(`${name} is empty`);
    if (status === 'Open' && !one('Gap')) fail('an Open item must state its Gap');
    if (status === 'Complete' && one('Gap')) fail('a Complete item must not carry a Gap');
    if (status === 'Complete') complete += 1;

    const evidence = paths(one('Evidence'));
    if (one('Evidence') && !evidence.length) fail('Evidence must cite files in backticks');
    const manual = new Set([...one('Evidence').matchAll(MANUAL)].map((match) => match[1]));
    let citesCiTest = false;
    for (const path of evidence) {
      if (!existsSync(join(root, path))) {
        fail(`evidence file not found: ${path}`);
        continue;
      }
      if (!TEST_PATH.test(path)) continue;
      if (executed.has(path)) citesCiTest = true;
      else if (status === 'Complete')
        fail(`Complete item cites a test that no CI script runs: ${path}`);
      else if (!manual.has(path))
        fail(`test is not run by any CI script; mark it "(manual)" or run it in CI: ${path}`);
    }
    if (status === 'Complete' && !citesCiTest)
      fail('a Complete item must cite at least one test that a CI script runs');
  }
  return { errors, items: sections.length, complete };
}

/** The Stage 1.02 prose and the Stage 1 register must quote the counts of the v12 inventory. */
export async function checkReconciliationProse(root) {
  const { analyzeInventory, summaryLine } = await import('./check-requirements-inventory.mjs');
  const inventory = analyzeInventory(root, '');
  if (!inventory.total) return [`cannot read the v12 inventory counts for ${MATRIX}`];
  const expected = summaryLine(inventory);
  const errors = [];
  for (const path of [MATRIX, STAGE_FILE]) {
    const file = join(root, path);
    if (!existsSync(file)) errors.push(`${path} is missing`);
    else if (!readFileSync(file, 'utf8').replace(/\s+/g, ' ').includes(expected))
      errors.push(`${path} must quote the inventory counts exactly: "${expected}"`);
  }
  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv.find((value) => value.startsWith('--root='));
  const root = argument
    ? resolve(argument.slice('--root='.length))
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const { errors, rows, notCovered } = analyze(root);
  errors.push(...checkDocsIndex(root));
  for (const orphan of findOrphanTests(root))
    errors.push(
      `orphan test file: no CI script or workflow step runs it; wire it into an existing script or mark it (manual) in ${STAGE_FILE}: ${orphan}`,
    );
  if (errors.length) {
    for (const error of errors) console.error(`::error file=${MATRIX}::${error}`);
    console.error(`FAIL ${errors.length} traceability problem(s)`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS traceability: ${rows} rows, ${notCovered} NOT COVERED\n`);
  }

  const stage = analyzeStage(root);
  stage.errors.push(...(await checkReconciliationProse(root)));
  if (stage.errors.length) {
    for (const error of stage.errors) console.error(`::error file=${STAGE_FILE}::${error}`);
    console.error(`FAIL ${stage.errors.length} Stage 1 register problem(s)`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `PASS Stage 1 register: ${stage.items} items, ${stage.complete} Complete, ${stage.items - stage.complete} Open\n`,
    );
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
