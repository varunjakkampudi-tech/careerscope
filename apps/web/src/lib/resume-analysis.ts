import './zod-config';
import type { ResumeDraftContent } from './api-schemas.js';
import { extractSkills } from '@careerscope/shared';

export function analyzeResumeFormatting(content: ResumeDraftContent, targetRole: string | null) {
  return [
    { label: 'Name is present', passed: content.fullName.trim().length > 0 },
    { label: 'Target role is set', passed: Boolean(targetRole?.trim()) },
    {
      label: 'Experience bullets are concise',
      passed: content.experience.every((item) =>
        item.bullets.every((bullet) => bullet.length <= 240),
      ),
    },
    { label: 'Contact email is present', passed: Boolean(content.email?.trim()) },
  ];
}

/** Lists taxonomy-recognized job skills for candidate review; it never edits or asserts resume facts. */
export function compareResumeSkills(jobDescription: string, resumeFields: string | string[]) {
  const requested = extractSkills(jobDescription);
  const fields = Array.isArray(resumeFields) ? resumeFields : [resumeFields];
  const present = new Set(fields.flatMap((field) => extractSkills(field)));
  return {
    found: requested.filter((skill) => present.has(skill)),
    toReview: requested.filter((skill) => !present.has(skill)),
  };
}
