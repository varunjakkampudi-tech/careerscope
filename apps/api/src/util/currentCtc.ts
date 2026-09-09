import type { Profile } from '@job-radar/shared';

export function profileForProcessing(profile: Profile): Profile {
  const value = profile.application.currentCtc;
  const match = /^(\d+)(?:\.(\d{1,2}))?(?:\s*(lpa))?$/i.exec(value.trim());
  if (!match) return profile;
  const hundredths = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(hundredths)) return profile;
  const adjusted = Math.max(0, hundredths - 100) / 100;
  return {
    ...profile,
    application: {
      ...profile.application,
      currentCtc: `${adjusted}${match[3] ? ` ${match[3]}` : ''}`,
    },
  };
}
