import type { DerivedResume } from '@careerscope/shared';

export type ResumeQualitySection = 'skills' | 'experience' | 'education';

export type ResumeQualityCheck = {
  section: ResumeQualitySection;
  detected: boolean;
};

export type ResumeQualityReport = {
  extractedCharacters: number;
  checks: ResumeQualityCheck[];
};

/** Summarizes parser output only. It does not judge source accuracy or completeness. */
export function assessResumeQuality(text: string, derived: DerivedResume): ResumeQualityReport {
  return {
    extractedCharacters: text.trim().length,
    checks: [
      {
        section: 'skills',
        detected: derived.techStack.length > 0 || derived.recentSkills.length > 0,
      },
      {
        section: 'experience',
        detected:
          derived.experienceClaims.length > 0 ||
          derived.titles.length > 0 ||
          derived.yearsOfExperience !== null,
      },
      {
        section: 'education',
        detected: derived.educationClaims.length > 0 || derived.education.length > 0,
      },
    ],
  };
}
