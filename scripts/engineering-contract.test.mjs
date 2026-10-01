import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { contractInputs, replayHistory, transitionTask } from './engineering-contract.mjs';

const at = '2026-01-01T00:00:00.000Z';
const event = (status) => ({ status, at, actor: 'builder', findings: [] });
const history = ['CREATED', 'READY', 'ASSIGNED', 'IN_PROGRESS'].map(event);

test('pure replay and transition preserve input and reject shortcuts', () => {
  const task = { status: 'IN_PROGRESS', contract: { history } };
  assert.equal(replayHistory(history), 'IN_PROGRESS');
  assert.equal(transitionTask(task, event('IMPLEMENTED')).status, 'IMPLEMENTED');
  assert.equal(task.contract.history.length, 4);
  assert.throws(() => transitionTask(task, event('COMPLETE')), /illegal transition/);
  assert.equal(replayHistory(history), 'IN_PROGRESS');
});

for (const malformed of [
  null,
  [],
  [{}],
  [event('READY')],
  [{ ...event('CREATED'), at: '2026-02-30T00:00:00.000Z' }],
])
  test(`reject malformed replay ${JSON.stringify(malformed)}`, () =>
    assert.throws(() => replayHistory(malformed)));

test('blocked and rejected events require findings', () => {
  assert.throws(() => replayHistory([...history, event('BLOCKED')]), /findings/);
  assert.equal(
    replayHistory([...history, { ...event('BLOCKED'), findings: ['Dependency unavailable'] }]),
    'BLOCKED',
  );
});

test('digest projection excludes only clean forward reporting and validated resolution links', () => {
  const contract = {
    history: [...history, event('IMPLEMENTED'), event('VERIFYING')],
    reviews: [],
    failures: [{ signature: 'synthetic failure', resolvedBy: null }],
  };
  const before = contractInputs(contract);
  for (const status of ['REVIEW', 'PASSED', 'COMPLETE']) {
    contract.history.push(event(status));
    assert.deepEqual(contractInputs(contract), before);
  }
  contract.failures[0].resolvedBy = 'rerun';
  assert.deepEqual(contractInputs(contract), before);
  assert.equal(contract.failures[0].resolvedBy, 'rerun');
  contract.history.at(-1).findings = ['New finding'];
  assert.notDeepEqual(contractInputs(contract), before);
  contract.history.splice(-3);
  contract.history.push({ ...event('BLOCKED'), findings: ['Repair required'] });
  assert.notDeepEqual(contractInputs(contract), before);
  contract.history.pop();
  assert.deepEqual(contractInputs(contract), before);
  contract.failures[0].signature = 'different failure';
  assert.notDeepEqual(contractInputs(contract), before);
});

test('service-backed integration teardown never force-terminates PostgreSQL sessions', () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const integrationFiles = [
    'packages/core/src/market.test.ts',
    'scripts/run-scheduled-discovery.test.ts',
    'scripts/check-lead-liveness.test.ts',
    'scripts/enforce-search-retention.test.ts',
  ];
  for (const relative of integrationFiles) {
    const source = readFileSync(`${root}/${relative}`, 'utf8');
    assert.doesNotMatch(
      source,
      /DROP DATABASE[^\n]*WITH\s*\(\s*FORCE\s*\)/i,
      `${relative} must let PostgreSQL report an unfinished connection instead of killing it`,
    );
  }
});
