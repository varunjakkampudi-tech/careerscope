import assert from 'node:assert/strict';
import test from 'node:test';
import type { ResumeDraftContent } from './api-schemas.js';
import { analyzeResumeFormatting, compareResumeSkills } from './resume-analysis.js';

const content: ResumeDraftContent = {
  fullName: 'Candidate',
  email: null,
  phone: null,
  location: null,
  summary: '',
  experience: [
    {
      id: 'role-1',
      role: 'Engineer',
      company: 'Example',
      location: null,
      startDate: null,
      endDate: null,
      bullets: ['x'.repeat(240)],
    },
  ],
  education: [],
  skills: [],
};

test('formatting guidance checks candidate text without claiming ATS parsing or a score', () => {
  assert.deepEqual(
    analyzeResumeFormatting(content, 'Engineer').map((check) => check.passed),
    [true, true, true, false],
  );
  assert.deepEqual(
    analyzeResumeFormatting(
      {
        ...content,
        fullName: '  ',
        email: 'candidate@example.test',
        experience: [{ ...content.experience[0]!, bullets: ['x'.repeat(241)] }],
      },
      null,
    ).map((check) => check.passed),
    [false, false, false, true],
  );
});

test('empty experience passes the bullet-length rule without inventing content', () => {
  assert.equal(analyzeResumeFormatting({ ...content, experience: [] }, null)[2]?.passed, true);
});

test('taxonomy skill comparison normalizes known aliases and leaves additions to the candidate', () => {
  assert.deepEqual(
    compareResumeSkills('Build with TypeScript and PostgreSQL.', 'Used ts in a candidate project.'),
    { found: ['TypeScript'], toReview: ['PostgreSQL'] },
  );
});

test('unknown job terms are not presented as missing skills', () => {
  assert.deepEqual(compareResumeSkills('Work with a fictional Qwerty platform', ''), {
    found: [],
    toReview: [],
  });
});
