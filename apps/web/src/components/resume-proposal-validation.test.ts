import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidResumeCorrection } from './resume-proposal-validation.js';

test('years of experience accepts empty, range-boundary and half-year values', () => {
  assert.equal(isValidResumeCorrection('yearsOfExperience', ''), true);
  assert.equal(isValidResumeCorrection('yearsOfExperience', '0'), true);
  assert.equal(isValidResumeCorrection('yearsOfExperience', '2.5'), true);
  assert.equal(isValidResumeCorrection('yearsOfExperience', '60'), true);
});

test('years of experience rejects invalid range, malformed and step-mismatched values', () => {
  for (const value of ['-0.5', '60.5', 'abc', '2.333'])
    assert.equal(isValidResumeCorrection('yearsOfExperience', value), false, value);
});

test('correction validation follows profile text and URL field schemas', () => {
  assert.equal(isValidResumeCorrection('fullName', 'Candidate'), true);
  assert.equal(isValidResumeCorrection('fullName', 'x'.repeat(121)), false);
  assert.equal(isValidResumeCorrection('email', 'not-an-email'), false);
  assert.equal(isValidResumeCorrection('linkedin', 'not-a-url'), false);
  assert.equal(isValidResumeCorrection('linkedin', ''), true);
  assert.equal(isValidResumeCorrection('phone', 'x'.repeat(41)), false);
});

test('correction list validation follows profile item and collection limits', () => {
  assert.equal(isValidResumeCorrection('techStack', 'TypeScript\nReact'), true);
  assert.equal(isValidResumeCorrection('techStack', `x`.repeat(121)), false);
  assert.equal(
    isValidResumeCorrection('titles', Array.from({ length: 26 }, () => 'Role').join('\n')),
    false,
  );
  assert.equal(
    isValidResumeCorrection('education', Array.from({ length: 21 }, () => 'Degree').join('\n')),
    false,
  );
  assert.equal(isValidResumeCorrection('experience', `x`.repeat(201)), false);
});
