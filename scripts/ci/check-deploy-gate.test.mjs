import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { parseDocument } from 'yaml';

const checker = resolve('scripts/ci/check-deploy-gate.mjs');

function runWithWorkflows(files) {
  const root = mkdtempSync(join(tmpdir(), 'careerscope-deploy-gate-'));
  const workflowDir = join(root, '.github', 'workflows');
  mkdirSync(workflowDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(workflowDir, name), contents, 'utf8');
  }

  try {
    const result = spawnSync(process.execPath, [checker], {
      cwd: root,
      encoding: 'utf8',
    });
    return {
      status: result.status,
      output: `${result.stdout}\n${result.stderr}`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('CI validation is allowed without a deployment workflow', () => {
  const result = runWithWorkflows({
    'ci.yml': [
      'name: CI',
      'on:',
      '  push:',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Checkout',
      '        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
      '',
    ].join('\n'),
  });

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /CI and job permission blocks are explicit and read-only/);
});

test('absence of both workflows keeps deployment automation disabled', () => {
  const result = runWithWorkflows({});

  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /No CI workflow exists; deployment automation is disabled\./);
});

test('a deployment workflow without a CI workflow is rejected', () => {
  const result = runWithWorkflows({
    'deploy.yml': 'name: Deploy\non:\n  workflow_dispatch:\n',
  });

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /deployment requires a CI workflow/);
});

test('CI cannot select the production environment', () => {
  const result = runWithWorkflows({
    'ci.yml': [
      'name: CI',
      'on:',
      '  push:',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    environment: production',
      '    steps: []',
      '',
    ].join('\n'),
  });

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /CI does not select a production environment/);
});

test('CI cannot dispatch the deployment workflow from a multiline step', () => {
  const result = runWithWorkflows({
    'ci.yml': [
      'name: CI',
      'on:',
      '  push:',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Deploy',
      '        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
      '        run: |',
      '          gh workflow run deploy.yml',
      '',
    ].join('\n'),
  });

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /CI does not invoke deployment workflow/);
});

test('CI rejects mutable third-party action tags', () => {
  const result = runWithWorkflows({
    'ci.yml': [
      'name: CI',
      'on:',
      '  push:',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '',
    ].join('\n'),
  });

  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /CI third-party actions are pinned to full commit SHAs/);
});

test('CI cannot access repository secrets', () => {
  for (const secretReference of [
    '${{ secrets.PROVIDER_TOKEN }}',
    "${{ secrets['PROVIDER_TOKEN'] }}",
    "${{ secrets[format('PROVIDER_{0}', 'TOKEN')] }}",
  ]) {
    const result = runWithWorkflows({
      'ci.yml': [
        'name: CI',
        'on:',
        '  push:',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  test:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Checkout',
        '        uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803',
        '        env:',
        `          TOKEN: ${secretReference}`,
        '',
      ].join('\n'),
    });

    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /CI contains no GitHub secret-context references/);
  }
});

test('CI cannot grant write permissions at workflow or job scope', () => {
  const invalidWorkflows = [
    [
      'name: CI',
      'on:',
      '  push:',
      'permissions:',
      '  contents: write',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps: []',
      '',
    ].join('\n'),
    [
      'name: CI',
      'on:',
      '  push:',
      'permissions:',
      '  contents: read',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      "    'permissions': { actions: write }",
      '    steps: []',
      '',
    ].join('\n'),
    [
      'name: CI',
      'on:',
      '  push:',
      'permissions: &ci_permissions',
      '  contents: read',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    permissions: *ci_permissions',
      '    steps: []',
      '',
    ].join('\n'),
  ];

  for (const workflow of invalidWorkflows) {
    const parsed = parseDocument(workflow);
    assert.equal(parsed.errors.length, 0, parsed.errors.map((error) => error.message).join('\n'));
    const result = runWithWorkflows({ 'ci.yml': workflow });

    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, /CI and job permission blocks are explicit and read-only/);
  }
});

test('the root CI service topology is disposable, loopback-only and recovery-compatible', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const fullDiskCheck = readFileSync(resolve('infra/checks/check-full-disk.mjs'), 'utf8');
  const backupCheck = readFileSync(resolve('infra/checks/check-backup.sh'), 'utf8');
  const queueRuntimeCheck = readFileSync(resolve('scripts/tests/check-queue-runtime.ts'), 'utf8');
  const databaseRecoveryCheck = readFileSync(
    resolve('scripts/tests/check-database-recovery.ts'),
    'utf8',
  );
  const postgresImage = workflow.match(/postgres:17\.6-alpine@sha256:[a-f0-9]{64}/)?.[0];
  const redisImage = workflow.match(/redis:7\.4\.5-alpine@sha256:[a-f0-9]{64}/)?.[0];

  assert.match(workflow, /CAREERSCOPE_POSTGRES_CONTAINER:\s*careerscope-ci-postgres/);
  assert.match(databaseRecoveryCheck, /\^careerscope\[-a-z0-9\]\*\$/);
  assert.match(databaseRecoveryCheck, /\^cs-export-validation-\\d\{8\}-pg\$/);
  assert.equal(
    [
      ...workflow.matchAll(
        /^[ ]{8}uses: actions\/checkout@[a-f0-9]{40}\r?\n[ ]{8}with:\r?\n[ ]{10}persist-credentials: false$/gm,
      ),
    ].length,
    3,
    'each CI job must prevent checkout credentials from persisting into test execution',
  );
  assert.match(workflow, /--name careerscope-ci-postgres --publish 127\.0\.0\.1:5432:5432/);
  assert.match(workflow, /postgres:17\.6-alpine@sha256:[a-f0-9]{64}/);
  assert.match(workflow, /--tmpfs \/var\/lib\/postgresql\/data:rw,size=1g/);
  assert.match(workflow, /--name careerscope-ci-rate-limit --publish 127\.0\.0\.1:6379:6379/);
  assert.match(workflow, /--name careerscope-ci-queue --publish 127\.0\.0\.1:6380:6379/);
  assert.match(workflow, /redis:7\.4\.5-alpine@sha256:[a-f0-9]{64}/);
  assert.ok(postgresImage, 'the CI workflow must declare its immutable PostgreSQL image');
  assert.ok(redisImage, 'the CI workflow must declare its immutable Redis image');
  assert.match(
    fullDiskCheck,
    /node:26\.8\.1-bookworm-slim@sha256:[a-f0-9]{64}/,
    'recovery containers must use immutable image digests',
  );
  assert.match(queueRuntimeCheck, /redis:7\.4\.5-alpine@sha256:[a-f0-9]{64}/);
  assert.match(databaseRecoveryCheck, /postgres:17\.6-alpine@sha256:[a-f0-9]{64}/);
  assert.ok(
    backupCheck.includes(postgresImage),
    'backup verification must use the CI PostgreSQL image',
  );
  assert.ok(
    databaseRecoveryCheck.includes(postgresImage),
    'database recovery must use the CI PostgreSQL image',
  );
  assert.ok(queueRuntimeCheck.includes(redisImage), 'queue runtime must use the CI Redis image');
  assert.match(workflow, /redis-server --appendonly yes --maxmemory-policy noeviction/);
  assert.match(
    workflow,
    /redis-cli --raw CONFIG GET appendonly \| tr -d '\\r' \| tail -n 1/,
    'Redis append-only mode must be normalized and compared exactly',
  );
  assert.match(
    workflow,
    /if \[ "\$appendonly" != yes \]; then[\s\S]*?Redis appendonly configuration failed/,
  );
  assert.match(
    workflow,
    /redis-cli --raw CONFIG GET maxmemory-policy \| tr -d '\\r' \| tail -n 1/,
    'Redis eviction policy must be normalized and compared exactly',
  );
  assert.match(
    workflow,
    /if \[ "\$eviction_policy" != noeviction \]; then[\s\S]*?Redis maxmemory-policy verification failed/,
  );
  assert.match(
    workflow,
    /if \[ "\$postgres_ready" != true \]; then[\s\S]*?PostgreSQL readiness check failed/,
  );
  assert.match(
    workflow,
    /if \[ "\$ready" != true \]; then[\s\S]*?Redis readiness check failed: \$container/,
  );
  assert.match(
    workflow,
    /redis-cli --raw INFO persistence \| tr -d '\\r'/,
    'Redis persistence verification must normalize redis-cli line endings before exact matching',
  );
  assert.match(workflow, /grep -qx 'aof_enabled:1'/);
  assert.match(workflow, /Remove ephemeral database and Redis containers\s+if: always\(\)/);
  assert.match(workflow, /Start production frontend for browser acceptance/);
  assert.match(workflow, /Stop production frontend test server\s+if: always\(\)/);
});

test('dev and main pushes and pull requests run the read-only service-backed CI checks', () => {
  const workflow = readFileSync(resolve('.github/workflows/ci.yml'), 'utf8');
  const document = parseDocument(workflow);
  assert.equal(document.errors.length, 0, document.errors.map((error) => error.message).join('\n'));
  const parsed = document.toJS();

  assert.deepEqual(parsed.on.push.branches, ['main', 'dev']);
  assert.deepEqual(parsed.on.pull_request.branches, ['main', 'dev']);
  assert.deepEqual(parsed.on.pull_request.types, [
    'opened',
    'synchronize',
    'reopened',
    'ready_for_review',
  ]);
  assert.match(parsed.jobs.services.if, /github\.event_name == 'pull_request'/);
  assert.match(parsed.jobs.services.if, /refs\/heads\/dev/);
  for (const stepName of [
    'Start production frontend for browser acceptance',
    'Install selected Playwright browser and system dependencies',
    'Run browser, axe accessibility, keyboard, and responsive checks',
  ]) {
    const step = parsed.jobs.services.steps.find((item) => item.name === stepName);
    assert.ok(step, `missing CI step: ${stepName}`);
    assert.match(
      step.if,
      /github\.event_name == 'pull_request'/,
      `${stepName} skips pull requests`,
    );
  }
  assert.equal(parsed.permissions.contents, 'read');
});
