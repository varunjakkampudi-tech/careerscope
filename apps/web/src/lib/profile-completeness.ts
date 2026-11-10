export type ProfileCompletenessInput = {
  candidate: {
    fullName: string;
    email: string;
    location: string;
    segment?: 'student' | 'fresher' | 'experienced';
    education: string[];
    experience: string[];
    projects: string[];
  };
  preferences: { titles: string[]; techStack: string[] };
};

export type ProfileCompletenessCheck = { id: string; label: string; done: boolean };

function hasValue(value: string | undefined) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasEntry(values: string[] | undefined) {
  return Array.isArray(values) && values.some(hasValue);
}

/** Measures saved, candidate-entered profile information without treating optional data as missing. */
export function profileCompletenessChecks(
  profile: ProfileCompletenessInput | null | undefined,
): ProfileCompletenessCheck[] {
  if (!profile) {
    return [
      { id: 'contact', label: 'Add your name and email', done: false },
      { id: 'location', label: 'Add your location', done: false },
      { id: 'background', label: 'Add education, experience, or a project', done: false },
      { id: 'target-role', label: 'Choose a target role', done: false },
      { id: 'skills', label: 'Add at least one skill', done: false },
    ];
  }

  const backgroundDone =
    profile.candidate.segment === 'student' || profile.candidate.segment === 'fresher'
      ? hasEntry(profile.candidate.education) || hasEntry(profile.candidate.projects)
      : profile.candidate.segment === 'experienced'
        ? hasEntry(profile.candidate.experience) ||
          hasEntry(profile.candidate.projects) ||
          hasEntry(profile.candidate.education)
        : hasEntry(profile.candidate.education) ||
          hasEntry(profile.candidate.experience) ||
          hasEntry(profile.candidate.projects);

  return [
    {
      id: 'contact',
      label: 'Add your name and email',
      done: hasValue(profile.candidate.fullName) && hasValue(profile.candidate.email),
    },
    { id: 'location', label: 'Add your location', done: hasValue(profile.candidate.location) },
    {
      id: 'background',
      label: 'Add education, experience, or a project',
      done: backgroundDone,
    },
    {
      id: 'target-role',
      label: 'Choose a target role',
      done: hasEntry(profile.preferences.titles),
    },
    {
      id: 'skills',
      label: 'Add at least one skill',
      done: hasEntry(profile.preferences.techStack),
    },
  ];
}

export function profileCompletenessPercent(checks: ProfileCompletenessCheck[]) {
  if (checks.length === 0) return 0;
  return Math.round((checks.filter((check) => check.done).length / checks.length) * 100);
}
