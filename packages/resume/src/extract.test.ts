import { describe, expect, it } from 'vitest';
import { detectFormat, extractText, ResumeParseError } from './extract.js';
import { splitSections, headerBlock } from './sections.js';

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

describe('detectFormat', () => {
  it('identifies a PDF by its magic bytes, not its name or MIME type', () => {
    expect(detectFormat(bytes(0x25, 0x50, 0x44, 0x46, 0x2d))).toBe('pdf');
  });

  it('identifies a DOCX by the zip header it is built on', () => {
    expect(detectFormat(bytes(0x50, 0x4b, 0x03, 0x04, 0x14))).toBe('docx');
  });

  it('rejects anything else, including a truncated file', () => {
    expect(detectFormat(bytes(0x89, 0x50, 0x4e, 0x47))).toBeNull(); // PNG
    expect(detectFormat(bytes(0x25))).toBeNull();
    expect(detectFormat(new Uint8Array())).toBeNull();
  });
});

describe('extractText', () => {
  it('refuses a file that is neither PDF nor DOCX', async () => {
    await expect(extractText(bytes(1, 2, 3, 4))).rejects.toMatchObject({
      name: 'ResumeParseError',
      code: 'unsupported_format',
    });
  });

  it('reports a corrupt PDF as an extraction failure rather than crashing', async () => {
    const header = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a);
    await expect(extractText(header)).rejects.toBeInstanceOf(ResumeParseError);
  });
});

describe('splitSections', () => {
  const text = `Jane Doe
jane@example.com

PROFESSIONAL EXPERIENCE
Acme Corp — Senior Engineer
- Shipped things

TECHNICAL SKILLS
React, Node.js

EDUCATION
B.Tech, 2019`;

  it('routes each block to its section', () => {
    const sections = splitSections(text);
    expect(sections.experience).toContain('Acme Corp');
    expect(sections.skills).toContain('React');
    expect(sections.education).toContain('B.Tech');
  });

  it('keeps the pre-heading block so contact parsing can find it', () => {
    expect(splitSections(text).other).toContain('jane@example.com');
  });

  it('does not start a section on a sentence that merely mentions one', () => {
    const prose = 'SUMMARY\nI have experience across the stack.\nAlso strong skills in testing.';
    const sections = splitSections(prose);
    expect(sections.summary).toContain('experience across the stack');
    expect(sections.experience).toBe('');
  });

  it('accepts a decorated heading', () => {
    expect(splitSections('WORK EXPERIENCE:\nAcme').experience).toBe('Acme');
    expect(splitSections('• Technical Skills •\nGo').skills).toBe('Go');
  });
});

describe('headerBlock', () => {
  it('is limited to the top of the document', () => {
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    expect(headerBlock(lines)).toContain('line 14');
    expect(headerBlock(lines)).not.toContain('line 15');
  });
});
