import { describe, expect, it } from 'vitest';
import { profileSchema } from '@job-radar/shared';
import { importProfileJson } from './profileImport';

const current = profileSchema.parse({
  candidate: { fullName: 'Candidate', email: 'candidate@example.com', location: 'Bengaluru' },
  preferences: { titles: ['Engineer'], techStack: ['TypeScript'] },
  application: { yearsOfExperience: 5 },
  resumeId: 'uploaded-resume',
});

describe('profile JSON import', () => {
  it('merges extra details while preserving resume data and omitted fields', () => {
    const imported = importProfileJson(
      JSON.stringify({
        application: { currentCtc: '20 LPA', expectedCtc: '30 LPA', noticePeriodDays: 30 },
        preferences: { locations: ['Hyderabad'] },
        resumeId: 'foreign-resume',
      }),
      current,
    );
    expect(imported.resumeId).toBe('uploaded-resume');
    expect(imported.preferences.techStack).toEqual(['TypeScript']);
    expect(imported.preferences.locations).toEqual(['Hyderabad']);
    expect(imported.application).toMatchObject({
      currentCtc: '20 LPA',
      expectedCtc: '30 LPA',
      yearsOfExperience: 5,
    });
    expect(current.application.currentCtc).toBe('');
  });

  it('rejects malformed, invalid, unrecognized and oversized imports', () => {
    expect(() => importProfileJson('{', current)).toThrow();
    expect(() => importProfileJson('{"application":{"noticePeriodDays":-1}}', current)).toThrow(
      'noticePeriodDays',
    );
    expect(() => importProfileJson('{"unrelated":true}', current)).toThrow('Expected');
    expect(() => importProfileJson(' '.repeat(1024 * 1024 + 1), current)).toThrow('1 MB');
  });
});
