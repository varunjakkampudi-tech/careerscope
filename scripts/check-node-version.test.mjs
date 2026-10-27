import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const checker = fileURLToPath(new URL('./check-node-version.mjs', import.meta.url));

function verify({ engine = '>=24', nvm = '24', workflow } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'careerscope-node-policy-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ engines: { node: engine } }));
    if (nvm !== null) writeFileSync(join(root, '.nvmrc'), nvm);
    if (workflow !== undefined) {
      mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(root, '.github', 'workflows', 'ci.yml'), workflow);
    }
    return spawnSync(process.execPath, [checker, `--root=${root}`], { encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('local Node policy passes with workflows intentionally absent', () => {
  const result = verify();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Hosted workflows are absent/);
});

test('missing or inconsistent local declarations fail without workflows', () => {
  for (const input of [{ nvm: null }, { nvm: '22' }, { engine: 'not-a-version' }]) {
    assert.equal(verify(input).status, 1);
  }
});

test('a runtime below the declared floor fails', () => {
  assert.equal(verify({ engine: '>=999', nvm: '999' }).status, 1);
});

test('restored workflows must pin a compatible Node version', () => {
  assert.equal(verify({ workflow: 'env:\n  NODE_VERSION: 24\n' }).status, 0);
  assert.equal(verify({ workflow: 'env:\n  NODE_VERSION: 22\n' }).status, 1);
  assert.equal(verify({ workflow: 'name: CI\n' }).status, 1);
});
