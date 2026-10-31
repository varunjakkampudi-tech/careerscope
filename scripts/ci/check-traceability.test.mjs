import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyze,
  analyzeFoundations,
  checkReconciliationProse,
  findOrphanTests,
  isDispatchOnly,
  parseFoundations,
} from './check-traceability.mjs';

const checker = fileURLToPath(new URL('./check-traceability.mjs', import.meta.url));

const defaultScripts = { 'test:unit': 'node --test src/a.test.ts' };

function verify(
  rows,
  extraFiles = ['src/a.ts', 'src/a.test.ts', 'docs/SPEC.md'],
  scripts = defaultScripts,
) {
  const root = mkdtempSync(join(tmpdir(), 'careerscope-trace-'));
  try {
    const matrix = [
      '| ID | Requirement | Source doc | Implementing files | Covering tests |',
      '| -- | -- | -- | -- | -- |',
      ...rows,
    ].join('\n');
    for (const [path, content] of [
      ['docs/TRACEABILITY.md', matrix],
      ['package.json', JSON.stringify({ scripts })],
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

test('a test file that no CI script runs fails unless it is marked (manual)', () => {
  const files = ['src/a.ts', 'src/a.test.ts', 'src/b.test.ts', 'docs/SPEC.md'];
  const unlisted = verify([row('`src/b.test.ts`')], files);
  assert.equal(unlisted.errors.length, 1);
  assert.match(unlisted.errors[0], /not run by any CI script.*src\/b\.test\.ts/);
  assert.deepEqual(verify([row('`src/b.test.ts` (manual)')], files).errors, []);
  // The marker applies to the path it follows, not to the whole row.
  const mixed = verify([row('`src/a.test.ts`, `src/b.test.ts`')], files);
  assert.equal(mixed.errors.length, 1);
  assert.match(mixed.errors[0], /src\/b\.test\.ts/);
});

test('scripts reached through npm run from a CI root count as run by CI', () => {
  const files = ['src/a.ts', 'src/b.test.ts', 'docs/SPEC.md'];
  const scripts = { 'gates:test': 'npm run inner', inner: 'node --test src/b.test.ts' };
  assert.deepEqual(verify([row('`src/b.test.ts`')], files, scripts).errors, []);
  // A script that CI does not reach does not count.
  const orphan = { 'test:unit': 'true', 'test:backfill': 'node --test src/b.test.ts' };
  assert.match(verify([row('`src/b.test.ts`')], files, orphan).errors[0], /not run by any CI/);
});

test('a (manual) marker on a file that CI runs is rejected', () => {
  assert.match(
    verify([row('`src/a.test.ts` (manual)')]).errors[0],
    /marked \(manual\) but a CI script runs it/,
  );
});

const FOUNDATION_IDS = Array.from({ length: 15 }, (_, i) => '1.' + String(i + 1).padStart(2, '0'));

/** One register section; `over` replaces or (with null) removes a field. */
function section(id, over = {}) {
  const fields = {
    Status: 'Complete',
    Evidence: '`src/a.ts`, `src/a.test.ts`',
    Gate: 'CI job `Quality gates`',
    Verify: '`npm test`',
    ...over,
  };
  const lines = Object.entries(fields)
    .filter(([, value]) => value !== null)
    .map(([name, value]) => '- **' + name + ':** ' + value);
  return ['## ' + id + ' Item ' + id, '', ...lines, ''].join('\n');
}

/** analyzeFoundations on a throwaway root whose register is built from per-item overrides. */
function verifyFoundations({
  overrides = {},
  ids = FOUNDATION_IDS,
  raw,
  files = ['src/a.ts', 'src/a.test.ts'],
  scripts = defaultScripts,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'careerscope-foundations-'));
  try {
    const register =
      raw ??
      ['# Foundations register', '', ...ids.map((id) => section(id, overrides[id]))].join('\n');
    for (const [path, content] of [
      ['docs/FOUNDATIONS.md', register],
      ['package.json', JSON.stringify({ scripts })],
      ...files.map((p) => [p, '']),
    ]) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return analyzeFoundations(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a register with exactly items 1.01 to 1.15, each complete, passes', () => {
  const result = verifyFoundations();
  assert.deepEqual(result.errors, []);
  assert.equal(result.items, 15);
  assert.equal(result.complete, 15);
});

test('the register fails unless it has exactly 15 items in order', () => {
  assert.match(
    verifyFoundations({ ids: FOUNDATION_IDS.slice(0, 14) }).errors[0],
    /exactly the 15 items.*found 14/,
  );
  assert.match(verifyFoundations({ ids: [...FOUNDATION_IDS, '1.16'] }).errors[0], /found 16/);
  assert.match(
    verifyFoundations({ ids: [...FOUNDATION_IDS.slice(0, 14), '1.14'] }).errors[0],
    /exactly the 15 items/,
  );
  assert.match(
    verifyFoundations({ ids: [...FOUNDATION_IDS].reverse() }).errors[0],
    /exactly the 15 items/,
  );
  assert.match(verifyFoundations({ raw: '# empty' }).errors[0], /found 0: none/);
});

test('an item without a status, evidence, gate or verify line fails', () => {
  for (const name of ['Status', 'Evidence', 'Gate', 'Verify']) {
    const { errors } = verifyFoundations({ overrides: { 1.05: { [name]: null } } });
    assert.ok(
      errors.some((e) => e.startsWith('1.05:') && e.includes(name)),
      name + ': ' + errors.join(' | '),
    );
  }
  assert.match(
    verifyFoundations({ overrides: { 1.05: { Status: 'Done' } } }).errors[0],
    /1\.05: Status must be one of Complete, Open, Excluded/,
  );
  assert.match(
    verifyFoundations({ overrides: { 1.05: { Evidence: 'none' } } }).errors[0],
    /1\.05: Evidence must cite files/,
  );
});

test('an Open item needs a gap and a Complete item must not carry one', () => {
  assert.match(
    verifyFoundations({ overrides: { 1.03: { Status: 'Open' } } }).errors[0],
    /1\.03: an Open item must state its Gap/,
  );
  const open = verifyFoundations({
    overrides: { 1.03: { Status: 'Open', Gap: 'Owner has not enabled protection.' } },
  });
  assert.deepEqual(open.errors, []);
  assert.equal(open.complete, 14);
  assert.match(
    verifyFoundations({ overrides: { 1.03: { Gap: 'left over' } } }).errors[0],
    /1\.03: a Complete item must not carry a Gap/,
  );
});

test('a Complete item citing a file that does not exist fails', () => {
  const { errors } = verifyFoundations({
    overrides: { 1.07: { Evidence: '`src/a.test.ts`, `src/gone.ts`' } },
  });
  assert.deepEqual(errors, ['1.07: evidence file not found: src/gone.ts']);
});

test('a Complete item citing a test that no CI script runs fails; Open may mark it (manual)', () => {
  const files = ['src/a.ts', 'src/a.test.ts', 'src/b.test.ts'];
  const unrun = { Evidence: '`src/a.test.ts`, `src/b.test.ts`' };
  const complete = verifyFoundations({ files, overrides: { 1.09: unrun } });
  assert.deepEqual(complete.errors, [
    '1.09: Complete item cites a test that no CI script runs: src/b.test.ts',
  ]);
  const onlyUnrun = verifyFoundations({
    files,
    overrides: { 1.09: { Evidence: '`src/b.test.ts`' } },
  });
  assert.ok(
    onlyUnrun.errors.some((e) =>
      /1\.09: a Complete item must cite at least one test that a CI script runs/.test(e),
    ),
  );
  const open = {
    Status: 'Open',
    Gap: 'Needs the host.',
    Evidence: '`src/a.test.ts`, `src/b.test.ts` (manual)',
  };
  assert.deepEqual(verifyFoundations({ files, overrides: { 1.09: open } }).errors, []);
  assert.match(
    verifyFoundations({
      files,
      overrides: { 1.09: { ...open, Evidence: '`src/a.test.ts`, `src/b.test.ts`' } },
    }).errors[0],
    /1\.09: test is not run by any CI script/,
  );
});

test('a Complete item with no test at all fails', () => {
  const { errors } = verifyFoundations({ overrides: { 1.02: { Evidence: '`src/a.ts`' } } });
  assert.deepEqual(errors, [
    '1.02: a Complete item must cite at least one test that a CI script runs',
  ]);
});

test('parseFoundations reads wrapped field values', () => {
  const [one] = parseFoundations('## 1.01 T\n\n- **Status:** Open\n- **Gap:** first\n  second\n');
  assert.deepEqual(one.fields.Gap, ['first second']);
});

test('the Item 1.02 prose and the register must quote the inventory counts', async () => {
  const real = fileURLToPath(new URL('../..', import.meta.url));
  assert.deepEqual(await checkReconciliationProse(real), []);
  const stale = async (path, from, to) => {
    const root = mkdtempSync(join(tmpdir(), 'careerscope-prose-'));
    try {
      for (const file of [
        'docs/TRACEABILITY.md',
        'docs/FOUNDATIONS.md',
        'docs/requirements/CareerScope-v12.md',
        'docs/requirements/V12-REQUIREMENT-INVENTORY.json',
        'docs/requirements/V12-RECONCILIATION.md',
      ]) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        let text = readFileSync(join(real, file), 'utf8');
        if (file === path) {
          assert.ok(text.includes(from));
          text = text.replace(from, () => to);
        }
        writeFileSync(join(root, file), text);
      }
      return await checkReconciliationProse(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  const trace = await stale('docs/TRACEABILITY.md', '67 IMPLEMENTED', '68 IMPLEMENTED');
  assert.equal(trace.length, 1);
  assert.match(
    trace[0],
    /docs\/TRACEABILITY\.md must quote the inventory counts exactly: "319 clauses \(67 IMPLEMENTED/,
  );
  const claim = await stale(
    'docs/TRACEABILITY.md',
    '165 launch-blocking gaps',
    '0 launch-blocking gaps',
  );
  assert.match(claim[0], /TRACEABILITY/);
  const foundations = await stale('docs/FOUNDATIONS.md', '319 clauses', '300 clauses');
  assert.match(foundations[0], /docs\/FOUNDATIONS\.md must quote/);
});

test('the Foundations register passes in the real repository', () => {
  const real = fileURLToPath(new URL('../..', import.meta.url));
  const result = analyzeFoundations(real);
  assert.deepEqual(result.errors, []);
  assert.equal(result.items, 15);
});

test('the CLI passes on the real matrix', () => {
  const result = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

/** findOrphanTests on a throwaway (non-git) root with the given files, scripts, workflow and register. */
function orphans({ files, scripts = defaultScripts, workflow, register }) {
  const root = mkdtempSync(join(tmpdir(), 'careerscope-orphan-'));
  try {
    const entries = [['package.json', JSON.stringify({ scripts })], ...files.map((p) => [p, ''])];
    if (workflow !== undefined) entries.push(['.github/workflows/ci.yml', workflow]);
    if (register !== undefined) entries.push(['docs/FOUNDATIONS.md', register]);
    for (const [path, content] of entries) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return findOrphanTests(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a test file that no CI script, workflow step or manual marker names is an orphan', () => {
  const files = [
    'src/a.test.ts',
    'src/orphan.test.mjs',
    'src/deep/x.integration.test.ts',
    'src/a.ts',
  ];
  assert.deepEqual(orphans({ files }), ['src/deep/x.integration.test.ts', 'src/orphan.test.mjs']);
  // A longer path that merely ends with the same name does not count as a reference.
  assert.deepEqual(
    orphans({ files: ['a.test.ts'], scripts: { 'test:unit': 'node --test src/a.test.ts' } }),
    ['a.test.ts'],
  );
});

test('a workflow step, a script reached through a workflow npm run, or a (manual) marker clears an orphan', () => {
  const files = ['src/a.test.ts', 'src/w.test.mjs', 'src/n.test.ts', 'src/m.test.js'];
  const scripts = { ...defaultScripts, 'test:extra': 'node --test src/n.test.ts' };
  const workflow = [
    'steps:',
    '  - run: node --test src/w.test.mjs',
    '  - run: npm run test:extra',
  ].join('\n');
  assert.deepEqual(orphans({ files, scripts, workflow }), ['src/m.test.js']);
  const register =
    '## 1.01 T' + String.fromCharCode(10) + '- **Evidence:** `src/m.test.js` (manual)';
  assert.deepEqual(orphans({ files, scripts, workflow, register }), []);
});

test('a test wired only into a dispatch-only step or job is an orphan unless marked (manual)', () => {
  const files = ['src/a.test.ts', 'src/d.test.mjs', 'src/j.test.mjs', 'src/p.test.mjs'];
  const workflow = [
    'jobs:',
    '  checks:',
    '    steps:',
    '      - run: node --test src/p.test.mjs',
    "      - if: github.event_name == 'workflow_dispatch' && inputs.suite == 'all'",
    '        run: node --test src/d.test.mjs',
    '  manual:',
    "    if: github.event_name == 'workflow_dispatch'",
    '    steps:',
    '      - run: node --test src/j.test.mjs',
  ].join('\n');
  assert.deepEqual(orphans({ files, workflow }), ['src/d.test.mjs', 'src/j.test.mjs']);
  const register =
    '## 1.01 T' +
    String.fromCharCode(10) +
    '- **Evidence:** `src/d.test.mjs` (manual), `src/j.test.mjs` (manual)';
  assert.deepEqual(orphans({ files, workflow, register }), []);
});

test('a step that also admits push, pull_request or a non-dispatch event is not dispatch-only', () => {
  assert.equal(isDispatchOnly("github.event_name == 'workflow_dispatch'"), true);
  assert.equal(isDispatchOnly(undefined), false);
  assert.equal(isDispatchOnly("github.event_name != 'workflow_dispatch' || inputs.x"), false);
  assert.equal(
    isDispatchOnly("github.event_name == 'push' || github.event_name == 'workflow_dispatch'"),
    false,
  );
});

test('the real repository has no orphan test files', () => {
  assert.deepEqual(findOrphanTests(fileURLToPath(new URL('../..', import.meta.url))), []);
});

test('an Excluded item needs a gap that names the owner decision', () => {
  assert.match(
    verifyFoundations({ overrides: { 1.12: { Status: 'Excluded' } } }).errors[0],
    /1\.12: an Excluded item must state its Gap/,
  );
  assert.deepEqual(
    verifyFoundations({
      overrides: { 1.12: { Status: 'Excluded', Gap: 'Owner excluded the host check.' } },
    }).errors,
    [],
  );
});
