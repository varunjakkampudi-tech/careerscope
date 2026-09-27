import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import test from 'node:test';
import { AREAS } from './engineering.mjs';
import { CHECKS, childEnvironment, runCheck, testTotals } from './engineering-runner.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'engineering-runner-'));
  try {
    for (const directory of ['scripts', '.git', '.ai', '.github/agents'])
      mkdirSync(join(root, directory), { recursive: true });
    writeFileSync(join(root, '.git/HEAD'), 'a'.repeat(40));
    writeFileSync(join(root, '.github/agents/builder.agent.md'), 'synthetic');
    writeFileSync(join(root, 'scope.txt'), 'synthetic scope');
    const time = '2026-01-01T00:00:00.000Z';
    const state = {
      schemaVersion: 1,
      objective: 'Synthetic runner',
      status: 'IN_PROGRESS',
      revision: 'a'.repeat(40),
      createdAt: time,
      updatedAt: time,
      blockedReason: null,
      tasks: [
        {
          id: 'runner',
          owner: 'builder',
          files: ['scope.txt'],
          dependencies: [],
          attempts: 1,
          attemptLimit: 3,
          status: 'IN_PROGRESS',
          acceptanceCriteria: [{ id: 'check', description: 'Synthetic' }],
          evidence: [],
          review: null,
          createdAt: time,
          updatedAt: time,
          blockedReason: null,
        },
      ],
    };
    writeFileSync(join(root, '.ai/engineering.json'), JSON.stringify(state));
    writeFileSync(
      join(root, 'quality-gates.json'),
      JSON.stringify({
        schemaVersion: 1,
        areas: Object.fromEntries(
          AREAS.map((area) => [
            area,
            {
              status: 'NOT_STARTED',
              applicability: { applicable: true, reason: null },
              responsibleAgent: 'builder',
              evidence: [],
              checks: [{ id: 'check', description: 'Synthetic' }],
              knownIssues: [],
              lastReviewed: null,
              reviewer: null,
            },
          ]),
        ),
      }),
    );
    for (const name of ['engineering.mjs', 'engineering-contract.mjs', 'engineering-runner.mjs'])
      copyFileSync(fileURLToPath(new URL(name, import.meta.url)), join(root, 'scripts', name));
    const script = (source) => writeFileSync(join(root, 'scripts/check-agents.mjs'), source);
    const tests = (source) => {
      for (const name of [
        'engineering.test.mjs',
        'engineering-contract.test.mjs',
        'engineering-hook.test.mjs',
      ])
        writeFileSync(join(root, 'scripts', name), source);
    };
    run({ root, script, tests });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('runner uses fixed immutable registry without self-test recursion', () => {
  assert.equal(Object.isFrozen(CHECKS), true);
  assert.equal(
    CHECKS['engineering-tests'].some((argument) => argument.includes('runner.test')),
    false,
  );
  assert.deepEqual(
    childEnvironment({
      PATH: 'bin',
      SystemRoot: 'windows',
      TEMP: 'temp',
      API_KEY: 'secret',
      NODE_OPTIONS: '--import evil',
      NODE_TEST_CONTEXT: 'child-v8',
      HOME: 'private',
    }),
    { PATH: 'bin', SystemRoot: 'windows', TEMP: 'temp' },
  );
});

test('runner records process binding and hashes without exposing output', () =>
  fixture(({ root, script }) => {
    script('console.log("SYNTHETIC_SECRET"); console.error("PRIVATE_OUTPUT")');
    const before = readFileSync(join(root, '.ai/engineering.json'), 'utf8');
    const result = runCheck('agent-validator', { root });
    assert.equal(result.success, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.command[0], process.execPath);
    assert.equal(result.revision, 'a'.repeat(40));
    assert.match(result.digest, /^[a-f0-9]{64}$/);
    assert.equal(new Date(result.startedAt).toISOString(), result.startedAt);
    assert.ok(result.endedAt >= result.startedAt);
    assert.ok(result.stdout.bytes > 0);
    assert.equal(JSON.stringify(result).includes('SYNTHETIC_SECRET'), false);
    assert.equal(JSON.stringify(result).includes('PRIVATE_OUTPUT'), false);
    assert.equal(readFileSync(join(root, '.ai/engineering.json'), 'utf8'), before);
  }));

for (const [name, source, options, expected] of [
  ['failed process', 'process.exitCode = 1', {}, 'FAIL'],
  [
    'truncated process',
    'process.stdout.write("x".repeat(100000))',
    { outputLimit: 1024 },
    'TRUNCATED',
  ],
  ['timeout', 'setInterval(() => {}, 1000)', { timeout: 100 }, 'TIMEOUT'],
  ['changed scope', 'require("node:fs").writeFileSync("scope.txt", "changed")', {}, 'FAIL'],
  [
    'changed command',
    'require("node:fs").writeFileSync("scripts/check-agents.mjs", "changed")',
    {},
    'FAIL',
  ],
])
  test(`runner cannot pass ${name}`, () =>
    fixture(({ root, script }) => {
      script(source.replace('require("node:fs")', '(await import("node:fs"))'));
      const result = runCheck('agent-validator', { root, ...options });
      assert.equal(result.success, false);
      assert.equal(result.result, expected);
      if (name === 'changed scope') assert.equal(result.bindingUnchanged, false);
    }));

for (const [name, source, pass] of [
  ['positive tests', 'import test from "node:test"; test("synthetic", () => {});', true],
  ['skipped tests', 'import test from "node:test"; test.skip("synthetic", () => {});', false],
  ['todo tests', 'import test from "node:test"; test.todo("synthetic");', false],
  ['zero tests', '', false],
  [
    'failed tests',
    'import test from "node:test"; test("synthetic", () => { throw Error("private"); });',
    false,
  ],
  [
    'cancelled tests',
    'import test from "node:test"; test("synthetic", { timeout: 10 }, () => new Promise(resolve => setTimeout(resolve, 100)));',
    false,
  ],
])
  test(`runner enforces test totals: ${name}`, () =>
    fixture(({ root, tests }) => {
      tests(source);
      const result = runCheck('engineering-tests', { root });
      assert.equal(result.success, pass, JSON.stringify(result));
      if (pass) assert.equal(result.totals.pass, 3);
      else if (name !== 'zero tests') {
        assert.equal(result.totals.tests, 3);
        assert.equal(result.totals.pass, 0);
        const outcome = {
          'skipped tests': 'skipped',
          'todo tests': 'todo',
          'failed tests': 'fail',
          'cancelled tests': 'cancelled',
        }[name];
        assert.equal(result.totals[outcome], 3);
      }
    }));

test('runner rejects unknown IDs, malformed bounds and malformed artifacts before spawn', () =>
  fixture(({ root, script }) => {
    script('throw Error("should not run")');
    for (const id of ['unknown', '__proto__', '../script', null, {}, 'agent-validator; echo bad'])
      assert.throws(() => runCheck(id, { root }), /Unknown/);
    assert.throws(() => runCheck('agent-validator', { root, timeout: 0 }), /bounds/);
    assert.throws(() => runCheck('agent-validator', { root: '.' }), /cwd/);
    writeFileSync(join(root, '.ai/engineering.json'), '{');
    assert.throws(() => runCheck('agent-validator', { root }));
  }));

const report = [
  'TAP version 13',
  '# Subtest: synthetic',
  'ok 1 - synthetic',
  '1..1',
  '# tests 1',
  '# suites 0',
  '# pass 1',
  '# fail 0',
  '# cancelled 0',
  '# skipped 0',
  '# todo 0',
  '# duration_ms 1',
  '',
].join('\n');

test('TAP parser rejects an explicit bailout after valid totals', () => {
  assert.equal(testTotals(report).pass, 1);
  assert.equal(testTotals(`${report}Bail out! aborted\n`), null);
  assert.equal(testTotals(report).pass, 1);
});

test('TAP parser reconciles totals with actual outcomes', () => {
  assert.equal(testTotals(report).pass, 1);
  assert.equal(
    testTotals(report.replace('# tests 1', '# tests 2').replace('# pass 1', '# pass 2')),
    null,
  );
  assert.equal(testTotals(report).pass, 1);
});

test('TAP parser accepts genuine Node nested suites and test parents', () => {
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '--test-reporter=tap',
      '-e',
      `
    import { describe, it, test } from 'node:test';
    describe('outer suite', () => {
      describe('inner suite', () => {
        it('first leaf', () => {});
        it('second leaf', () => {});
      });
      describe('empty suite', () => {});
    });
    test('parent', async (context) => {
      await context.test('branch', async (context) => {
        await context.test('third leaf', () => {});
      });
    });
  `,
    ],
    { encoding: 'utf8', env: childEnvironment(process.env) },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(
    testTotals(child.stdout),
    {
      tests: 5,
      pass: 5,
      fail: 0,
      cancelled: 0,
      skipped: 0,
      todo: 0,
    },
    child.stdout,
  );
  for (const malformed of [
    child.stdout.replace('        1..2', '        1..3'),
    child.stdout.replace('        1..2', '        1..2\n        1..2'),
    child.stdout.replace('        1..2', ''),
    child.stdout.replace('ok 2 - second leaf', 'ok 3 - second leaf'),
    child.stdout.replace('# suites 3', '# suites 2'),
    child.stdout.replace('# tests 5', '# tests 8').replace('# pass 5', '# pass 8'),
    child.stdout.replace("type: 'suite'", "type: 'unknown'"),
    child.stdout.replace("type: 'suite'", 'type: suite'),
    child.stdout.replace('          ...', '          missing'),
    child.stdout.replace('        1..2', '        Bail out! aborted\n        1..2'),
  ]) {
    assert.notEqual(malformed, child.stdout);
    assert.equal(testTotals(malformed), null, malformed);
  }
  assert.equal(testTotals(child.stdout.replaceAll('\n', '\r\n')).pass, 5);
  assert.equal(testTotals(child.stdout).pass, 5);
});

test('TAP parser requires matching results and a plan, not just plausible totals', () => {
  assert.equal(testTotals(report).pass, 1);
  for (const malformed of [
    report.replace('1..1\n', ''),
    report.replace('ok 1 - synthetic\n', ''),
    report.replace('1..1', '1..2'),
    report.replace('ok 1 - synthetic', 'ok 2 - synthetic'),
    report.replace('1..1', '1..1\n1..1'),
    report.replace('ok 1 - synthetic', 'not ok 1 - synthetic'),
    report.replace('ok 1 - synthetic', 'ok 1 - synthetic # SKIP'),
    report.replace('# suites 0', '# suites 1'),
    report.replace('# suites 0\n', ''),
    report.replace('# pass 1', '# pass NaN'),
    report.replace('# tests 1', '# tests 1\n# tests 1'),
    report.replace('# pass 1', '# pass 0').replace('# fail 0', '# fail 1'),
    `${report}ok 2 - unexpected\n`,
    `${report}garbage\n`,
  ])
    assert.equal(testTotals(malformed), null, malformed);
  assert.equal(testTotals(report).pass, 1);
});

test('TAP parser fails malformed, ambiguous and missing totals', () => {
  for (const source of [
    '',
    '{}',
    'TAP version 13\n# tests 0\n',
    'TAP version 13\n# tests NaN\n',
    'TAP version 13\n# tests 1\n# tests 1\n',
  ])
    assert.equal(testTotals(source), null);
});

test('runner CLI JSON help/list/run rejects extra or unknown input in fixture root', () =>
  fixture(({ root }) => {
    for (const [args, status] of [
      [['help'], 0],
      [['list'], 0],
      [['run', 'engineering-check'], 0],
      [['run', 'engineering-verify'], 1],
      [['run', 'unknown'], 1],
      [['help', 'extra'], 1],
      [[], 1],
    ]) {
      const child = spawnSync(
        process.execPath,
        [join(root, 'scripts/engineering-runner.mjs'), ...args],
        { cwd: root, encoding: 'utf8' },
      );
      assert.equal(child.status, status, child.stderr);
      assert.ok(JSON.parse(child.stdout));
    }
  }));
