import { profileUpdateSchema, type Profile } from '@job-radar/shared';

export function importProfileJson(text: string, current: Profile): Profile {
  if (text.length > 1024 * 1024) throw new Error('Profile JSON must be smaller than 1 MB.');
  const value: unknown = JSON.parse(text);
  const result = profileUpdateSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  const patch = result.data;
  if (!patch.candidate && !patch.preferences && !patch.application) {
    throw new Error('Expected candidate, preferences, or application details in the profile JSON.');
  }
  return {
    ...current,
    candidate: { ...current.candidate, ...patch.candidate },
    preferences: { ...current.preferences, ...patch.preferences },
    application: { ...current.application, ...patch.application },
  };
}
