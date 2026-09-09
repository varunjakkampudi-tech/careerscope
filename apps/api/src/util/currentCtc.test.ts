import { describe, expect, it } from 'vitest';
import { profileSchema } from '@job-radar/shared';
import { profileForProcessing } from './currentCtc.js';

describe('processing compensation', () => {
  it.each([
    ['8.1', '7.1'],
    ['8.10 LPA', '7.1 LPA'],
    ['8.12 lpa', '7.12 lpa'],
    ['1', '0'],
    ['0.5', '0'],
    ['', ''],
    ['$120k', '$120k'],
    ['810000 INR', '810000 INR'],
  ])('processes %s as %s without changing the stored input', (value, expected) => {
    const profile = profileSchema.parse({
      candidate: { fullName: 'Candidate', email: 'candidate@example.com', location: 'Hyderabad' },
      preferences: { titles: ['Engineer'], techStack: ['TypeScript'] },
      application: { currentCtc: value, expectedCtc: '12 LPA' },
    });
    expect(profileForProcessing(profile).application.currentCtc).toBe(expected);
    expect(profileForProcessing(profile).application.currentCtc).toBe(expected);
    expect(profile.application.currentCtc).toBe(value);
    expect(profileForProcessing(profile).application.expectedCtc).toBe('12 LPA');
  });
});
