import assert from 'node:assert/strict';
import test from 'node:test';
import { compareResumeKeywords } from './resume-keywords.js';

test('resume comparison normalizes conservative plurals and reports unmatched job terms', () => {
  assert.deepEqual(
    compareResumeKeywords('Build accessible dashboards and APIs', 'Built accessible dashboard'),
    {
      matched: ['accessible', 'dashboard', 'accessible dashboard'],
      missing: ['build', 'api', 'build accessible', 'dashboard api'],
    },
  );
});

test('resume comparison includes adjacent phrases and preserves literal context', () => {
  assert.deepEqual(
    compareResumeKeywords(
      'Experience with product design and user research',
      'Product design experience',
    ),
    {
      matched: ['experience', 'product', 'design', 'product design'],
      missing: ['user', 'research', 'experience product', 'design user', 'user research'],
    },
  );
});

test('empty input does not invent matches or missing terms', () => {
  assert.deepEqual(compareResumeKeywords('', 'TypeScript React'), { matched: [], missing: [] });
});
