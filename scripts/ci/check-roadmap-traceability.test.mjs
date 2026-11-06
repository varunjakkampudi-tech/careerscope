import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkRoadmap, INVENTORY } from './check-roadmap-traceability.mjs';

test('the owner roadmap inventory passes its complete traceability check', () => {
  const result = checkRoadmap(process.cwd());
  assert.deepEqual(result.errors, []);
  assert.equal(result.items, 328);
  assert.equal(result.stages, 22);
});

test('a missing or truncated roadmap inventory fails its pinned scope checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerscope-roadmap-'));
  try {
    mkdirSync(join(root, 'docs/requirements'), { recursive: true });
    writeFileSync(join(root, INVENTORY), JSON.stringify({ schemaVersion: 1, items: [] }));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    const { errors } = checkRoadmap(root);
    assert.ok(errors.includes('roadmap must contain exactly 328 items'));
    assert.ok(errors.includes('roadmap must contain exactly 22 stages'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
