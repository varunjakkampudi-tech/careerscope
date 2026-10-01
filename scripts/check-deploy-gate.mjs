#!/usr/bin/env node
// Proves the deploy CI gate can refuse, and that the workflow actually wires it
// in. A gate that is merely present has been worth nothing here before.

import { readFileSync } from 'node:fs';
import { decide, PASS, REFUSE, WAIT } from './require-ci-success.mjs';

let failures = 0;

function check(name, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` (got ${actual}, expected ${expected})`}`,
  );
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

// A passing decision function is useless if the workflow never calls it.
const workflow = readFileSync('.github/workflows/deploy.yml', 'utf8');
const ciWorkflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const pagesWorkflow = readFileSync('.github/workflows/publish-pages.yml', 'utf8');
check(
  'deploy.yml runs the gate script',
  workflow.includes('node scripts/require-ci-success.mjs'),
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
check('CI does not publish Pages', ciWorkflow.includes('actions/deploy-pages@'), false);
check(
  'Pages publication is manual-only',
  /^on:\r?\n\s{2}workflow_dispatch:/m.test(pagesWorkflow),
  true,
);
check('Pages publication has no push trigger', /^\s{2}push:/m.test(pagesWorkflow), false);
check(
  'Pages publication requires exact-revision CI',
  pagesWorkflow.includes('node scripts/require-ci-success.mjs'),
  true,
);

console.log(failures === 0 ? '\ndeploy CI gate behaves' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
