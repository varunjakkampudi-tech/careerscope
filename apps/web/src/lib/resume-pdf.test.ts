import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { PDFParse } from 'pdf-parse';
import { createResumePdf, supportsDirectResumePdf, type ResumePdfDraft } from './resume-pdf.js';

async function isValidResumeContent(content: ResumePdfDraft['content']) {
  const coreSchema = await import(
    pathToFileURL(resolve(process.cwd(), 'packages/core/dist/resume-drafts.js')).href
  );
  return coreSchema.resumeDraftContentSchema.safeParse(content).success;
}

const draft: ResumePdfDraft = {
  title: 'Synthetic Role Resume',
  targetRole: 'Frontend Engineer',
  template: 'modern',
  content: {
    fullName: 'Synthetic Candidate',
    email: 'candidate@example.test',
    phone: '+1 555 010 0100',
    location: 'Hyderabad',
    summary: 'Builds accessible React interfaces.',
    experience: [
      {
        id: 'experience-1',
        role: 'Software Engineer',
        company: 'Synthetic Systems',
        location: 'Hyderabad',
        startDate: '2022-01',
        endDate: null,
        bullets: ['Built a candidate-reported feature.'],
      },
    ],
    education: [
      {
        id: 'education-1',
        institution: 'Example University',
        qualification: 'Bachelor of Engineering',
        location: null,
        endDate: '2021',
      },
    ],
    skills: ['React', 'TypeScript'],
  },
};

test('direct PDF export accepts Western Latin text and declines unsupported scripts', () => {
  assert.equal(supportsDirectResumePdf(draft), true);
  assert.equal(
    supportsDirectResumePdf({ ...draft, content: { ...draft.content, fullName: 'José O’Neil' } }),
    true,
  );
  assert.equal(
    supportsDirectResumePdf({ ...draft, content: { ...draft.content, fullName: 'తెలుగు పేరు' } }),
    false,
  );
});

test('direct PDF export carries role-specific metadata, a sanitized filename, and an A4 page', async () => {
  const result = createResumePdf(draft);
  assert.equal(result.filename, 'Synthetic Role Resume - Frontend Engineer.pdf');
  assert.equal(
    createResumePdf({ ...draft, title: 'Synthetic: Role/Resume' }).filename,
    'Synthetic Role Resume - Frontend Engineer.pdf',
  );

  const bytes = new Uint8Array(await result.blob.arrayBuffer());
  assert.equal(Buffer.from(bytes.subarray(0, 5)).toString('ascii'), '%PDF-');
  const contents = Buffer.from(bytes).toString('latin1');
  assert.match(contents, /\/Title\s*\(Synthetic Role Resume - Frontend Engineer\)/);
  assert.match(contents, /\/MediaBox\s*\[0 0 595\.\d+ 841\.\d+\]/);
  assert.match(contents, /\/Type\s*\/Page\b/);
});

test('direct PDF export preserves WinAnsi characters in extracted text', async () => {
  const accentedDraft: ResumePdfDraft = {
    ...draft,
    content: {
      ...draft.content,
      fullName: 'José O’Neil',
      summary: 'Delivered €5M in savings at Café Europa.',
      experience: draft.content.experience.map((item) => ({ ...item, company: 'Café Europa' })),
    },
  };
  const { blob } = createResumePdf(accentedDraft);
  const parser = new PDFParse({ data: new Uint8Array(await blob.arrayBuffer()) });
  try {
    const extracted = (await parser.getText()).text;
    assert.match(extracted, /José O’Neil/);
    assert.match(extracted, /€5M/);
    assert.match(extracted, /Café Europa/);
  } finally {
    await parser.destroy();
  }
});

test('direct PDF export paginates a schema-valid candidate-authored resume', async () => {
  const longDraft = {
    ...draft,
    content: {
      ...draft.content,
      fullName: 'Candidate with a long work history',
      summary: 'A candidate-authored profile within the supported summary limit.',
      experience: Array.from({ length: 16 }, (_, experienceIndex) => ({
        id: `experience-${experienceIndex}`,
        role: `Role ${experienceIndex}`,
        company: `Company ${experienceIndex}`,
        location: 'London',
        startDate: '2020-01',
        endDate: null,
        bullets: Array.from({ length: 8 }, (_, bulletIndex) =>
          `Candidate-authored achievement ${experienceIndex * 8 + bulletIndex} with measurable results. `.repeat(
            4,
          ),
        ),
      })),
      education: [
        {
          id: 'education-final',
          institution: 'Final Page University',
          qualification: 'Bachelor of Engineering',
          location: null,
          endDate: '2021',
        },
      ],
    },
  };
  assert.equal(await isValidResumeContent(longDraft.content), true);
  const { blob } = createResumePdf(longDraft);
  const parser = new PDFParse({ data: new Uint8Array(await blob.arrayBuffer()) });
  try {
    const result = await parser.getText();
    assert.ok(result.pages.length > 1, 'long candidate content flows onto additional A4 pages');
    assert.match(result.pages[0]!.text, /Candidate with a long work history/);
    assert.match(result.text, /Candidate-authored achievement 0 with measurable results/);
    assert.match(result.text, /Candidate-authored achievement 127 with measurable results/);
    assert.match(result.pages.at(-1)!.text, /Final Page University/);
  } finally {
    await parser.destroy();
  }
});

test('section headings stay with their first entry at page boundaries', async () => {
  for (let count = 1; count <= 60; count += 1) {
    const boundaryDraft: ResumePdfDraft = {
      ...draft,
      content: {
        ...draft.content,
        skills: Array.from({ length: count }, (_, index) =>
          `Skill ${index} with boundary text`.padEnd(45, 'x'),
        ),
        experience: [
          {
            id: 'boundary-experience',
            role: 'Boundary Role',
            company: 'Boundary Company',
            location: null,
            startDate: null,
            endDate: null,
            bullets: [],
          },
        ],
      },
    };
    assert.equal(await isValidResumeContent(boundaryDraft.content), true);
    const { blob } = createResumePdf(boundaryDraft);
    const parser = new PDFParse({ data: new Uint8Array(await blob.arrayBuffer()) });
    try {
      const result = await parser.getText();
      let headingSeen = false;
      for (const page of result.pages) {
        if (page.text.includes('Experience')) {
          headingSeen = true;
          assert.match(page.text, /Boundary Role/);
        }
      }
      assert.equal(headingSeen, true, 'boundary content includes the Experience section');
    } finally {
      await parser.destroy();
    }
  }
});
