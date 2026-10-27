import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyze } from './check-traceability.mjs';

const checker = fileURLToPath(new URL('./check-traceability.mjs', import.meta.url));

function verify(rows, extraFiles = ['src/a.ts', 'src/a.test.ts', 'docs/SPEC.md']) {
  const root = mkdtempSync(join(tmpdir(), 'careerscope-trace-'));
  try {
    const matrix = [
      '| ID | Requirement | Source doc | Implementing files | Covering tests |',
      '| -- | -- | -- | -- | -- |',
      ...rows,
    ].join('\n');
    for (const [path, content] of [
      ['docs/TRACEABILITY.md', matrix],
      ...extraFiles.map((p) => [p, '']),
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return analyze(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const row = (tests, implementing = '`src/a.ts`', source = '[SPEC](SPEC.md)') =>
  `| X-1 | Does a thing | ${source} | ${implementing} | ${tests} |`;

test('existing implementing and test files pass; NOT COVERED is counted', () => {
  const result = verify([row('`src/a.test.ts`'), row('NOT COVERED').replace('X-1', 'X-2')]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.rows, 2);
  assert.equal(result.notCovered, 1);
});

test('a missing test file fails', () => {
  assert.match(verify([row('`src/missing.test.ts`')]).errors[0], /test file not found/);
});

test('a missing implementing file fails', () => {
  assert.match(
    verify([row('NOT COVERED', '`src/gone.ts`')]).errors[0],
    /implementing file not found/,
  );
});

test('a non-test path in the tests column, empty tests and a dead source link fail', () => {
  assert.match(verify([row('`src/a.ts`')]).errors[0], /not a test file/);
  assert.match(verify([row('none')]).errors[0], /tests must list test files/);
  assert.match(
    verify([row('NOT COVERED', '`src/a.ts`', '[X](GONE.md)')]).errors[0],
    /source doc not found/,
  );
});

test('duplicate IDs and an empty matrix fail', () => {
  assert.ok(
    verify([row('NOT COVERED'), row('NOT COVERED')]).errors.some((e) => /duplicate ID/.test(e)),
  );
  assert.match(verify([]).errors[0], /no requirement rows/);
});

test('the CLI passes on the real matrix', () => {
  const result = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
