import type { ResumeDraftContent } from './api-schemas.js';

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
