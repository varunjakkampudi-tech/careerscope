import assert from 'node:assert/strict';
import test from 'node:test';
import { decide, MINIMUM_TEST_FILES } from './check-test-types.mjs';

const testFiles = (count) =>
  Array.from({ length: count }, (_unused, index) => `packages/core/src/case-${index}.test.ts`).join(
    '\n',
  );

test('a healthy run with enough test files passes', () => {
  const verdict = decide({ status: 0, output: testFiles(MINIMUM_TEST_FILES) });
  assert.equal(verdict.verdict, 'PASS');
});

// S1-F038: an invalid compiler option is reported on a .json line with status 2.
// The old check printed PASS and exited 0 over this output.
test('a configuration error fails even when the test files still resolve', () => {
  const output = [
    testFiles(MINIMUM_TEST_FILES),
    "tsconfig.probe.json(1,69): error TS6046: Argument for '--target' option must be: 'es5'.",
  ].join('\n');
  const verdict = decide({ status: 2, output });
  assert.equal(verdict.verdict, 'FAIL');
  assert.match(verdict.reason, /exited 2/);
});

test('a nonzero status fails with no error line at all', () => {
  const verdict = decide({ status: 1, output: testFiles(MINIMUM_TEST_FILES) });
  assert.equal(verdict.verdict, 'FAIL');
});

test('a run killed without a status fails', () => {
  const verdict = decide({ status: null, output: testFiles(MINIMUM_TEST_FILES) });
  assert.equal(verdict.verdict, 'FAIL');
});

test('a type error in a test file fails even with status zero', () => {
  const output = [
    testFiles(MINIMUM_TEST_FILES),
    'packages/core/src/case-0.test.ts(3,7): error TS2322: Type string is not assignable.',
  ].join('\n');
  assert.equal(decide({ status: 0, output }).verdict, 'FAIL');
});

test('too few resolved test files refuses rather than passing', () => {
  const verdict = decide({ status: 0, output: testFiles(MINIMUM_TEST_FILES - 1) });
  assert.equal(verdict.verdict, 'REFUSE');
});

test('node_modules test paths do not count toward the floor', () => {
  const output = Array.from(
    { length: MINIMUM_TEST_FILES },
    () => 'node_modules/some-pkg/index.test.ts',
  ).join('\n');
  assert.equal(decide({ status: 0, output }).verdict, 'REFUSE');
});
