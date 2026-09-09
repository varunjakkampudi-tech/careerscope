/**
 * Splits resume text into named sections. Everything downstream is more accurate
 * once we know which lines are experience and which are education — "React" in a
 * coursework list is not the same signal as "React" in the current job.
 */

export type SectionName =
  'summary' | 'experience' | 'skills' | 'education' | 'projects' | 'certifications' | 'other';

export type Sections = Record<SectionName, string>;

/** Heading spellings, longest first so "work experience" beats "experience". */
const HEADINGS: { name: SectionName; patterns: string[] }[] = [
  {
    name: 'experience',
    patterns: [
      'professional experience',
      'work experience',
      'employment history',
      'work history',
      'career history',
      'relevant experience',
      'experience',
      'employment',
    ],
  },
  {
    name: 'skills',
    patterns: [
      'technical skills',
      'core competencies',
      'technical proficiencies',
      'technologies',
      'tech stack',
      'skills & abilities',
      'key skills',
      'skills',
      'expertise',
    ],
  },
  {
    name: 'education',
    patterns: ['education', 'academic background', 'academics', 'qualifications'],
  },
  {
    name: 'projects',
    patterns: ['personal projects', 'key projects', 'projects', 'portfolio'],
  },
  {
    name: 'certifications',
    patterns: ['certifications', 'certificates', 'licenses', 'courses'],
  },
  {
    name: 'summary',
    patterns: [
      'professional summary',
      'career objective',
      'summary',
      'objective',
      'profile',
      'about me',
      'about',
    ],
  },
];

/**
 * A line is a heading when it is short, mostly free of sentence punctuation, and
 * matches a known section name. Requiring shortness is what keeps a sentence
 * like "I have experience across the stack" from starting a new section.
 */
function headingOf(line: string): SectionName | null {
  const cleaned = line
    .replace(/^[^A-Za-z]+/, '')
    .replace(/[:•\-–—_|]+$/, '')
    .trim()
    .toLowerCase();
  if (!cleaned || cleaned.length > 40) return null;
  if (/[.!?]$/.test(line.trim())) return null;

  for (const { name, patterns } of HEADINGS) {
    for (const pattern of patterns) {
      if (cleaned === pattern) return name;
      // "TECHNICAL SKILLS —" or "Experience (2019 - Present)" style headings.
      if (cleaned.startsWith(pattern) && cleaned.length <= pattern.length + 14) return name;
    }
  }
  return null;
}

export function splitSections(text: string): Sections {
  const sections: Sections = {
    summary: '',
    experience: '',
    skills: '',
    education: '',
    projects: '',
    certifications: '',
    other: '',
  };

  const lines = text.split('\n');
  // Everything before the first heading is the header block: name, contact,
  // sometimes a summary. It goes to `other` so contact parsing can find it.
  let current: SectionName = 'other';
  const buffers: Record<SectionName, string[]> = {
    summary: [],
    experience: [],
    skills: [],
    education: [],
    projects: [],
    certifications: [],
    other: [],
  };

  for (const line of lines) {
    const heading = headingOf(line);
    if (heading) {
      current = heading;
      continue;
    }
    buffers[current].push(line);
  }

  for (const key of Object.keys(buffers) as SectionName[]) {
    sections[key] = buffers[key].join('\n').trim();
  }
  return sections;
}

/** The first ~15 lines, where the name, email, phone and location live. */
export function headerBlock(text: string): string {
  return text.split('\n').slice(0, 15).join('\n');
}
