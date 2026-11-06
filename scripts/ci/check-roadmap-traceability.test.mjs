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

test('malformed status evidence and paths fail without crashing the checker', () => {
  const root = mkdtempSync(join(tmpdir(), 'careerscope-roadmap-shape-'));
  try {
    mkdirSync(join(root, 'docs/requirements'), { recursive: true });
    const inventory = {
      schemaVersion: 1,
      source: { sha256: '427aa3fd646d1b27c535d6765411bda924755d1dfc8dae14980d73d03b056045' },
      scopeExclusions: ['Hostinger hosting', 'server backups', 'production deployment'],
      itemCount: 328,
      stageCount: 22,
      stageItemCounts: Object.fromEntries(
        [
          15, 14, 16, 12, 15, 13, 16, 12, 14, 15, 14, 17, 16, 10, 13, 18, 20, 15, 20, 14, 14, 15,
        ].map((count, index) => [index + 1, count]),
      ),
      items: [
        {
          id: '1.01',
          stage: 1,
          stageTitle: 'Stage',
          title: 'Item',
          sourceStatus: 'Required',
          currentStatus: 'not-started',
          evidence: ['../../escape'],
          tests: {},
          externalEvidence: 'invalid',
          gap: null,
          scopeDisposition: 'in-scope',
        },
      ],
    };
    writeFileSync(join(root, INVENTORY), JSON.stringify(inventory));
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
    const { errors } = checkRoadmap(root);
    assert.ok(errors.some((error) => error.includes('invalid repository-relative path')));
    assert.ok(errors.some((error) => error.includes('tests must be an array')));
    assert.ok(errors.some((error) => error.includes('externalEvidence must be an array')));
    assert.ok(errors.some((error) => error.includes('status requires a gap')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
