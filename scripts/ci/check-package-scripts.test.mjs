import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Guards the shape of the integration commands and the CI workflow that runs them, so a refactor
// cannot quietly make the PostgreSQL/Redis suites parallel or give them non-production timeouts.

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (path) => readFileSync(`${root}${path}`, 'utf8');
const { scripts } = JSON.parse(read('package.json'));
const workflow = read('.github/workflows/ci.yml');

test('test:integration puts --test-concurrency=1 directly after --test', () => {
  assert.ok(
    scripts['test:integration'].includes('--test --test-concurrency=1 '),
    'test:integration must contain "--test --test-concurrency=1 "',
  );
});

test('every integration command runs its files serially, with the flag before any file', () => {
  for (const name of ['test:integration', 'test:integration:bull-queue', 'test:query-budget']) {
    const command = scripts[name];
    assert.equal(typeof command, 'string', `${name} must exist`);
    for (const segment of command.split('&&').filter((part) => /\snode\s/.test(` ${part}`))) {
      const flag = segment.indexOf('--test --test-concurrency=1 ');
      assert.ok(flag > 0, `${name}: node --test must be followed by --test-concurrency=1`);
      // Node does not reliably treat a flag that follows a file argument as an option.
      assert.equal(
        /\.test\.[cm]?[jt]s/.test(segment.slice(0, flag)),
        false,
        `${name}: no test file may come before --test-concurrency=1`,
      );
    }
  }
});

test('test:integration runs every integration file and the bull-queue suite once', () => {
  const all = `${scripts['test:integration']} ${scripts['test:integration:bull-queue']}`;
  assert.equal(all.split('bull-queue.integration.test.ts').length - 1, 1);
  assert.match(scripts['test:integration'], /npm run test:integration:bull-queue/);
});

test('only the bull-queue suite gets the raised timeouts, through its own env file', () => {
  assert.match(
    scripts['test:integration:bull-queue'],
    /--env-file=scripts\/tests\/bull-queue\.integration\.env/,
  );
  assert.doesNotMatch(scripts['test:integration'], /bull-queue\.integration\.env/);
  const env = read('scripts/tests/bull-queue.integration.env');
  for (const name of [
    'DATABASE_STATEMENT_TIMEOUT_MS',
    'DATABASE_CONNECT_TIMEOUT_MS',
    'INTEGRATION_JOB_WAIT_MS',
  ]) {
    assert.match(env, new RegExp(`^${name}=\\d+$`, 'm'));
  }
});

test('CI keeps production database timeouts for every other suite', () => {
  for (const name of [
    'DATABASE_STATEMENT_TIMEOUT_MS',
    'DATABASE_CONNECT_TIMEOUT_MS',
    'INTEGRATION_JOB_WAIT_MS',
  ]) {
    assert.equal(workflow.includes(name), false, `ci.yml must not set ${name}`);
  }
  assert.match(workflow, /run: npm run test:query-budget/);
});

test('CI runs the toolchain check, which passes, and the backup check', () => {
  assert.equal(typeof scripts['toolchain:check'], 'string', 'toolchain:check must exist');
  const [command, ...args] = scripts['toolchain:check'].split(' ');
  assert.equal(command, 'node');
  const run = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(workflow, /run: npm run toolchain:check/);
  const services = workflow.slice(workflow.indexOf('\n  services:'));
  assert.match(services, /run: bash infra\/checks\/check-backup\.sh/);
});
