import assert from 'node:assert/strict';
import test from 'node:test';
import { compareResumeKeywords } from './resume-keywords.js';

test('resume comparison normalizes conservative plurals and reports unmatched job terms', () => {
  assert.deepEqual(
    compareResumeKeywords('Build accessible dashboards and APIs', 'Built accessible dashboard'),
    {
      matched: ['accessible', 'dashboard', 'accessible dashboard'],
      missing: ['build', 'api', 'build accessible'],
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
      missing: ['user', 'research', 'user research'],
    },
  );
});

test('empty input does not invent matches or missing terms', () => {
  assert.deepEqual(compareResumeKeywords('', 'TypeScript React'), { matched: [], missing: [] });
});

test('sentence punctuation separates terms and does not become part of a keyword', () => {
  assert.deepEqual(compareResumeKeywords('React, TypeScript.', 'React TypeScript'), {
    matched: ['react', 'typescript'],
    missing: [],
  });
  assert.deepEqual(compareResumeKeywords('user research', 'user. Research'), {
    matched: ['user', 'research'],
    missing: ['user research'],
  });
});

test('stop words and unrelated resume fields cannot create adjacent phrases', () => {
  assert.deepEqual(compareResumeKeywords('product design', 'product and design'), {
    matched: ['product', 'design'],
    missing: ['product design'],
  });
  assert.deepEqual(compareResumeKeywords('product design', ['product', 'design']), {
    matched: ['product', 'design'],
    missing: ['product design'],
  });
});

test('technical punctuation stays inside technical tokens', () => {
  assert.deepEqual(compareResumeKeywords('C++, C#, and Node.js.', 'C++ C# Node.js'), {
    matched: ['c++', 'c#', 'node.js'],
    missing: [],
  });
});

test('unchanged s-ending terms are not incorrectly singularized', () => {
  assert.deepEqual(compareResumeKeywords('news series status', 'new serie statu'), {
    matched: [],
    missing: ['news', 'series', 'status', 'news series', 'series status'],
  });
});
