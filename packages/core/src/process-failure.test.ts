import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { installProcessFailureHandlers } from './failure.js';

const fixture = fileURLToPath(new URL('./process-failure.fixture.ts', import.meta.url));

for (const mode of ['configuration', 'rejection']) {
  test(`a ${mode} crash exits 1 without printing the connection password`, () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', fixture, mode], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: ['postgres://user', ':S3cretPass@[bad host'].join(''),
        REDIS_URL: 'redis://127.0.0.1:56379',
        APP_ORIGIN: 'http://127.0.0.1:3000',
      },
    });
    assert.equal(child.status, 1);
    assert.doesNotMatch(child.stderr, /S3cretPass/);
    assert.doesNotMatch(child.stdout, /S3cretPass/);
    assert.match(child.stdout + child.stderr, /Process crashed/);
  });
}

test('installProcessFailureHandlers registers one listener however often it is called', () => {
  const before = process.listenerCount('uncaughtException');
  installProcessFailureHandlers();
  installProcessFailureHandlers();
  assert.equal(process.listenerCount('uncaughtException'), before + 1);
  assert.equal(process.listenerCount('unhandledRejection') >= 1, true);
});
