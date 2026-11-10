import assert from 'node:assert/strict';
import test from 'node:test';
import { classify, sync, validate } from './check-file-audit.mjs';

function manifestWith(files) {
  return { schemaVersion: 1, files };
}

function entry(path, overrides = {}) {
  return {
    path,
    category: 'tests',
    reviewMethod: 'classification-only',
    state: 'not-reviewed',
    findings: [],
    ...overrides,
  };
}

test('a manifest that lists every tracked file once is valid', () => {
  const manifest = manifestWith([entry('a.ts'), entry('b.ts')]);
  assert.deepEqual(validate(manifest, ['a.ts', 'b.ts']), []);
});

test('a tracked file missing from the manifest is reported', () => {
  const errors = validate(manifestWith([entry('a.ts')]), ['a.ts', 'b.ts']);
  assert.ok(errors.includes('tracked file missing from manifest: b.ts'));
});

test('a manifest entry for an untracked file is reported', () => {
  const errors = validate(manifestWith([entry('a.ts'), entry('gone.ts')]), ['a.ts']);
  assert.ok(errors.includes('manifest lists a file that is not tracked: gone.ts'));
});

test('duplicate entries are reported', () => {
  const errors = validate(manifestWith([entry('a.ts'), entry('a.ts')]), ['a.ts']);
  assert.ok(errors.includes('duplicate entry: a.ts'));
});

test('an invalid review state is reported', () => {
  const errors = validate(manifestWith([entry('a.ts', { state: 'reviewd' })]), ['a.ts']);
  assert.ok(errors.some((error) => error.includes('invalid state "reviewd"')));
});

test('a reviewed entry needs a reviewer, observations and a current hash', () => {
  const errors = validate(manifestWith([entry('a.ts', { state: 'reviewed', sha256: '' })]), [
    'a.ts',
  ]);
  assert.ok(errors.includes('a.ts: reviewed without a reviewer'));
  assert.ok(errors.includes('a.ts: reviewed without observations'));
  assert.ok(errors.includes('a.ts: reviewed without a content hash'));
});

test('a reviewed entry whose hash no longer matches the file is stale', () => {
  const errors = validate(
    manifestWith([
      entry('package.json', {
        state: 'reviewed',
        reviewer: 'tester',
        observations: 'checked',
        sha256: '0'.repeat(64),
      }),
    ]),
    ['package.json'],
  );
  assert.ok(errors.includes('package.json: content changed since review (stale record)'));
});

test('an unresolved critical or high finding fails validation', () => {
  const finding = { id: 'X-1', severity: 'high', status: 'open', summary: 'defect' };
  const errors = validate(manifestWith([entry('a.ts', { findings: [finding] })]), ['a.ts']);
  assert.ok(errors.includes('a.ts: unresolved high finding X-1'));
});

test('a fixed finding needs a remediation reference', () => {
  const finding = { id: 'X-2', severity: 'low', status: 'fixed', summary: 'defect' };
  const errors = validate(manifestWith([entry('a.ts', { findings: [finding] })]), ['a.ts']);
  assert.ok(errors.some((error) => error.includes('X-2 is fixed but has no remediation')));
});

for (const state of ['not-reviewed', 'partially-reviewed', 'requires-investigation']) {
  test(`require-complete rejects ${state} entries in a mixed manifest`, () => {
    const manifest = manifestWith([
      entry('reviewed.ts', {
        state: 'reviewed',
        reviewer: 'test reviewer',
        observations: 'Reviewed for strict-mode regression coverage.',
        sha256: 'a'.repeat(64),
      }),
      entry('incomplete.ts', { state }),
    ]);
    assert.deepEqual(
      validate(manifest, ['reviewed.ts', 'incomplete.ts'], { requireComplete: true }),
      [`incomplete.ts: still ${state}`],
    );
  });
}

test('classification separates generated files, binaries and source', () => {
  assert.equal(classify('package-lock.json').state, 'not-applicable-source');
  assert.equal(classify('migrations/meta/0001_snapshot.json').state, 'not-applicable-source');
  assert.equal(classify('apps/web/public/brand/logo.png').state, 'not-applicable-source');
  assert.equal(classify('packages/core/src/totp.ts').state, 'not-reviewed');
  assert.equal(classify('docs/PROGRESS.md').category, 'documentation');
});

test('sync adds missing files and keeps existing records', () => {
  const existing = entry('a.ts', { state: 'partially-reviewed', observations: 'kept' });
  const synced = sync(manifestWith([existing]), ['a.ts', 'b.ts']);
  assert.equal(synced.files[0], existing);
  assert.equal(synced.files[1].path, 'b.ts');
  assert.equal(synced.files[1].state, 'not-reviewed');
});
