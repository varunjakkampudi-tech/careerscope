import assert from 'node:assert/strict';
import test from 'node:test';
import { writableProfileSchema, saveProfileSchema } from './profile.js';

export const syntheticProfile = {
  candidate: {
    fullName: 'Example Candidate',
    email: 'candidate@example.test',
    location: 'Hyderabad',
  },
  preferences: { titles: ['React Engineer'], techStack: ['React', 'TypeScript'] },
  application: { yearsOfExperience: 4 },
};

test('profile reuses domain defaults without inventing qualifications', () => {
  const parsed = writableProfileSchema.parse(syntheticProfile);
  assert.deepEqual(parsed.preferences.employmentTypes, ['fulltime']);
  assert.equal(parsed.application.yearsOfExperience, 4);
  assert.equal(parsed.application.expectedCtc, '');
  assert.equal(parsed.candidate.portfolio, '');
});

test('profile rejects unknown ownership fields, unsafe links and malformed revisions', () => {
  assert.equal(
    writableProfileSchema.safeParse({ ...syntheticProfile, ownerId: 'other' }).success,
    false,
  );
  assert.equal(
    writableProfileSchema.safeParse({
      ...syntheticProfile,
      candidate: { ...syntheticProfile.candidate, password: 'not-allowed' },
    }).success,
    false,
  );
  for (const portfolio of [
    'javascript:alert(1)',
    'https://user:password@example.test',
    'http://example.test',
  ]) {
    assert.equal(
      writableProfileSchema.safeParse({
        ...syntheticProfile,
        candidate: { ...syntheticProfile.candidate, portfolio },
      }).success,
      false,
    );
  }
  for (const revision of [-1, 1.5, '1']) {
    assert.equal(
      saveProfileSchema.safeParse({ revision, profile: syntheticProfile }).success,
      false,
    );
  }
  assert.equal(
    writableProfileSchema.safeParse({
      ...syntheticProfile,
      application: { yearsOfExperience: 100 },
    }).success,
    false,
  );
});
