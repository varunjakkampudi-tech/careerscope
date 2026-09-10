import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./application-exec.sh', import.meta.url));

test('application wrapper has valid POSIX shell syntax', () => {
  const result = spawnSync('sh', ['-n', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('application wrapper refuses startup without a browser password', () => {
  const home = mkdtempSync(join(tmpdir(), 'application-runtime-'));
  try {
    const result = spawnSync('sh', [script, 'true'], {
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Browser password missing/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('application wrapper requires a display and restricts password permissions', () => {
  const home = mkdtempSync(join(tmpdir(), 'application-runtime-'));
  try {
    mkdirSync(join(home, '.vnc'));
    const password = join(home, '.vnc', 'passwd');
    writeFileSync(password, 'synthetic-test-fixture', { mode: 0o644 });
    const result = spawnSync('sh', [script, 'true'], {
      env: { ...process.env, HOME: home, DISPLAY: '' },
      encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /requires the Xvfb display wrapper/);
    assert.equal(statSync(password).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
