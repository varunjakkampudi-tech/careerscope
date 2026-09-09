import type { DerivedResume } from '@job-radar/shared';
import { detectFormat, extractText, ResumeParseError, type ResumeFormat } from './extract.js';
import { deriveFields } from './derive.js';

export { detectFormat, extractText, ResumeParseError };
export type { ResumeFormat };
export * from './derive.js';
export * from './sections.js';

export interface ParsedResume {
  format: ResumeFormat;
  text: string;
  derived: DerivedResume;
}

/**
 * Parse an uploaded resume into the derived profile the UI pre-fills and the
 * matcher scores against. Takes bytes rather than a path so the API never has to
 * write an unvalidated upload to disk first.
 */
export async function parseResume(buffer: Uint8Array, now = Date.now()): Promise<ParsedResume> {
  const format = detectFormat(buffer);
  if (!format) {
    throw new ResumeParseError('File is not a PDF or DOCX', 'unsupported_format');
  }
  const text = await extractText(buffer, format);
  const fields = deriveFields(text, now);

  const derived: DerivedResume = {
    ...(fields.fullName ? { fullName: fields.fullName } : {}),
    ...(fields.email ? { email: fields.email } : {}),
    ...(fields.phone ? { phone: fields.phone } : {}),
    ...(fields.location ? { location: fields.location } : {}),
    ...(fields.linkedin ? { linkedin: fields.linkedin } : {}),
    ...(fields.github ? { github: fields.github } : {}),
    ...(fields.portfolio ? { portfolio: fields.portfolio } : {}),
    techStack: fields.techStack,
    recentSkills: fields.recentSkills,
    titles: fields.titles,
    yearsOfExperience: fields.yearsOfExperience,
  };

  return { format, text, derived };
}
