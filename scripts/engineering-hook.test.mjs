import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, URL } from 'node:url';
import test from 'node:test';
import { AREAS, loadEngineering } from './engineering.mjs';
import { evaluateHook, hookResponse, MAX_INPUT_BYTES, runHook } from './engineering-hook.mjs';
import {
  checkCustomizations,
  parseFrontmatter,
  validateAgentGrants,
  validateHookConfig,
  validateReviewSnapshot,
} from './check-customizations.mjs';

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'careerscope-hook-'));
  try {
    for (const directory of ['.ai', '.git', '.github/agents'])
      mkdirSync(join(root, directory), { recursive: true });
    const revision = 'a'.repeat(40);
    const time = '2026-01-01T00:00:00.000Z';
    const owner = 'careerscope-senior-engineer';
    const check = { id: 'setup', description: 'Synthetic setup' };
    writeFileSync(join(root, '.git/HEAD'), revision);
    writeFileSync(join(root, `.github/agents/${owner}.agent.md`), 'synthetic');
    const state = {
      schemaVersion: 1,
      objective: 'Synthetic objective',
      status: 'IN_PROGRESS',
      revision,
      createdAt: time,
      updatedAt: time,
      blockedReason: null,
      tasks: [
        {
          id: 'setup',
          owner,
          files: ['planned.mjs'],
          dependencies: [],
          attempts: 0,
          attemptLimit: 3,
          status: 'NOT_STARTED',
          acceptanceCriteria: [check],
          evidence: [],
          review: null,
          createdAt: time,
          updatedAt: time,
          blockedReason: null,
        },
      ],
    };
    const gates = {
      schemaVersion: 1,
      areas: Object.fromEntries(
        AREAS.map((area) => [
          area,
          {
            status: 'NOT_STARTED',
            applicability: { applicable: true, reason: null },
            responsibleAgent: owner,
            evidence: [],
            checks: [check],
            knownIssues: [],
            lastReviewed: null,
            reviewer: null,
          },
        ]),
      ),
    };
    const save = () => {
      writeFileSync(join(root, '.ai/engineering.json'), JSON.stringify(state));
      writeFileSync(join(root, 'quality-gates.json'), JSON.stringify(gates));
    };
    save();
    run({ root, state, save, load: () => loadEngineering(root) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('valid incomplete and BLOCKED records provide context without blocking or writes', () =>
  fixture(({ root, state, save, load }) => {
    for (const status of ['IN_PROGRESS', 'BLOCKED']) {
      state.status = status;
      state.blockedReason = status === 'BLOCKED' ? 'Awaiting review' : null;
      save();
      const before = readFileSync(join(root, '.ai/engineering.json'));
      const response = evaluateHook(
        '{"hook_event_name":"SessionStart","prompt":"private-marker"}',
        load,
      );
      assert.equal(response.exitCode, 0);
      assert.equal(response.output.continue, true);
      assert.match(response.output.systemMessage, new RegExp(status));
      assert.match(response.output.systemMessage, /NOT VERIFIED/);
      assert.doesNotMatch(JSON.stringify(response), /private-marker|Synthetic objective/);
      assert.deepEqual(readFileSync(join(root, '.ai/engineering.json')), before);
    }
  }));

test('pure response uses validated completion without mutating supplied records', () => {
  const payload = Object.freeze({ hook_event_name: 'SessionStart' });
  const records = Object.freeze({
    state: Object.freeze({ status: 'COMPLETE' }),
    result: Object.freeze({ valid: true, complete: true }),
  });
  const response = hookResponse(payload, records);
  assert.equal(response.exitCode, 0);
  assert.match(response.output.systemMessage, /VERIFIED by local records only/);
  assert.match(response.output.systemMessage, /not product, runtime, deployment/);
});

test('event name is optional for a SessionStart-only adapter', () => {
  assert.equal(
    evaluateHook('{}', () => ({
      state: { status: 'NOT_STARTED' },
      result: { valid: true, complete: false },
    })).exitCode,
    0,
  );
});

for (const raw of [
  '',
  ' ',
  '{',
  'null',
  '[]',
  '42',
  '"private-marker"',
  '{"hook_event_name":"Stop"}',
  '{"hook_event_name":null}',
  '{"hook_event_name":"PreToolUse"}',
  ' '.repeat(MAX_INPUT_BYTES + 1),
]) {
  test(`rejects invalid input ${JSON.stringify(raw.slice(0, 55))} before loading state`, () => {
    let called = false;
    const response = evaluateHook(raw, () => {
      called = true;
      throw new Error('private-marker');
    });
    assert.equal(response.exitCode, 2);
    assert.equal(response.output.continue, false);
    assert.equal(called, false);
    assert.doesNotMatch(JSON.stringify(response), /private-marker/);
  });
}

test('missing, malformed and invalid local state cannot fail open', () =>
  fixture(({ root, state, save, load }) => {
    state.status = 'invented-private-marker';
    save();
    assert.equal(evaluateHook('{}', load).exitCode, 2);
    writeFileSync(join(root, '.ai/engineering.json'), '{private-marker');
    assert.equal(evaluateHook('{}', load).exitCode, 2);
    rmSync(join(root, '.ai/engineering.json'));
    const response = evaluateHook('{}', load);
    assert.equal(response.exitCode, 2);
    assert.doesNotMatch(JSON.stringify(response), /private-marker|ENOENT|careerscope-hook-/);
  }));

test('missing or malformed loader result cannot imply success', () => {
  for (const records of [
    undefined,
    {},
    { state: {}, result: {} },
    { state: { status: 'COMPLETE' }, result: { valid: true, complete: false } },
    { state: { status: 'BLOCKED' }, result: { valid: true, complete: true } },
    { state: { status: 'IN_PROGRESS' }, result: { valid: 'true', complete: false } },
  ]) {
    assert.equal(evaluateHook('{}', () => records).exitCode, 2);
  }
});

test('stream input is byte-bounded, rejects invalid UTF-8 and read failures', async () => {
  const load = () => ({
    state: { status: 'IN_PROGRESS' },
    result: { valid: true, complete: false },
  });
  assert.equal(
    (await runHook(Readable.from([Buffer.from('{'), Buffer.from('}')]), load)).exitCode,
    0,
  );
  assert.equal(
    (await runHook(Readable.from(['{}', ' '.repeat(MAX_INPUT_BYTES)]), load)).exitCode,
    2,
  );
  assert.equal((await runHook(Readable.from([Buffer.from([0xff])]), load)).exitCode, 2);
  assert.equal(
    (
      await runHook(
        Readable.from(
          (async function* () {
            yield Buffer.from('{');
            throw new Error('private-marker');
          })(),
        ),
        load,
      )
    ).exitCode,
    2,
  );
  assert.equal(
    evaluateHook(JSON.stringify({ data: '\u00e9'.repeat(MAX_INPUT_BYTES / 2) }), load).exitCode,
    2,
  );
  assert.equal(evaluateHook('{}' + ' '.repeat(MAX_INPUT_BYTES - 2), load).exitCode, 0);
});

test('customizations parse real YAML including folded fields, block and flow lists', async () => {
  const matter = await parseFrontmatter(
    '---\nname: "CareerScope Example"\ndescription: >-\n  Folded description\ntools:\n  - read\n  - search\nagents: []\n---\nBody',
  );
  assert.equal(matter.name, 'CareerScope Example');
  assert.match(matter.description, /Folded description/);
  assert.deepEqual(matter.tools, ['read', 'search']);
  assert.deepEqual(matter.agents, []);
  for (const source of [
    '',
    '---\n[bad\n---',
    '---\nname: one\nname: two\n---',
    '---\n- list\n---',
    '---\ntools: &grant [edit]\nagents: *grant\n---',
  ])
    await assert.rejects(parseFrontmatter(source));
});

test('role grants reject escalation, unknown tools and invalid delegation', () => {
  const agent = { name: 'Reviewer', tools: ['read', 'execute/getTerminalOutput'], agents: [] };
  const names = new Set(['Reviewer', 'CareerScope Orchestrator']);
  assert.doesNotThrow(() => validateAgentGrants('independent-reviewer', agent, names));
  for (const tool of ['edit', 'execute', 'execute/runInTerminal', 'agent', '*', 'unknown'])
    assert.throws(() =>
      validateAgentGrants(
        'independent-reviewer',
        { ...agent, tools: [...agent.tools, tool] },
        names,
      ),
    );
  assert.throws(() => validateAgentGrants('unknown-role', agent, names));
  assert.throws(() =>
    validateAgentGrants('qa-agent', { ...agent, tools: ['execute', 'edit'] }, names),
  );
  assert.throws(() =>
    validateAgentGrants(
      'orchestrator',
      { ...agent, tools: ['edit', 'execute'], agents: ['Reviewer'] },
      names,
    ),
  );
  assert.throws(() =>
    validateAgentGrants('independent-reviewer', { ...agent, agents: ['Reviewer'] }, names),
  );
});

test('native hook validator accepts only the approved event and command', () => {
  const hook = { type: 'command', command: 'node scripts/engineering-hook.mjs', timeout: 10 };
  assert.doesNotThrow(() => validateHookConfig({ hooks: { SessionStart: [hook] } }));
  for (const config of [
    null,
    [],
    {},
    { hooks: {} },
    { hooks: { Stop: [hook] } },
    { hooks: { SessionStart: [hook], Stop: [hook] } },
    { hooks: { SessionStart: [{ ...hook, command: 'other' }] } },
    { hooks: { SessionStart: [{ ...hook, cwd: '/outside' }] } },
    { hooks: { SessionStart: [{ ...hook, timeout: 0 }] } },
  ])
    assert.throws(() => validateHookConfig(config));
});

test('only the latest dated review snapshot can satisfy required sections', () => {
  const snapshot = `Date: 2026-09-20\nRevision: ${'a'.repeat(40)}\nDigest: ${'b'.repeat(64)}\n## TESTING\nPassed synthetic assertions\n## FINAL STATUS\nBLOCKED\n## REMAINING ISSUES\nReview pending\n## NEXT ACTION\nIndependent review\n`;
  assert.doesNotThrow(() => validateReviewSnapshot(snapshot));
  for (const source of [
    '',
    snapshot.replace('## TESTING', '## OMITTED'),
    snapshot.replace('BLOCKED', ''),
    snapshot.replace('Digest:', 'Missing:'),
    `${snapshot}\nDate: 2026-09-21\n## FINAL STATUS\nCOMPLETE\n`,
  ])
    assert.throws(() => validateReviewSnapshot(source));
});

test('isolated customization inventory passes and missing or malformed requirements fail closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'careerscope-customizations-'));
  const source = fileURLToPath(new URL('../', import.meta.url));
  const snapshot = `Date: 2026-09-20\nRevision: ${'a'.repeat(40)}\nDigest: ${'b'.repeat(64)}\n## TESTING\nSynthetic checks\n## FINAL STATUS\nBLOCKED\n## REMAINING ISSUES\nNative discovery unverified\n## NEXT ACTION\nOperator verification\n`;
  try {
    for (const folder of ['agents', 'prompts', 'instructions', 'skills']) {
      const directory = `.github/${folder}`;
      mkdirSync(join(root, directory), { recursive: true });
      for (const entry of readdirSync(join(source, directory), { withFileTypes: true })) {
        const file =
          folder === 'skills' && entry.isDirectory()
            ? `${directory}/${entry.name}/SKILL.md`
            : `${directory}/${entry.name}`;
        if (!file.endsWith('.md') || (folder === 'skills' && !entry.isDirectory())) continue;
        if (folder === 'skills') mkdirSync(join(root, directory, entry.name));
        writeFileSync(join(root, file), readFileSync(join(source, file)));
      }
    }
    mkdirSync(join(root, '.github/hooks'));
    writeFileSync(
      join(root, '.github/hooks/engineering.json'),
      readFileSync(join(source, '.github/hooks/engineering.json')),
    );
    writeFileSync(join(root, 'review.txt'), snapshot);
    assert.equal((await checkCustomizations(root)).valid, true);
    const mutations = [
      ['.github/prompts/careerscope-qa.prompt.md', null],
      ['.github/prompts/careerscope-qa.prompt.md', '---\ndescription: [broken\n---'],
      [
        '.github/prompts/careerscope-qa.prompt.md',
        '---\ndescription: Test\nagent: Missing Agent\n---',
      ],
      ['.github/prompts/careerscope-qa.prompt.md', '---\nagent: CareerScope Orchestrator\n---'],
      [
        '.github/prompts/careerscope-qa.prompt.md',
        '---\ndescription: Test\nagent: CareerScope Orchestrator\ntools: [execute]\n---',
      ],
      ['.github/instructions/testing.instructions.md', null],
      ['.github/hooks/engineering.json', '{'],
      ['review.txt', `${snapshot}\nDate: 2026-09-21\n## FINAL STATUS\nCOMPLETE\n`],
    ];
    for (const [file, replacement] of mutations) {
      const path = join(root, file);
      const original = readFileSync(path);
      if (replacement === null) rmSync(path);
      else writeFileSync(path, replacement);
      assert.equal((await checkCustomizations(root)).valid, false, file);
      writeFileSync(path, original);
    }
    assert.equal(readFileSync(join(root, 'review.txt'), 'utf8'), snapshot);
    assert.equal((await checkCustomizations(root)).valid, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
