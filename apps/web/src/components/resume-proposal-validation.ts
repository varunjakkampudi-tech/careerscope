import '../lib/zod-config';
import { applicationUpdateSchema, candidateSchema, preferencesSchema } from '@careerscope/shared';

export type ResumeCorrectionField =
  | 'fullName'
  | 'email'
  | 'phone'
  | 'location'
  | 'linkedin'
  | 'github'
  | 'portfolio'
  | 'techStack'
  | 'titles'
  | 'yearsOfExperience'
  | 'education'
  | 'experience';

/** Validate a correction against the same field schema used when saving the profile. */
export function isValidResumeCorrection(field: ResumeCorrectionField, value: string): boolean {
  if (field === 'yearsOfExperience') {
    const parsed = value.trim() === '' ? null : Number(value);
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) return false;
    if (typeof parsed === 'number' && Math.abs(parsed * 2 - Math.round(parsed * 2)) > 1e-9)
      return false;
    return applicationUpdateSchema.shape.yearsOfExperience.safeParse(parsed).success;
  }

  if (field === 'techStack' || field === 'titles') {
    const entries = value
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);
    return preferencesSchema.shape[field].safeParse(entries).success;
  }

  if (field === 'education' || field === 'experience') {
    const entries = value
      .split('\n')
      .map((entry) => entry.trim())
      .filter(Boolean);
    return candidateSchema.shape[field].safeParse(entries).success;
  }

  return candidateSchema.shape[field].safeParse(value).success;
}
