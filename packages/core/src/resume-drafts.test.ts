import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createResumeDraftSchema,
  resumeDraftContentSchema,
  resumeTemplateSchema,
} from './resume-drafts.js';

const content = {
  fullName: 'Synthetic Candidate',
  email: 'candidate@example.test',
  phone: null,
  location: null,
  summary: '',
  experience: [],
  education: [],
  skills: [],
};

test('resume drafts accept only the supported templates and bounded candidate-entered fields', () => {
  assert.deepEqual(resumeTemplateSchema.options, ['classic', 'modern', 'compact']);
  assert.equal(
    createResumeDraftSchema.safeParse({
      title: 'Senior Engineer',
      targetRole: 'Senior Engineer',
      template: 'classic',
      content,
    }).success,
    true,
  );
  assert.equal(
    createResumeDraftSchema.safeParse({
      title: ' ',
      targetRole: null,
      template: 'classic',
      content,
    }).success,
    false,
  );
  assert.equal(
    createResumeDraftSchema.safeParse({
      title: 'Draft',
      targetRole: null,
      template: 'ats-guaranteed',
      content,
    }).success,
    false,
  );
  assert.equal(
    resumeDraftContentSchema.safeParse({ ...content, unexpected: 'must not persist' }).success,
    false,
  );
});

test('resume draft sections require unique entry identifiers and bounded bullet claims', () => {
  const experience = {
    id: 'role-1',
    role: 'Engineer',
    company: 'Example Co',
    location: null,
    startDate: '2022',
    endDate: null,
    bullets: ['Built candidate-reported feature.'],
  };
  assert.equal(
    resumeDraftContentSchema.safeParse({
      ...content,
      experience: [experience, { ...experience, company: 'Different Co' }],
    }).success,
    false,
  );
  assert.equal(
    resumeDraftContentSchema.safeParse({
      ...content,
      experience: [{ ...experience, bullets: ['x'.repeat(601)] }],
    }).success,
    false,
  );
  assert.equal(
    resumeDraftContentSchema.safeParse({ ...content, email: 'not-an-email' }).success,
    false,
  );
});
