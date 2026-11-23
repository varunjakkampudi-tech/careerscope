import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
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

type PositionedPdfTextItem = {
  fontName: string;
  str: string;
  transform: number[];
  width: number;
};

function isNonEmptyPdfTextItem(item: unknown): item is { str: string } {
  if (!item || typeof item !== 'object') return false;
  const candidate = item as Record<string, unknown>;
  return typeof candidate.str === 'string' && candidate.str.length > 0;
}

function assertPositionedPdfTextItem(item: unknown): PositionedPdfTextItem {
  assert.ok(item && typeof item === 'object');
  const candidate = item as Record<string, unknown>;
  assert.equal(typeof candidate.fontName, 'string', 'nonempty text has a font style');
  assert.ok(
    Array.isArray(candidate.transform) &&
      candidate.transform.length >= 6 &&
      candidate.transform.every((value) => typeof value === 'number' && Number.isFinite(value)),
    'nonempty text has a finite six-value transform',
  );
  assert.ok(
    typeof candidate.width === 'number' && Number.isFinite(candidate.width),
    'nonempty text has a finite width',
  );
  return candidate as PositionedPdfTextItem;
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

test('multi-page PDF text remains inside the A4 page bounds', async () => {
  const longDraft: ResumePdfDraft = {
    ...draft,
    content: {
      ...draft.content,
      fullName: 'Candidate with a long work history',
      summary: 'A candidate-authored profile within the supported summary limit.',
      experience: Array.from({ length: 16 }, (_, experienceIndex) => ({
        id: `layout-experience-${experienceIndex}`,
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
    },
  };
  assert.equal(await isValidResumeContent(longDraft.content), true);

  const { blob } = createResumePdf(longDraft);
  const pdfjs = await import(
    pathToFileURL(resolve(process.cwd(), 'node_modules/pdfjs-dist/legacy/build/pdf.mjs')).href
  );
  const standardFontDataUrl = `${resolve(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts').replaceAll(sep, '/')}/`;
  const document = await pdfjs.getDocument({
    data: new Uint8Array(await blob.arrayBuffer()),
    standardFontDataUrl,
  }).promise;
  const pointPerMillimeter = 72 / 25.4;
  const margin = 16 * pointPerMillimeter;
  const pageEdgePadding = 10;
  try {
    assert.ok(document.numPages > 1);
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const nonEmptyText = (content.items as unknown[]).filter(isNonEmptyPdfTextItem);
      assert.ok(nonEmptyText.length > 0, `page ${pageNumber} contains extracted text`);

      for (const textItem of nonEmptyText) {
        const item = assertPositionedPdfTextItem(textItem);
        const style = content.styles[item.fontName];
        assert.ok(style, `page ${pageNumber} text has PDF.js font metrics: ${item.str}`);
        assert.ok(
          Number.isFinite(style.ascent) && Number.isFinite(style.descent),
          `page ${pageNumber} text has finite ascent and descent metrics: ${item.str}`,
        );
        assert.equal(style.vertical, false, 'the generated resume uses horizontal text');

        const [a, b, c, d, x, y] = item.transform;
        assert.ok([a, b, c, d, x, y].every((value) => Number.isFinite(value)));
        assert.ok(Math.abs(b!) < 0.001 && Math.abs(c!) < 0.001, 'text is not rotated');
        assert.ok(d! > 0, 'text uses a positive vertical scale');
        assert.ok(item.width >= 0, 'text width is nonnegative');
        const left = Math.min(x!, x! + item.width);
        const right = Math.max(x!, x! + item.width);
        const baseline = viewport.height - y!;
        const glyphHeight = d!;
        const metricTolerance = 2;
        const top = baseline - style.ascent * glyphHeight - metricTolerance;
        const bottom = baseline - style.descent * glyphHeight + metricTolerance;
        assert.ok(
          left >= margin - 1,
          `page ${pageNumber} text starts inside the left safe margin: ${item.str}`,
        );
        assert.ok(
          right <= viewport.width - margin + 1,
          `page ${pageNumber} text ends inside the right safe margin: ${item.str}`,
        );
        assert.ok(
          top >= pageEdgePadding,
          `page ${pageNumber} text ascent stays within the top edge with a ${metricTolerance} pt font-metric tolerance: ${item.str}`,
        );
        assert.ok(
          bottom <= viewport.height - pageEdgePadding,
          `page ${pageNumber} text descent stays within the bottom edge with a ${metricTolerance} pt font-metric tolerance: ${item.str}`,
        );
      }
    }
  } finally {
    await document.destroy();
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
