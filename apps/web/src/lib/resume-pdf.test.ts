import assert from 'node:assert/strict';
import test from 'node:test';
import { createResumePdf, supportsDirectResumePdf, type ResumePdfDraft } from './resume-pdf.js';

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

test('direct PDF export paginates long candidate-authored summaries', async () => {
  const longDraft = {
    ...draft,
    content: {
      ...draft.content,
      summary: `${'Candidate-authored achievement with measurable results. '.repeat(260)}`,
    },
  };
  const { blob } = createResumePdf(longDraft);
  const contents = Buffer.from(await blob.arrayBuffer()).toString('latin1');
  assert.ok(
    (contents.match(/\/Type\s*\/Page\b/g) ?? []).length > 1,
    'long content flows onto additional A4 pages',
  );
});
