/**
 * The Engineering Control Center must not silently drop work.
 *
 * Two defects motivated these tests, and both were the same shape: an input the
 * board could not interpret was rendered as a category rather than as an error.
 * BLOCKED tickets fell into an unnamed "Not mapped" bucket while the header
 * reported "Nothing in flight", and an open finding with an uncounted severity
 * was excluded from every total on screen.
 *
 * `snapshot()` reads `.ai` RELATIVE to the process cwd, so each test runs
 * against a synthetic `.ai/` in a temp directory. Nothing here touches the real
 * backlog.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// Imported explicitly rather than relied on as a global: scripts/*.test.mjs is
// not in eslint.config.js's node-globals list, so `process` was an undefined
// identifier and `eslint .` — which CI runs — failed on this file. It had never
// been caught because the file is not committed yet.
import process from 'node:process';
import test from 'node:test';
import {
  snapshot,
  BOARD_COLUMNS,
  KNOWN_STATUSES,
  KNOWN_SEVERITIES,
  severityCells,
  SEVERITY_EMPHASIS,
  PAGE,
} from './engineering-ui.mjs';

function withState(backlog, findings, run) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-board-'));
  mkdirSync(join(dir, '.ai'));
  writeFileSync(join(dir, '.ai', 'backlog.json'), JSON.stringify(backlog));
  writeFileSync(join(dir, '.ai', 'findings.json'), JSON.stringify(findings));
  const previous = process.cwd();
  try {
    process.chdir(dir);
    return run();
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

const clean = {
  backlog: { items: [{ id: 'CS-1', title: 'a', status: 'QA', priority: 'P2' }] },
  findings: { items: [{ id: 'F-1', severity: 'P2', status: 'OPEN' }] },
};

test('BLOCKED has its own column and is not an unmapped bucket', () => {
  assert.ok(
    KNOWN_STATUSES.has('BLOCKED'),
    'BLOCKED must be a status the board knows, or blocked work lands in "Not mapped"',
  );
  const blockedColumn = BOARD_COLUMNS.find(([, statuses]) => statuses.includes('BLOCKED'));
  assert.ok(blockedColumn, 'BLOCKED must belong to a column');
  assert.equal(blockedColumn[0], 'Blocked');
  // It must be its OWN column, not folded into another one, or the count that
  // tells the owner to act is hidden inside an unrelated total.
  assert.deepEqual(blockedColumn[1], ['BLOCKED']);
});

test('a clean state produces no board state errors (positive control)', () => {
  const state = withState(clean.backlog, clean.findings, () => snapshot());
  const noise = state.stateErrors.filter((e) => /no column for|does not count/.test(e));
  assert.deepEqual(noise, [], 'valid input must not be reported as a problem');
});

test('an unrecognised STATUS surfaces as a visible error, not a silent bucket', () => {
  const state = withState(
    { items: [{ id: 'CS-999', title: 'bogus', status: 'NOT_A_REAL_STATUS', priority: 'P1' }] },
    clean.findings,
    () => snapshot(),
  );
  const reported = state.stateErrors.filter((e) => e.includes('NOT_A_REAL_STATUS'));
  assert.equal(reported.length, 1, 'an unknown status must be reported exactly once');
  assert.match(reported[0], /has no column for/);
  assert.match(reported[0], /CS-999/, 'the error must name the affected ticket');
});

test('an unrecognised SEVERITY on an open finding surfaces rather than being uncounted', () => {
  const state = withState(
    clean.backlog,
    { items: [{ id: 'F-9', severity: 'P9', status: 'OPEN' }] },
    () => snapshot(),
  );
  const reported = state.stateErrors.filter((e) => e.includes('P9'));
  assert.equal(reported.length, 1);
  assert.match(reported[0], /does not count/);
  assert.match(reported[0], /F-9/);
});

test('a CLOSED finding with an odd severity is not reported, because it is not counted anyway', () => {
  const state = withState(
    clean.backlog,
    { items: [{ id: 'F-8', severity: 'P9', status: 'FIXED' }] },
    () => snapshot(),
  );
  assert.deepEqual(
    state.stateErrors.filter((e) => e.includes('P9')),
    [],
  );
});

test('every severity the strip renders is one the validator knows', () => {
  // This test used to assert only that KNOWN_SEVERITIES matched a shape and
  // equalled itself. It never touched the rendering code, so the property its
  // own comment described — "if KNOWN_SEVERITIES held one the strip does not
  // render, open findings would pass validation and still be invisible" — was
  // described and not tested. Deleting a cell left it green. It now drives the
  // real render function, in both directions.
  const counts = { P0: 3, P1: 2, P2: 1, P3: 7 };
  const rendered = severityCells(
    (s) => counts[s] ?? 0,
    (value, key, cls) => `[${value}|${key}|${cls}]`,
    KNOWN_SEVERITIES,
    SEVERITY_EMPHASIS,
  );

  // Direction 1: every severity the validator knows gets a cell.
  for (const severity of KNOWN_SEVERITIES) {
    assert.ok(
      rendered.includes(`|${severity} open findings|`),
      `${severity} is counted and validated but renders no cell — open findings would be invisible`,
    );
    assert.ok(
      rendered.includes(`[${counts[severity]}|${severity} open findings`),
      `${severity} renders the wrong count`,
    );
  }

  // Direction 2: no cell renders a severity the validator does not know.
  for (const match of rendered.matchAll(/\[\d+\|(P\d) open findings\|/g)) {
    assert.ok(
      KNOWN_SEVERITIES.includes(match[1]),
      `${match[1]} renders a cell but is not in KNOWN_SEVERITIES, so it is counted without being validated`,
    );
  }

  assert.equal(rendered.match(/open findings/g).length, KNOWN_SEVERITIES.length);
});

test('a severity with no styling entry still renders a cell', () => {
  // Styling must never decide whether a number is visible. P2 and P3 have no
  // entry in SEVERITY_EMPHASIS and must still appear.
  for (const severity of KNOWN_SEVERITIES) {
    if (SEVERITY_EMPHASIS[severity]) continue;
    const rendered = severityCells(
      (s) => (s === severity ? 4 : 0),
      (value, key, cls) => `[${value}|${key}|${cls}]`,
      KNOWN_SEVERITIES,
      SEVERITY_EMPHASIS,
    );
    assert.ok(
      rendered.includes(`[4|${severity} open findings|]`),
      `${severity} must render unstyled, not vanish`,
    );
  }
});

test('emphasis is applied only when there is something to emphasise', () => {
  const zero = severityCells(
    () => 0,
    (v, k, cls) => `[${v}|${k}|${cls}]`,
    KNOWN_SEVERITIES,
    SEVERITY_EMPHASIS,
  );
  assert.ok(zero.includes('[0|P0 open findings|]'), 'a zero count must not be styled as bad');
  const some = severityCells(
    () => 1,
    (v, k, cls) => `[${v}|${k}|${cls}]`,
    KNOWN_SEVERITIES,
    SEVERITY_EMPHASIS,
  );
  assert.ok(some.includes('[1|P0 open findings|bad]'));
  assert.ok(some.includes('[1|P1 open findings|warn]'));
});

test('the page the browser receives generates its severity cells, never lists them', () => {
  // Testing severityCells on its own is not enough, and this is the case that
  // proves it: reverting strip() to four literal cell() calls and deleting one
  // restores the exact CS-67 defect while every helper test stays green. The
  // deliverable is the page, so the page is what this asserts.
  assert.match(
    PAGE,
    /severityCells\(n,\s*cell,\s*SEVS,\s*SEVCLS\)/,
    'the strip must build its severity cells from the injected list',
  );

  // No severity label may be written out by hand anywhere in the page.
  const literals = [...PAGE.matchAll(/'(P\d) open findings'/g)].map((m) => m[1]);
  assert.deepEqual(
    literals,
    [],
    `the page hard-codes ${literals.join(', ')} — a severity written by hand is one that can be forgotten`,
  );

  // The list the client iterates must be the one the validator uses.
  const injected = /const SEVS=(\[[^\]]*\]);/.exec(PAGE);
  assert.ok(injected, 'the page must inject the known severities');
  assert.deepEqual(JSON.parse(injected[1]), KNOWN_SEVERITIES);
});
