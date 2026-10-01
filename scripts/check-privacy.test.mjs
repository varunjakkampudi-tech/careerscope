import test from 'node:test';
import assert from 'node:assert/strict';
import { scanContent, scanTracked } from './check-privacy.mjs';

test('privacy scanner rejects high-confidence credentials without printing values', () => {
  const key = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
  const findings = scanContent(`credential=${key}`);
  assert.deepEqual(
    findings.map(({ type, severity }) => ({ type, severity })),
    [{ type: 'aws-access-key', severity: 'P1' }],
  );
});

test('privacy scanner permits synthetic documentation identities', () => {
  assert.deepEqual(
    scanContent('owner@example.invalid +919876543210', 'fixtures/synthetic.test.ts'),
    [],
  );
});

test('current tracked tree has no privacy findings', () => {
  assert.deepEqual(scanTracked(), []);
});
