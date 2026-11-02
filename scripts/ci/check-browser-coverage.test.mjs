import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Stage 01 (S1-F015): every push to dev or main runs browser acceptance on Chromium, Firefox and WebKit.
// These checks read the workflow text, so a later edit that narrows a push back to Chromium fails the gate.
const workflow = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/ci.yml', import.meta.url)),
  'utf8',
);

test('the browser engine for non-manual runs, including every push, is all three engines', () => {
  assert.match(
    workflow,
    /CAREERSCOPE_UI_BROWSER:\s*>-\s*\n\s*\$\{\{ github\.event_name != 'workflow_dispatch' && 'all' \|\|/,
  );
});

test('the browser acceptance step runs on pushes to dev and main', () => {
  const step = workflow.slice(
    workflow.indexOf('name: Run browser, axe accessibility'),
    workflow.indexOf('run: npm run test:ui'),
  );
  assert.match(step, /github\.ref == 'refs\/heads\/dev'/);
  assert.match(step, /github\.ref == 'refs\/heads\/main'/);
});

test('the Playwright install step installs all engines for the same events', () => {
  const step = workflow.slice(
    workflow.indexOf('name: Install selected Playwright browser'),
    workflow.indexOf('name: Run browser, axe accessibility'),
  );
  assert.match(step, /github\.ref == 'refs\/heads\/dev'/);
  assert.match(step, /npx playwright install --with-deps\n/);
  assert.match(step, /if \[ "\$CAREERSCOPE_UI_BROWSER" = all \]/);
});
