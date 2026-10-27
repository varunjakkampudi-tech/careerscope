#!/usr/bin/env node
// Validates docs/TRACEABILITY.md: every row must name implementing files that
// exist, and either covering test files that exist or the literal NOT COVERED.
import { existsSync, readFileSync } from 'node:fs';
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

export function analyze(root) {
  const errors = [];
  const file = join(root, MATRIX);
  if (!existsSync(file)) return { errors: [`${MATRIX} is missing`], rows: 0, notCovered: 0 };
  const seen = new Set();
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
    for (const path of testFiles) {
      if (!TEST_PATH.test(path)) fail(`not a test file: ${path}`);
      else if (!existsSync(join(root, path))) fail(`test file not found: ${path}`);
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
  if (errors.length) {
    for (const error of errors) console.error(`::error file=${MATRIX}::${error}`);
    console.error(`FAIL ${errors.length} traceability problem(s)`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`PASS traceability: ${rows} rows, ${notCovered} NOT COVERED\n`);
  }
}
