import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// The browser suite is a top-level-await script. A setup failure must end the
// process with a nonzero status, because a zero status is what makes a broken
// run look like a passing one (the wrapper that launched it hid exactly that).
test('the UI suite exits nonzero when its database setup fails', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/tests/check-ui.ts'], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      // Wrong credentials on a loopback address: setup fails at the first query.
      DATABASE_URL: 'postgres://careerscope_invalid:invalid@127.0.0.1:55433/careerscope',
      CAREERSCOPE_UI_BROWSER: 'chromium',
    },
  });

  assert.notEqual(
    result.status,
    0,
    `expected a nonzero exit, got ${result.status}: ${result.stderr}`,
  );
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stdout, /passed/i);
});
