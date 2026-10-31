import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Runs the real API entry point with an incomplete production environment. The startup log must name
// the rejected setting, so an operator can see what to fix, and the process must exit non-zero.
test('a startup with a missing required setting logs the setting name and exits non-zero', () => {
  const entry = fileURLToPath(new URL('./main.ts', import.meta.url));
  const run = spawnSync(process.execPath, ['--import', 'tsx', entry], {
    env: {
      PATH: process.env.PATH ?? '',
      SystemRoot: process.env.SystemRoot ?? '',
      NODE_ENV: 'production',
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  const output = `${run.stdout}${run.stderr}`;
  assert.notEqual(run.status, 0);
  assert.match(output, /"errorName":"ConfigurationError"/);
  assert.match(output, /DATABASE_URL: invalid_type/);
});
