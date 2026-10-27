#!/usr/bin/env node
// Tests the CI decision policy independently of deployment. A safe validation
// workflow does not require a staging or production deployment workflow.

import { existsSync, readFileSync } from 'node:fs';
import { decide, PASS, REFUSE, WAIT } from './require-ci-success.mjs';
import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';

let failures = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` (got ${actual}, expected ${expected})`}`,
  );
}

function hasReadOnlyPermissions(workflow) {
  const allowedScopes = new Set([
    'actions',
    'attestations',
    'checks',
    'contents',
    'deployments',
    'discussions',
    'id-token',
    'issues',
    'packages',
    'pages',
    'pull-requests',
    'repository-projects',
    'security-events',
    'statuses',
  ]);
  function containsAlias(node) {
    if (isAlias(node)) return true;
    if (isMap(node))
      return node.items.some((entry) => containsAlias(entry.key) || containsAlias(entry.value));
    if (isSeq(node)) return node.items.some(containsAlias);
    return false;
  }

  function valueFor(map, key) {
    if (!isMap(map)) return undefined;
    return map.items.find((entry) => isScalar(entry.key) && entry.key.value === key)?.value;
  }

  function isReadOnlyPermissionMap(node, requireContentsRead = false) {
    if (!isMap(node) || containsAlias(node)) return false;
    const scopes = new Map();
    for (const entry of node.items) {
      if (!isScalar(entry.key) || typeof entry.key.value !== 'string' || !isScalar(entry.value)) {
        return false;
      }
      const scope = entry.key.value;
      const permission = entry.value.value;
      if (
        !allowedScopes.has(scope) ||
        scopes.has(scope) ||
        (permission !== 'read' && permission !== 'none')
      ) {
        return false;
      }
      scopes.set(scope, permission);
    }
    return scopes.size > 0 && (!requireContentsRead || scopes.get('contents') === 'read');
  }

  const document = parseDocument(workflow);
  if (document.errors.length > 0 || !isMap(document.contents)) return false;
  const rootPermissions = valueFor(document.contents, 'permissions');
  const jobs = valueFor(document.contents, 'jobs');
  if (!isReadOnlyPermissionMap(rootPermissions, true) || !isMap(jobs)) return false;

  return jobs.items.every((job) => {
    if (!isScalar(job.key) || typeof job.key.value !== 'string' || !isMap(job.value)) return false;
    const permissions = valueFor(job.value, 'permissions');
    return permissions === undefined || isReadOnlyPermissionMap(permissions);
  });
}

function hasGitHubSecretExpression(workflow) {
  const expressionStart = '${{';
  let offset = 0;
  while (true) {
    const start = workflow.indexOf(expressionStart, offset);
    if (start === -1) return false;
    const end = workflow.indexOf('}}', start + expressionStart.length);
    if (end === -1) return true;
    if (/\bsecrets\b/i.test(workflow.slice(start + expressionStart.length, end))) return true;
    offset = end + 2;
  }
}

const run = (over = {}) => ({
  status: 'completed',
  conclusion: 'success',
  run_started_at: '2026-09-19T10:00:00Z',
  html_url: 'https://example.invalid/run',
  ...over,
});

const payload = (runs) => ({ total_count: runs.length, workflow_runs: runs });

// The only case that may deploy.
check('a completed successful run passes', decide(payload([run()])).verdict, PASS);

// Rejections.
check('a failed run refuses', decide(payload([run({ conclusion: 'failure' })])).verdict, REFUSE);
check(
  'a cancelled run refuses',
  decide(payload([run({ conclusion: 'cancelled' })])).verdict,
  REFUSE,
);
check(
  'a timed-out run refuses',
  decide(payload([run({ conclusion: 'timed_out' })])).verdict,
  REFUSE,
);
check(
  'a completed run with no conclusion refuses',
  decide(payload([run({ conclusion: null })])).verdict,
  REFUSE,
);
check('a run with no status refuses', decide(payload([run({ status: null })])).verdict, REFUSE);

// Malformed input must refuse, never read as "no failures".
check('null refuses', decide(null).verdict, REFUSE);
check('a string refuses', decide('no runs').verdict, REFUSE);
check('an array refuses', decide([]).verdict, REFUSE);
check('a missing total_count refuses', decide({ workflow_runs: [run()] }).verdict, REFUSE);
check(
  'a non-numeric total_count refuses',
  decide({ total_count: 'one', workflow_runs: [run()] }).verdict,
  REFUSE,
);
check('a missing workflow_runs refuses', decide({ total_count: 1 }).verdict, REFUSE);
check(
  'a count that disagrees with the array refuses',
  decide({ total_count: 5, workflow_runs: [run()] }).verdict,
  REFUSE,
);
check(
  'an unreadable run entry refuses',
  decide({ total_count: 2, workflow_runs: [run(), null] }).verdict,
  REFUSE,
);

// Waiting is not passing.
check('no run yet waits', decide(payload([])).verdict, WAIT);
check('an in-progress run waits', decide(payload([run({ status: 'in_progress' })])).verdict, WAIT);
check('a queued run waits', decide(payload([run({ status: 'queued' })])).verdict, WAIT);

// The newest run decides, so an older green run cannot authorise a red commit.
check(
  'an older success does not override a newer failure',
  decide(
    payload([
      run({ run_started_at: '2026-09-19T09:00:00Z' }),
      run({ run_started_at: '2026-09-19T11:00:00Z', conclusion: 'failure' }),
    ]),
  ).verdict,
  REFUSE,
);

// CI and deployment have independent lifecycles. Deployment requires CI, while
// CI remains valid without any deployment workflow (for example before the owner
// provides a separate staging target).
const deployExists = existsSync('.github/workflows/deploy.yml');
const ciExists = existsSync('.github/workflows/ci.yml');
check('deployment requires a CI workflow', !deployExists || ciExists, true);
if (deployExists) {
  const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
  check(
    'deploy.yml runs the gate script',
    workflow.includes('node scripts/ci/require-ci-success.mjs'),
    true,
  );
  check('the gate job exists', /^\s{2}require-ci:/m.test(workflow), true);
  check('the verify gate depends on it', /needs:\s*require-ci/.test(workflow), true);
  check('deploy exposes no CI bypass', workflow.includes('override_ci'), false);
  check('deploy is manual-only', /^on:\r?\n\s{2}workflow_dispatch:/m.test(workflow), true);
  check('deploy has no push trigger', /^\s{2}push:/m.test(workflow), false);
  check('deploy has no arbitrary ref input', /^\s{6}ref:\r?\n/m.test(workflow), false);
  check('deploy checks out main', /with:\s*\r?\n\s{10}ref: main/m.test(workflow), true);
  check('deploy verifies origin/main', workflow.includes('git rev-parse origin/main'), true);
  check('deploy fails on a stale checkout', workflow.includes('differs from origin/main'), true);
  check(
    'deploy uses the protected production environment',
    /^\s{4}environment: production$/m.test(workflow),
    true,
  );
  check(
    'deploy has no automatic trigger',
    /(^|\n)\s{2}(push|pull_request|pull_request_target|workflow_run|release|schedule|repository_dispatch):/m.test(
      workflow,
    ),
    false,
  );
}
if (ciExists) {
  const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const actionReferences = [...ciWorkflow.matchAll(/^\s*(?:-\s*)?uses:\s*([^\s#]+)/gm)].map(
    (match) => match[1],
  );
  check('CI does not publish Pages', ciWorkflow.includes('actions/deploy-pages@'), false);
  check(
    'CI and job permission blocks are explicit and read-only',
    hasReadOnlyPermissions(ciWorkflow),
    true,
  );
  check(
    'CI does not select a production environment',
    /^\s{4}environment:\s*production\s*$/m.test(ciWorkflow),
    false,
  );
  check(
    'CI does not invoke deployment workflow',
    /(?:workflow_dispatch|gh workflow run).*deploy/i.test(ciWorkflow),
    false,
  );
  check(
    'CI third-party actions are pinned to full commit SHAs',
    actionReferences.length > 0 &&
      actionReferences.every(
        (reference) => reference.startsWith('./') || /@[a-f0-9]{40}$/i.test(reference),
      ),
    true,
  );
  check(
    'CI contains no GitHub secret-context references',
    hasGitHubSecretExpression(ciWorkflow),
    false,
  );
} else if (!deployExists) {
  console.log('No CI workflow exists; deployment automation is disabled.');
}

console.log(failures === 0 ? '\ndeploy CI gate behaves' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
