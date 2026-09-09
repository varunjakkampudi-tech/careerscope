import { createRequire } from 'node:module';

// pdf-parse v2 ships CJS; require() avoids needing a type shim for it.
const require = createRequire(import.meta.url);

export type ResumeFormat = 'pdf' | 'docx';

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46]; // %PDF
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // PK\x03\x04 — docx is a zip

/**
 * Identify the format from the bytes rather than the filename or the
 * browser-supplied Content-Type, both of which the client controls. An upload
 * claiming to be a PDF but carrying something else is rejected here.
 */
export function detectFormat(buffer: Uint8Array): ResumeFormat | null {
  if (startsWith(buffer, PDF_MAGIC)) return 'pdf';
  if (startsWith(buffer, ZIP_MAGIC)) return 'docx';
  return null;
}

function startsWith(buffer: Uint8Array, magic: number[]): boolean {
  if (buffer.length < magic.length) return false;
  return magic.every((byte, i) => buffer[i] === byte);
}

export class ResumeParseError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported_format' | 'extraction_failed' | 'empty_text',
  ) {
    super(message);
    this.name = 'ResumeParseError';
  }
}

/** Plain text of the resume, with layout whitespace normalised but lines kept. */
export async function extractText(buffer: Uint8Array, format?: ResumeFormat): Promise<string> {
  const detected = format ?? detectFormat(buffer);
  if (!detected) {
    throw new ResumeParseError('File is not a PDF or DOCX', 'unsupported_format');
  }

  let raw: string;
  try {
    raw = detected === 'pdf' ? await extractPdf(buffer) : await extractDocx(buffer);
  } catch (cause) {
    throw new ResumeParseError(
      `Could not read the ${detected.toUpperCase()}: ${(cause as Error).message}`,
      'extraction_failed',
    );
  }

  const text = tidy(raw);
  if (text.length < 40) {
    // Usually a scanned resume: a valid PDF whose pages are images, so there is
    // no text layer to read. Say so rather than silently deriving nothing.
    throw new ResumeParseError(
      'No selectable text found — if this is a scanned resume, export a text-based PDF or upload a DOCX',
      'empty_text',
    );
  }
  return text;
}

async function extractPdf(buffer: Uint8Array): Promise<string> {
  const { PDFParse } = require('pdf-parse') as {
    PDFParse: new (opts: { data: Uint8Array }) => {
      getText(): Promise<{ text?: string }>;
      destroy?(): Promise<void>;
    };
  };
  const parser = new PDFParse({ data: Uint8Array.from(buffer) });
  try {
    const result = await parser.getText();
    return result.text ?? '';
  } finally {
    await parser.destroy?.().catch(() => undefined);
  }
}

async function extractDocx(buffer: Uint8Array): Promise<string> {
  const mammoth = (await import('mammoth')) as unknown as {
    extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
  };
  const result = await mammoth.extractRawText({ buffer: Buffer.from(buffer) });
  return result.value;
}

/**
 * Collapse the artefacts of PDF text extraction — non-breaking spaces, runs of
 * blank lines, trailing spaces and letter-spaced headings — without destroying
 * line structure, which the section splitter depends on.
 */
function tidy(raw: string): string {
  const normalised = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[‐-―]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[ \t]+/g, ' ');

  return normalised
    .split('\n')
    .map(collapseLetterSpacing)
    .join('\n')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Vocabulary used to re-segment a letter-spaced heading, longest-first so the
 * greedy scan prefers "software" over "soft". Deliberately small: it only has to
 * cover the words that appear in a resume headline, and a miss returns the line
 * untouched rather than mangling it.
 */
const SEGMENT_VOCAB = [
  'administrator',
  'infrastructure',
  'certification',
  'applications',
  'architecture',
  'intelligence',
  'professional',
  'technologies',
  'development',
  'engineering',
  'experience',
  'certified',
  'consultant',
  'javascript',
  'leadership',
  'specialist',
  'technical',
  'typescript',
  'analytics',
  'architect',
  'associate',
  'developer',
  'education',
  'frontend',
  'principal',
  'programmer',
  'scientist',
  'solutions',
  'analyst',
  'backend',
  'devops',
  'director',
  'engineer',
  'learning',
  'machine',
  'manager',
  'platform',
  'product',
  'project',
  'security',
  'services',
  'software',
  'summary',
  'systems',
  'cloud',
  'front',
  'mobile',
  'python',
  'react',
  'senior',
  'skills',
  'stack',
  'staff',
  'about',
  'data',
  'full',
  'head',
  'java',
  'junior',
  'lead',
  'node',
  'back',
  'test',
  'web',
  'end',
  'sde',
  'swe',
  'and',
  'of',
  'qa',
  'ui',
  'ux',
  'ai',
  'ml',
].sort((a, b) => b.length - a.length);

/**
 * Some resumes letter-space their headline for style, and PDF extraction turns
 * that into "F U L L S T A C K E N G I N E E R" — the wider inter-word gaps are
 * lost, so no amount of whitespace analysis can recover them. Left alone, the
 * candidate's own job title is invisible to every regex downstream. Re-segment
 * against a small vocabulary instead, and return the line unchanged whenever the
 * segmentation doesn't come out clean.
 */
function collapseLetterSpacing(line: string): string {
  const tokens = line.trim().split(' ').filter(Boolean);
  if (tokens.length < 6 || tokens.length > 64) return line;

  const singles = tokens.filter((t) => t.length === 1 && /[A-Za-z0-9]/.test(t)).length;
  if (singles / tokens.length < 0.85) return line;

  const joined = tokens.join('');
  const lower = joined.toLowerCase();
  const words: string[] = [];
  let i = 0;
  while (i < lower.length) {
    if (!/[a-z0-9]/.test(lower[i] ?? '')) {
      i += 1; // stray punctuation between letters
      continue;
    }
    const match = SEGMENT_VOCAB.find((word) => lower.startsWith(word, i));
    if (!match) return line;
    words.push(joined.slice(i, i + match.length));
    i += match.length;
  }
  return words.length > 0 ? words.join(' ') : line;
}
