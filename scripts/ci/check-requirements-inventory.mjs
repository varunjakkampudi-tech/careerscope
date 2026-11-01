#!/usr/bin/env node
// Validates the v12 requirement reconciliation (Foundation item 1.02).
//
// docs/requirements/V12-REQUIREMENT-INVENTORY.json records an assessment per clause of the owner's
// v12 specification. Exactly what is enforced: this check fails when
//   - the source's sha256 differs from SOURCE_SHA256 (pinned in this file) or from the inventory's
//     sourceSha256;
//   - the inventory does not have EXPECTED_CLAUSES (319) items, totalSourceItems differs, or the
//     items do not carry that many distinct integer sourceLine values. Changing the source or the
//     clause count therefore needs an edit to the constants here, visible in review. This does not
//     prove the 319 clauses are all of the source's clauses, only that none was dropped since the pin;
//   - an item's text is not equal to its source line after whitespace squashing (a blank or
//     punctuation-only line never matches). A deliberate excerpt must carry `"excerpt": true`;
//     it is then checked as a substring of the line of at least MIN_MATCH_LENGTH letters or digits;
//   - an item is still NOT_ASSESSED, has an unknown status, or lacks the fields its status needs;
//   - an IMPLEMENTED item cites no implementing file or no test, or cites a test that no CI script
//     or non-comment, non-dispatch-only workflow `run:` step names;
//   - a cited file does not exist or a cited line is past the end of the file;
//   - an OUT_OF_SCOPE_POST_LAUNCH quote is not verbatim in the source's post-launch section (11);
//   - docs/requirements/V12-RECONCILIATION.md is not the output of this script for the inventory.
// `--write` regenerates the summary. `--root=<dir>` checks another checkout (used by the tests).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import prettier from 'prettier';
import { parse as parseYaml } from 'yaml';
import { runCommandsOf } from './workflow-steps.mjs';

export const DIR = 'docs/requirements';
export const SOURCE = `${DIR}/CareerScope-v12.md`;
export const INVENTORY = `${DIR}/V12-REQUIREMENT-INVENTORY.json`;
export const SUMMARY = `${DIR}/V12-RECONCILIATION.md`;
export const STATUSES = [
  'IMPLEMENTED',
  'PARTIAL',
  'NOT_IMPLEMENTED',
  'OWNER_EVIDENCE',
  'OUT_OF_SCOPE_POST_LAUNCH',
];
const VERIFICATIONS = [
  'UNIT_TESTS_PASSED',
  'STATIC_REVIEW_TESTS_NOT_RERUN',
  'OWNER_EVIDENCE_PENDING',
  'NOT_APPLICABLE',
];
/** Pinned: the sha256 of docs/requirements/CareerScope-v12.md and the number of clauses taken from it. */
export const SOURCE_SHA256 = '35e9a728a65b0620cb9075345216c69c973fee57efad21752554dc338a532167';
export const EXPECTED_CLAUSES = 319;
/** A clause marked `excerpt: true` needs at least this many letters or digits to match as a substring. */
const MIN_MATCH_LENGTH = 4;
const squash = (value) => String(value).replace(/\s+/g, ' ').trim();
const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const refPath = (ref) => ref.replace(/:\d+$/, '');
const refLine = (ref) => (/:(\d+)$/.exec(ref) ? Number(/:(\d+)$/.exec(ref)[1]) : null);
const sectionKey = (id) => id.replace(/^V12-/, '').replace(/-\d+$/, '');
const sectionOrder = (key) => key.split('.').map(Number);

/** 1-based first and last line of the `## <number>.` section of the source. */
export function sectionRange(sourceLines, number) {
  const start = sourceLines.findIndex((line) => line.startsWith(`## ${number}.`));
  if (start < 0) return null;
  const next = sourceLines.findIndex((line, index) => index > start && line.startsWith('## '));
  return [start + 1, next < 0 ? sourceLines.length : next];
}

/**
 * Text of the `run:` commands of a workflow that execute on push or pull_request. The dispatch-only
 * exclusion is the one check-traceability.mjs applies (shared `runCommandsOf` in workflow-steps.mjs), so a test run only by
 * a workflow_dispatch step is not CI-run here either. Shell comment lines are dropped. A workflow that
 * does not parse contributes nothing.
 */
export function workflowRunText(workflow) {
  let document;
  try {
    document = parseYaml(workflow);
  } catch {
    return '';
  }
  return runCommandsOf(document)
    .flatMap((command) => command.split(/\r?\n/))
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

function executedTokens(root, scriptText) {
  const workflow = join(root, '.github/workflows/ci.yml');
  const run = existsSync(workflow) ? workflowRunText(readFileSync(workflow, 'utf8')) : '';
  return new Set(`${scriptText}\n${run}`.split(/\s+/));
}

/** Checks one `path` or `path:line` reference. Returns an error message or null. */
function checkReference(root, ref, lineCounts) {
  if (!nonEmpty(ref)) return 'empty reference';
  const path = refPath(ref);
  const line = refLine(ref);
  const file = join(root, path);
  if (!existsSync(file)) return `file not found: ${path}`;
  if (line === null) return null;
  if (!lineCounts.has(path)) lineCounts.set(path, readFileSync(file, 'utf8').split('\n').length);
  if (line < 1 || line > lineCounts.get(path)) return `line out of range: ${ref}`;
  return null;
}

function checkStatusFields(item, fail, context) {
  const { sourceLines, section11, root, lineCounts, executed } = context;
  const status = item.assessment;
  const evidence = item.evidence ?? {};
  const implementation = Array.isArray(evidence.implementation) ? evidence.implementation : [];
  const tests = Array.isArray(evidence.tests) ? evidence.tests : [];
  const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
  for (const ref of checks) {
    const problem = checkReference(root, ref, lineCounts);
    if (problem) fail(item.id, `manual check ${problem}`);
  }
  for (const ref of implementation) {
    const problem = checkReference(root, ref, lineCounts);
    if (problem) fail(item.id, `implementation ${problem}`);
  }
  for (const ref of tests) {
    const problem = checkReference(root, ref, lineCounts);
    if (problem) fail(item.id, `test ${problem}`);
    else if (!executed.has(refPath(ref)))
      fail(item.id, `test is not run by any CI script or workflow: ${refPath(ref)}`);
  }
  if (status === 'IMPLEMENTED') {
    if (!implementation.length) fail(item.id, 'IMPLEMENTED needs evidence.implementation');
    if (!tests.length) fail(item.id, 'IMPLEMENTED needs evidence.tests (a CI-run test or check)');
    if (item.gap) fail(item.id, 'IMPLEMENTED must not carry a gap');
  } else if (status === 'PARTIAL' || status === 'NOT_IMPLEMENTED') {
    if (!nonEmpty(item.gap)) fail(item.id, `${status} needs a gap that says what is missing`);
    if (typeof item.launchBlocking !== 'boolean') fail(item.id, `${status} needs launchBlocking`);
  } else if (status === 'OWNER_EVIDENCE') {
    if (!nonEmpty(item.ownerEvidenceNeeded))
      fail(item.id, 'OWNER_EVIDENCE needs ownerEvidenceNeeded');
    if (typeof item.launchBlocking !== 'boolean')
      fail(item.id, 'OWNER_EVIDENCE needs launchBlocking');
  } else if (status === 'OUT_OF_SCOPE_POST_LAUNCH') {
    const quote = squash(item.sourceQuote ?? '');
    if (!quote) fail(item.id, 'OUT_OF_SCOPE_POST_LAUNCH needs sourceQuote');
    else if (!section11) fail(item.id, 'source has no section 11 post-launch exclusions');
    else {
      const [first, last] = section11;
      const found = sourceLines.slice(first - 1, last).some((line) => squash(line).includes(quote));
      if (!found) fail(item.id, 'sourceQuote is not verbatim in the source section 11');
    }
  }
}

function checkItemShape(item, seen, sourceLines, fail) {
  for (const key of ['id', 'section', 'text', 'assessment', 'verification']) {
    if (!nonEmpty(item[key])) fail(item.id ?? '?', `missing ${key}`);
  }
  if (seen.has(item.id)) fail(item.id, 'duplicate id');
  seen.add(item.id);
  if (item.assessment === 'NOT_ASSESSED') fail(item.id, 'still NOT_ASSESSED');
  else if (!STATUSES.includes(item.assessment))
    fail(item.id, `unknown assessment ${JSON.stringify(item.assessment)}`);
  if (!VERIFICATIONS.includes(item.verification))
    fail(item.id, `unknown verification ${JSON.stringify(item.verification)}`);
  if (item.excerpt !== undefined && typeof item.excerpt !== 'boolean')
    fail(item.id, 'excerpt must be a boolean');
  else if (
    !matchesSourceLine(sourceLines[(item.sourceLine ?? 0) - 1], item.text, item.excerpt === true)
  )
    fail(item.id, `text does not match source line ${item.sourceLine}`);
}

const meaningful = (value) => value.replace(/[^\p{L}\p{N}]/gu, '');

/**
 * True when clause text and source line agree. The default is exact equality after whitespace
 * squashing. An item that is a deliberate excerpt (`excerpt: true`) must instead be contained in
 * the line and carry enough letters or digits to be specific. A blank or punctuation-only line
 * never matches.
 */
export function matchesSourceLine(line, text, excerpt = false) {
  if (line === undefined || typeof text !== 'string') return false;
  const [have, wanted] = [squash(line), squash(text)];
  const [haveCore, wantedCore] = [meaningful(have), meaningful(wanted)];
  if (!haveCore || !wantedCore) return false;
  if (have === wanted) return true;
  return excerpt && have.includes(wanted) && wantedCore.length >= MIN_MATCH_LENGTH;
}

export function analyzeInventory(root, scriptText = '') {
  const errors = [];
  const fail = (id, message) => errors.push(`${id}: ${message}`);
  const result = { errors, total: 0, counts: {}, blocking: 0 };
  const sourceFile = join(root, SOURCE);
  const inventoryFile = join(root, INVENTORY);
  for (const path of [SOURCE, INVENTORY, SUMMARY]) {
    if (!existsSync(join(root, path))) errors.push(`${path} is missing`);
  }
  if (errors.length) return result;

  const sourceBytes = readFileSync(sourceFile);
  let inventory;
  try {
    inventory = JSON.parse(readFileSync(inventoryFile, 'utf8'));
  } catch {
    errors.push(`${INVENTORY} is not valid JSON`);
    return result;
  }
  const digest = createHash('sha256').update(sourceBytes).digest('hex');
  if (inventory.sourceSha256 !== digest)
    errors.push(`${SOURCE} sha256 ${digest} does not match inventory sourceSha256`);
  if (digest !== SOURCE_SHA256)
    errors.push(`${SOURCE} sha256 ${digest} does not match the pinned SOURCE_SHA256`);
  const items = Array.isArray(inventory.items) ? inventory.items : [];
  if (items.length !== EXPECTED_CLAUSES)
    errors.push(`inventory has ${items.length} items, expected ${EXPECTED_CLAUSES} clauses`);
  if (inventory.totalSourceItems !== EXPECTED_CLAUSES)
    errors.push(
      `totalSourceItems ${inventory.totalSourceItems} does not equal the expected ${EXPECTED_CLAUSES}`,
    );
  const lineNumbers = items.map((item) => item.sourceLine);
  const distinct = new Set(lineNumbers.filter((line) => Number.isInteger(line)));
  if (distinct.size !== EXPECTED_CLAUSES || lineNumbers.length !== EXPECTED_CLAUSES)
    errors.push(
      `${distinct.size} distinct integer sourceLine values across ${lineNumbers.length} items, expected ${EXPECTED_CLAUSES}`,
    );
  for (const line of distinct)
    if (lineNumbers.indexOf(line) !== lineNumbers.lastIndexOf(line))
      errors.push(`sourceLine ${line} is used by more than one item`);

  const sourceLines = sourceBytes.toString('utf8').split(/\r?\n/);
  const context = {
    sourceLines,
    section11: sectionRange(sourceLines, 11),
    root,
    lineCounts: new Map(),
    executed: executedTokens(root, scriptText),
  };
  const seen = new Set();
  for (const item of items) {
    checkItemShape(item, seen, sourceLines, fail);
    if (STATUSES.includes(item.assessment)) checkStatusFields(item, fail, context);
    result.counts[item.assessment] = (result.counts[item.assessment] ?? 0) + 1;
    if (item.launchBlocking === true && item.assessment !== 'IMPLEMENTED') result.blocking += 1;
  }
  result.total = items.length;
  return result;
}

const cell = (value) => squash(value).replaceAll('|', String.fromCharCode(92) + '|');

function clauseText(item) {
  let text = item.text;
  if (item.kind === 'TABLE_REQUIREMENT')
    text = text
      .replace(/^\s*\|\s*|\s*\|\s*$/g, '')
      .split(/\s*\|\s*/)
      .join(' / ');
  text = squash(text);
  return cell(text.length > 120 ? `${text.slice(0, 117)}...` : text);
}

const row = (cells) => `| ${cells.join(' | ')} |`;
const header = (cells) => `${row(cells)}\n${row(cells.map(() => '---'))}`;

/** Unformatted Markdown summary of the inventory. Prettier output is compared, not this string. */
export function renderSummary(inventory) {
  const items = inventory.items;
  const open = (item) => item.launchBlocking === true && item.assessment !== 'IMPLEMENTED';
  const count = (list, status) => list.filter((item) => item.assessment === status).length;
  const lines = [
    '# v12 requirement reconciliation',
    '',
    'Generated by `node scripts/ci/check-requirements-inventory.mjs --write` from',
    '[V12-REQUIREMENT-INVENTORY.json](V12-REQUIREMENT-INVENTORY.json). Do not edit by hand;',
    '`npm run traceability:check` fails when this file is stale.',
    '',
    `- Source: [CareerScope-v12.md](CareerScope-v12.md), sha256 \`${inventory.sourceSha256}\``,
    `- Assessed: ${inventory.reconciliation.assessedOn} against ${inventory.reconciliation.baseRevision}`,
    `- Clauses: ${items.length}. Launch-blocking gaps: ${items.filter(open).length}.`,
    '- A clause is IMPLEMENTED only when its inventory record cites implementing code and a test',
    '  that a CI script runs. PARTIAL, NOT_IMPLEMENTED and OWNER_EVIDENCE clauses are gaps.',
    '',
    '## Counts per status',
    '',
    header(['Status', 'Clauses', 'Launch-blocking']),
    ...STATUSES.map((status) => {
      const list = items.filter((item) => item.assessment === status);
      return row([status, String(list.length), String(list.filter(open).length)]);
    }),
    row(['Total', String(items.length), String(items.filter(open).length)]),
    '',
    '## Counts per section',
    '',
    header(['Section', 'Heading', 'Total', ...STATUSES, 'Blocking']),
  ];
  const sections = [...new Set(items.map((item) => sectionKey(item.id)))].sort((a, b) => {
    const [x, y] = [sectionOrder(a), sectionOrder(b)];
    return x[0] - y[0] || (x[1] ?? 0) - (y[1] ?? 0);
  });
  for (const section of sections) {
    const list = items.filter((item) => sectionKey(item.id) === section);
    lines.push(
      row([
        section,
        cell(list[0].heading),
        String(list.length),
        ...STATUSES.map((status) => String(count(list, status))),
        String(list.filter(open).length),
      ]),
    );
  }
  lines.push('', '## Launch-blocking gaps', '');
  lines.push(
    'Reading of the source, not an owner waiver: ' +
      cell(inventory.reconciliation.launchBlockingRule),
    '',
    header(['ID', 'Status', 'Clause', 'Gap or evidence needed']),
  );
  for (const item of items.filter(open)) {
    lines.push(
      row([item.id, item.assessment, clauseText(item), cell(item.gap ?? item.ownerEvidenceNeeded)]),
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function formatSummary(root, raw) {
  const file = join(root, SUMMARY);
  const options = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(raw, { ...options, filepath: file });
}

/**
 * The package.json script text that CI runs. Loaded lazily because check-traceability.mjs imports
 * this module for its own run and passes the text in; a static import here would be a cycle.
 */
async function loadScriptText(root) {
  if (!existsSync(join(root, 'package.json'))) return '';
  const { ciExecutedText } = await import('./check-traceability.mjs');
  return ciExecutedText(root);
}

/** Full check: inventory rules plus the generated summary being current. */
export async function checkRequirements(root, scriptText) {
  const text = scriptText ?? (await loadScriptText(root));
  const result = analyzeInventory(root, text);
  if (result.errors.length) return result;
  const inventory = JSON.parse(readFileSync(join(root, INVENTORY), 'utf8'));
  const expected = await formatSummary(root, renderSummary(inventory));
  if (readFileSync(join(root, SUMMARY), 'utf8') !== expected)
    result.errors.push(
      `${SUMMARY} is stale: run node scripts/ci/check-requirements-inventory.mjs --write`,
    );
  return result;
}

export function summaryLine({ total, counts, blocking }) {
  const parts = STATUSES.map((status) => `${counts[status] ?? 0} ${status}`);
  return `${total} clauses (${parts.join(', ')}); ${blocking} launch-blocking gaps`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv.find((value) => value.startsWith('--root='));
  const root = argument
    ? resolve(argument.slice('--root='.length))
    : resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (process.argv.includes('--write')) {
    const inventory = JSON.parse(readFileSync(join(root, INVENTORY), 'utf8'));
    writeFileSync(join(root, SUMMARY), await formatSummary(root, renderSummary(inventory)));
  }
  const result = await checkRequirements(root);
  if (result.errors.length) {
    for (const error of result.errors) console.error(`::error file=${INVENTORY}::${error}`);
    console.error(`FAIL ${result.errors.length} requirement inventory problem(s)`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS v12 requirement inventory: ${summaryLine(result)}\n`);
  }
}
