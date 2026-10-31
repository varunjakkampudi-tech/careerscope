import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  INVENTORY,
  SOURCE,
  SUMMARY,
  analyzeInventory,
  checkRequirements,
  matchesSourceLine,
  renderSummary,
  workflowRunText,
} from './check-requirements-inventory.mjs';
import { checkDocsIndex, ciExecutedText } from './check-traceability.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const checker = fileURLToPath(new URL('./check-requirements-inventory.mjs', import.meta.url));
const scriptText = ciExecutedText(repo);
const realInventory = JSON.parse(readFileSync(join(repo, INVENTORY), 'utf8'));

/** A throwaway checkout holding the requirement docs and every file the inventory cites. */
async function withFixture(mutate, run) {
  const root = mkdtempSync(join(tmpdir(), 'careerscope-v12-'));
  const copy = (path) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    cpSync(join(repo, path), join(root, path));
  };
  try {
    for (const path of [SOURCE, SUMMARY, '.github/workflows/ci.yml']) copy(path);
    const inventory = structuredClone(realInventory);
    const cited = new Set();
    for (const item of inventory.items)
      for (const key of ['implementation', 'tests', 'checks'])
        for (const ref of item.evidence?.[key] ?? []) cited.add(ref.replace(/:\d+$/, ''));
    for (const path of cited) if (existsSync(join(repo, path))) copy(path);
    mutate?.({ inventory, root });
    writeFileSync(join(root, INVENTORY), JSON.stringify(inventory, null, 2));
    return await run(root, inventory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const find = (inventory, assessment) => inventory.items.find((i) => i.assessment === assessment);
const errorsFor = (mutate) =>
  withFixture(mutate, (root) => analyzeInventory(root, scriptText).errors.join('\n'));

test('the committed inventory, source digest and summary pass the full check', async () => {
  const result = await checkRequirements(repo, scriptText);
  assert.deepEqual(result.errors, []);
  assert.equal(result.total, 319);
  assert.equal(Object.keys(result.counts).includes('NOT_ASSESSED'), false);
});

test('a fixture copy of the inventory has no problems before mutation', async () => {
  assert.equal(await errorsFor(), '');
});

test('a NOT_ASSESSED item fails', async () => {
  const errors = await errorsFor(({ inventory }) => {
    inventory.items[0].assessment = 'NOT_ASSESSED';
  });
  assert.match(errors, /V12-1-001: still NOT_ASSESSED/);
});

test('an edited source document fails the sha256 check', async () => {
  const errors = await errorsFor(({ root }) => {
    const file = join(root, SOURCE);
    writeFileSync(file, `${readFileSync(file, 'utf8')} `);
  });
  assert.match(errors, /sha256 .* does not match inventory sourceSha256/);
});

test('an IMPLEMENTED item without a test fails', async () => {
  let id;
  const errors = await errorsFor(({ inventory }) => {
    const item = find(inventory, 'IMPLEMENTED');
    id = item.id;
    item.evidence.tests = [];
  });
  assert.match(errors, new RegExp(`${id}: IMPLEMENTED needs evidence.tests`));
});

test('an IMPLEMENTED item without implementing code fails', async () => {
  let id;
  const errors = await errorsFor(({ inventory }) => {
    const item = find(inventory, 'IMPLEMENTED');
    id = item.id;
    item.evidence.implementation = [];
  });
  assert.match(errors, new RegExp(`${id}: IMPLEMENTED needs evidence.implementation`));
});

test('a cited test that no CI script runs fails', async () => {
  const errors = await errorsFor(({ inventory, root }) => {
    mkdirSync(join(root, 'scripts/ci'), { recursive: true });
    writeFileSync(join(root, 'scripts/ci/orphan.test.mjs'), '');
    find(inventory, 'IMPLEMENTED').evidence.tests = ['scripts/ci/orphan.test.mjs'];
  });
  assert.match(
    errors,
    /test is not run by any CI script or workflow: scripts\/ci\/orphan.test.mjs/,
  );
});

test('a missing file and an out-of-range line fail', async () => {
  const errors = await errorsFor(({ inventory }) => {
    const item = find(inventory, 'IMPLEMENTED');
    item.evidence.implementation = [
      'no/such/file.ts:1',
      'docs/requirements/CareerScope-v12.md:999999',
    ];
  });
  assert.match(errors, /implementation file not found: no\/such\/file.ts/);
  assert.ok(
    errors.includes(
      'implementation line out of range: docs/requirements/CareerScope-v12.md:999999',
    ),
  );
});

test('gap, launchBlocking, owner evidence and quote requirements are enforced', async () => {
  const errors = await errorsFor(({ inventory }) => {
    const partial = find(inventory, 'PARTIAL');
    partial.gap = '';
    const owner = find(inventory, 'OWNER_EVIDENCE');
    delete owner.ownerEvidenceNeeded;
    const missing = find(inventory, 'NOT_IMPLEMENTED');
    delete missing.launchBlocking;
    find(inventory, 'OUT_OF_SCOPE_POST_LAUNCH').sourceQuote = 'text that the source never says';
  });
  assert.match(errors, /PARTIAL needs a gap/);
  assert.match(errors, /OWNER_EVIDENCE needs ownerEvidenceNeeded/);
  assert.match(errors, /NOT_IMPLEMENTED needs launchBlocking/);
  assert.match(errors, /sourceQuote is not verbatim in the source section 11/);
});

test('a quote from outside the post-launch section is refused', async () => {
  const errors = await errorsFor(({ inventory }) => {
    find(inventory, 'OUT_OF_SCOPE_POST_LAUNCH').sourceQuote = 'Email OTP via Resend';
  });
  assert.match(errors, /sourceQuote is not verbatim in the source section 11/);
});

test('an item whose text no longer matches its source line fails', async () => {
  const errors = await errorsFor(({ inventory }) => {
    inventory.items[1].text = 'a different clause';
  });
  assert.match(errors, /V12-1-002: text does not match source line 17/);
});

test('a stale reconciliation summary fails', async () => {
  const stale = await withFixture(
    ({ root }) => writeFileSync(join(root, SUMMARY), '# stale\n'),
    (root) => checkRequirements(root, scriptText),
  );
  assert.match(stale.errors.join('\n'), /V12-RECONCILIATION.md is stale/);
  assert.match(renderSummary(realInventory), /## Launch-blocking gaps/);
});

test('the CLI passes on the real repository and reports the counts', async () => {
  const result = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS v12 requirement inventory: 319 clauses/);
});

test('deleting a clause and lowering totalSourceItems still fails against the pinned count', async () => {
  const errors = await errorsFor(({ inventory }) => {
    inventory.items.pop();
    inventory.totalSourceItems = inventory.items.length;
  });
  assert.match(errors, /inventory has 318 items, expected 319 clauses/);
  assert.match(errors, /totalSourceItems 318 does not equal the expected 319/);
});

test('a wrong totalSourceItems alone fails', async () => {
  const errors = await errorsFor(({ inventory }) => {
    inventory.totalSourceItems = 318;
  });
  assert.match(errors, /totalSourceItems 318 does not equal the expected 319/);
});

test('a duplicated or missing sourceLine fails', async () => {
  const duplicated = await errorsFor(({ inventory }) => {
    inventory.items[1].sourceLine = inventory.items[0].sourceLine;
  });
  assert.match(duplicated, /sourceLine \d+ is used by more than one item/);
  assert.match(duplicated, /318 distinct integer sourceLine values across 319 items/);
  const missingLine = await errorsFor(({ inventory }) => {
    delete inventory.items[2].sourceLine;
  });
  assert.match(missingLine, /318 distinct integer sourceLine values across 319 items/);
});

test('the pinned digest rejects a source and inventory edited together', async () => {
  const errors = await errorsFor(({ inventory, root }) => {
    const file = join(root, SOURCE);
    const edited = `${readFileSync(file, 'utf8')}\n`;
    writeFileSync(file, edited);
    inventory.sourceSha256 = createHash('sha256').update(edited).digest('hex');
  });
  assert.match(errors, /does not match the pinned SOURCE_SHA256/);
  assert.doesNotMatch(errors, /does not match inventory sourceSha256/);
});

/** Points item 0 at a line the mutation appended to the source, and returns the errors. */
const errorsForAppendedLine = (appended, text = 'a clause that is not in the source') =>
  errorsFor(({ inventory, root }) => {
    const file = join(root, SOURCE);
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, `${before.replace(/\n*$/, '\n')}${appended}\n`);
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    inventory.items[0].sourceLine = lines.lastIndexOf(appended) + 1;
    inventory.items[0].text = text;
  });

test('a blank source line never matches a clause', async () => {
  assert.match(await errorsForAppendedLine(''), /V12-1-001: text does not match source line/);
});

test('a bare "##" or "|" source line never matches a clause', async () => {
  assert.match(await errorsForAppendedLine('##'), /V12-1-001: text does not match source line/);
  assert.match(await errorsForAppendedLine('|'), /V12-1-001: text does not match source line/);
  assert.match(
    await errorsForAppendedLine('## Real heading', '##'),
    /V12-1-001: text does not match source line/,
  );
});

test('matchesSourceLine needs meaningful text and a minimum length for substring matches', () => {
  assert.equal(matchesSourceLine(undefined, 'x'), false);
  assert.equal(matchesSourceLine('', 'anything'), false);
  assert.equal(matchesSourceLine('   ', ''), false);
  assert.equal(matchesSourceLine('##', 'a clause'), false);
  assert.equal(matchesSourceLine('|', 'a | b'), false);
  assert.equal(matchesSourceLine('- Email OTP via Resend', 'Email OTP via Resend'), true);
  assert.equal(matchesSourceLine('| a | b |', 'a | b'), false, 'two letters are too short');
  assert.equal(matchesSourceLine('| ab | cd |', '| ab | cd |'), true, 'equal lines always match');
  assert.equal(matchesSourceLine('Resend', 'Email OTP via Resend'), true);
  assert.equal(matchesSourceLine('Re', 'Email OTP via Resend'), false);
});

const ciWorkflow = [
  'on:',
  '  push:',
  '    paths:',
  '      - scripts/ci/orphan.test.mjs',
  'jobs:',
  '  a:',
  '    steps:',
  '      # run: node --test scripts/ci/orphan.test.mjs',
  '      - run: echo hi # scripts/ci/orphan.test.mjs',
  '      - name: scripts/ci/orphan.test.mjs',
  '        run: |',
  '          # node --test scripts/ci/orphan.test.mjs',
  '          echo x',
  '      - run: echo done',
].join('\n');

/** Errors when item 0 is IMPLEMENTED with only the orphan test, under the given ci.yml. */
const errorsForWorkflow = (workflow) =>
  errorsFor(({ inventory, root }) => {
    mkdirSync(join(root, 'scripts/ci'), { recursive: true });
    writeFileSync(join(root, 'scripts/ci/orphan.test.mjs'), '');
    const ci = join(root, '.github/workflows/ci.yml');
    writeFileSync(
      ci,
      `${readFileSync(ci, 'utf8')}
${workflow}
`,
    );
    find(inventory, 'IMPLEMENTED').evidence.tests = ['scripts/ci/orphan.test.mjs'];
  });

test('a test named only in a workflow comment, name or paths filter is not run by CI', async () => {
  const errors = await errorsForWorkflow(ciWorkflow);
  assert.match(
    errors,
    /test is not run by any CI script or workflow: scripts\/ci\/orphan.test.mjs/,
  );
  assert.equal(workflowRunText(ciWorkflow).includes('orphan'), false);
});

test('a test named in a non-comment run step counts as run by CI', async () => {
  const inline = `${ciWorkflow}\n      - run: node --test scripts/ci/orphan.test.mjs\n`;
  assert.doesNotMatch(await errorsForWorkflow(inline), /orphan/);
  const block = `${ciWorkflow}\n      - run: |\n          echo a\n          node --test scripts/ci/orphan.test.mjs\n`;
  assert.doesNotMatch(await errorsForWorkflow(block), /orphan/);
});

test('docs/README.md must link every document under docs/', () => {
  assert.deepEqual(checkDocsIndex(repo), []);
  const root = mkdtempSync(join(tmpdir(), 'careerscope-docs-'));
  try {
    mkdirSync(join(root, 'docs/sub'), { recursive: true });
    writeFileSync(join(root, 'docs/README.md'), '[a](A.md) [s](sub/S.md#top)\n');
    for (const name of ['A.md', 'sub/S.md', 'B.md', 'sub/C.json'])
      writeFileSync(join(root, 'docs', name), '');
    assert.deepEqual(checkDocsIndex(root), [
      'docs/README.md does not link docs/B.md',
      'docs/README.md does not link docs/sub/C.json',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
