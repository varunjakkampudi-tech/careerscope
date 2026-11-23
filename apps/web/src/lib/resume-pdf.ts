import { jsPDF } from 'jspdf';
import type { ResumeDraft } from './api-schemas';

export type ResumePdfDraft = Pick<ResumeDraft, 'title' | 'targetRole' | 'template' | 'content'>;
export type ResumePdfFonts = { regular: string; bold: string };

const WIN_ANSI_EXTRA = new Set([
  0x0192, 0x02c6, 0x02dc, 0x0152, 0x0153, 0x0160, 0x0161, 0x0178, 0x017d, 0x017e, 0x20ac, 0x2013,
  0x2014, 0x2018, 0x2019, 0x201a, 0x201c, 0x201d, 0x201e, 0x2020, 0x2021, 0x2022, 0x2026, 0x2030,
  0x2039, 0x203a, 0x2122,
]);

export class UnsupportedResumePdfTextError extends Error {
  constructor() {
    super(
      'Direct PDF download cannot preserve every character in this resume. Use Print or save as PDF to retain other scripts.',
    );
    this.name = 'UnsupportedResumePdfTextError';
  }
}

function isSupportedPdfCharacter(character: string) {
  const codePoint = character.codePointAt(0)!;
  return (
    codePoint === 0x09 ||
    codePoint === 0x0a ||
    codePoint === 0x0d ||
    (codePoint >= 0x20 && codePoint <= 0x7e) ||
    (codePoint >= 0xa0 && codePoint <= 0xff) ||
    WIN_ANSI_EXTRA.has(codePoint)
  );
}

function needsEmbeddedFont(character: string) {
  return !isSupportedPdfCharacter(character);
}

function collectResumeText(draft: ResumePdfDraft) {
  return [
    draft.title,
    draft.targetRole ?? '',
    draft.content.fullName,
    draft.content.email ?? '',
    draft.content.phone ?? '',
    draft.content.location ?? '',
    draft.content.summary,
    ...draft.content.skills,
    ...draft.content.experience.flatMap((item) => [
      item.role,
      item.company,
      item.location ?? '',
      item.startDate ?? '',
      item.endDate ?? '',
      ...item.bullets,
    ]),
    ...draft.content.education.flatMap((item) => [
      item.institution,
      item.qualification,
      item.location ?? '',
      item.endDate ?? '',
    ]),
  ];
}

function isSupportedByEmbeddedFont(codePoint: number) {
  return (
    (codePoint >= 0x0100 && codePoint <= 0x024f) ||
    (codePoint >= 0x0300 && codePoint <= 0x0377) ||
    (codePoint >= 0x037a && codePoint <= 0x037f) ||
    (codePoint >= 0x0384 && codePoint <= 0x038a) ||
    codePoint === 0x038c ||
    (codePoint >= 0x038e && codePoint <= 0x03a1) ||
    (codePoint >= 0x03a3 && codePoint <= 0x03e1) ||
    (codePoint >= 0x03f0 && codePoint <= 0x052f) ||
    (codePoint >= 0x1c80 && codePoint <= 0x1c88) ||
    (codePoint >= 0x1f00 && codePoint <= 0x1f15) ||
    (codePoint >= 0x1f18 && codePoint <= 0x1f1d) ||
    (codePoint >= 0x1f20 && codePoint <= 0x1f45) ||
    (codePoint >= 0x1f48 && codePoint <= 0x1f4d) ||
    (codePoint >= 0x1f50 && codePoint <= 0x1f57) ||
    codePoint === 0x1f59 ||
    codePoint === 0x1f5b ||
    codePoint === 0x1f5d ||
    (codePoint >= 0x1f5f && codePoint <= 0x1f7d) ||
    (codePoint >= 0x1f80 && codePoint <= 0x1fb4) ||
    (codePoint >= 0x1fb6 && codePoint <= 0x1fc4) ||
    (codePoint >= 0x1fc6 && codePoint <= 0x1fd3) ||
    (codePoint >= 0x1fd6 && codePoint <= 0x1fdb) ||
    (codePoint >= 0x1fdd && codePoint <= 0x1fef) ||
    (codePoint >= 0x1ff2 && codePoint <= 0x1ff4) ||
    (codePoint >= 0x1ff6 && codePoint <= 0x1ffe) ||
    (codePoint >= 0x2000 && codePoint <= 0x2064) ||
    (codePoint >= 0x2066 && codePoint <= 0x206f) ||
    (codePoint >= 0x20a0 && codePoint <= 0x20c0) ||
    (codePoint >= 0x2100 && codePoint <= 0x215f) ||
    (codePoint >= 0x2183 && codePoint <= 0x2184) ||
    codePoint === 0x2189 ||
    codePoint === 0x2212 ||
    (codePoint >= 0x2de0 && codePoint <= 0x2dff) ||
    (codePoint >= 0xa640 && codePoint <= 0xa69f)
  );
}

export function supportsDirectResumePdf(draft: ResumePdfDraft) {
  return collectResumeText(draft).every((value) =>
    Array.from(value).every((character) => {
      const codePoint = character.codePointAt(0)!;
      return isSupportedPdfCharacter(character) || isSupportedByEmbeddedFont(codePoint);
    }),
  );
}

function createFontGlyphLookup(fonts: ResumePdfFonts) {
  const pdf = new jsPDF({ putOnlyUsedFonts: true });
  pdf.addFileToVFS('NotoSans-Regular.ttf', fonts.regular);
  pdf.addFileToVFS('NotoSans-Bold.ttf', fonts.bold);
  pdf.addFont('NotoSans-Regular.ttf', 'Noto Sans', 'normal');
  pdf.addFont('NotoSans-Bold.ttf', 'Noto Sans', 'bold');
  return (style: 'normal' | 'bold', codePoint: number) => {
    pdf.setFont('Noto Sans', style);
    const metadata = pdf.getFont().metadata;
    const characterToGlyph = metadata.characterToGlyph as unknown as (codePoint: number) => number;
    return characterToGlyph.call(metadata, codePoint);
  };
}

export function hasEmbeddedFontGlyphs(draft: ResumePdfDraft, fonts: ResumePdfFonts) {
  const glyphLookup = createFontGlyphLookup(fonts);
  return collectResumeText(draft).every((value) =>
    Array.from(value).every((character) => {
      if (!needsEmbeddedFont(character)) return true;
      const codePoint = character.codePointAt(0)!;
      return glyphLookup('normal', codePoint) !== 0 && glyphLookup('bold', codePoint) !== 0;
    }),
  );
}

export function embeddedResumePdfFontsCoverSupportedCodepoints(fonts: ResumePdfFonts) {
  const glyphLookup = createFontGlyphLookup(fonts);
  for (let codePoint = 0; codePoint <= 0x10ffff; codePoint += 1) {
    if (
      isSupportedByEmbeddedFont(codePoint) &&
      (glyphLookup('normal', codePoint) === 0 || glyphLookup('bold', codePoint) === 0)
    ) {
      return false;
    }
  }
  return true;
}

export function isSupportedWithEmbeddedFontGlyphs(draft: ResumePdfDraft, fonts: ResumePdfFonts) {
  return (
    supportsDirectResumePdf(draft) &&
    (!needsEmbeddedResumePdfFont(draft) || hasEmbeddedFontGlyphs(draft, fonts))
  );
}

export function needsEmbeddedResumePdfFont(draft: ResumePdfDraft) {
  return collectResumeText(draft).some((value) => Array.from(value).some(needsEmbeddedFont));
}

function fileName(draft: ResumePdfDraft) {
  const base = [draft.title, draft.targetRole]
    .filter(Boolean)
    .join(' - ')
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120);
  return `${base || 'CareerScope Resume'}.pdf`;
}

export function createResumePdf(draft: ResumePdfDraft, fonts?: ResumePdfFonts) {
  if (!supportsDirectResumePdf(draft)) throw new UnsupportedResumePdfTextError();

  const usesEmbeddedFont = needsEmbeddedResumePdfFont(draft);
  if (usesEmbeddedFont && (!fonts || !hasEmbeddedFontGlyphs(draft, fonts)))
    throw new UnsupportedResumePdfTextError();

  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    putOnlyUsedFonts: true,
  });
  if (usesEmbeddedFont) {
    pdf.addFileToVFS('NotoSans-Regular.ttf', fonts!.regular);
    pdf.addFileToVFS('NotoSans-Bold.ttf', fonts!.bold);
    pdf.addFont('NotoSans-Regular.ttf', 'Noto Sans', 'normal');
    pdf.addFont('NotoSans-Bold.ttf', 'Noto Sans', 'bold');
  }

  const fontFamily = usesEmbeddedFont ? 'Noto Sans' : 'helvetica';
  const pageWidth = pdf.internal.pageSize.getWidth();
  const pageHeight = pdf.internal.pageSize.getHeight();
  const margin = 16;
  const footerY = pageHeight - 12;
  const contentWidth = pageWidth - margin * 2;
  const compact = draft.template === 'compact';
  const modern = draft.template === 'modern';
  const accent: [number, number, number] = modern ? [15, 76, 92] : [35, 45, 60];
  const bodySize = compact ? 9 : 10;
  const lineHeight = compact ? 4 : 4.5;
  let y = margin;

  pdf.setProperties({
    title: [draft.title, draft.targetRole].filter(Boolean).join(' - ') || 'CareerScope Resume',
    subject: 'Candidate resume',
    creator: 'CareerScope Resume Builder',
  });

  const addPageIfNeeded = (height: number) => {
    if (y + height <= footerY) return;
    pdf.addPage('a4', 'portrait');
    y = margin;
  };

  const addWrappedText = (
    value: string,
    options: {
      size?: number;
      bold?: boolean;
      indent?: number;
      color?: [number, number, number];
    } = {},
  ) => {
    const size = options.size ?? bodySize;
    pdf.setFont(fontFamily, options.bold ? 'bold' : 'normal');
    pdf.setFontSize(size);
    pdf.setTextColor(...(options.color ?? [30, 35, 40]));
    const indent = options.indent ?? 0;
    const lines = pdf.splitTextToSize(value, contentWidth - indent) as string[];
    for (const line of lines) {
      addPageIfNeeded(lineHeight);
      pdf.text(line, margin + indent, y);
      y += lineHeight;
    }
  };

  const addSectionHeading = (heading: string, firstEntry: string) => {
    const headingHeight = compact ? 10 : 14;
    // Keep a section heading with at least the first line of its content.
    const firstLineHeight = firstEntry.trim() ? lineHeight : 0;
    addPageIfNeeded(headingHeight + firstLineHeight);
    y += compact ? 2 : 4;
    pdf.setFont(fontFamily, 'bold');
    pdf.setFontSize(compact ? 10 : 11);
    pdf.setTextColor(...accent);
    pdf.text(heading, margin, y);
    y += compact ? 4 : 5;
    pdf.setDrawColor(...accent);
    pdf.setLineWidth(0.25);
    pdf.line(margin, y, pageWidth - margin, y);
    y += compact ? 4 : 5;
  };

  pdf.setFont(fontFamily, 'bold');
  pdf.setFontSize(compact ? 19 : 22);
  pdf.setTextColor(...accent);
  const nameLines = pdf.splitTextToSize(
    draft.content.fullName || 'Your name',
    contentWidth,
  ) as string[];
  for (const line of nameLines) {
    addPageIfNeeded(9);
    pdf.text(line, margin, y);
    y += compact ? 8 : 9;
  }
  if (draft.targetRole) addWrappedText(draft.targetRole, { size: 12, bold: true, color: accent });

  const contact = [draft.content.email, draft.content.phone, draft.content.location]
    .filter(Boolean)
    .join('  |  ');
  if (contact) addWrappedText(contact, { size: 8, color: [75, 82, 90] });
  y += compact ? 1 : 3;

  if (draft.content.summary.trim()) {
    addSectionHeading('Summary', draft.content.summary.trim());
    addWrappedText(draft.content.summary.trim());
  }

  if (draft.content.skills.length) {
    const skills = draft.content.skills.join('  ·  ');
    addSectionHeading('Skills', skills);
    addWrappedText(skills);
  }

  if (draft.content.experience.length) {
    const firstExperience = draft.content.experience[0]!;
    addSectionHeading(
      'Experience',
      [firstExperience.role, firstExperience.company].filter(Boolean).join(' — '),
    );
    for (const experience of draft.content.experience) {
      const dates = [experience.startDate, experience.endDate].filter(Boolean).join(' - ');
      addWrappedText([experience.role, experience.company].filter(Boolean).join(' — '), {
        bold: true,
        color: accent,
      });
      const detail = [experience.location, dates].filter(Boolean).join('  |  ');
      if (detail) addWrappedText(detail, { size: 8, color: [75, 82, 90] });
      for (const bullet of experience.bullets) addWrappedText(`- ${bullet}`, { indent: 4 });
      y += compact ? 1 : 2;
    }
  }

  if (draft.content.education.length) {
    const firstEducation = draft.content.education[0]!;
    addSectionHeading(
      'Education',
      [firstEducation.qualification, firstEducation.institution].filter(Boolean).join(' — '),
    );
    for (const education of draft.content.education) {
      addWrappedText([education.qualification, education.institution].filter(Boolean).join(' — '), {
        bold: true,
        color: accent,
      });
      const detail = [education.location, education.endDate].filter(Boolean).join('  |  ');
      if (detail) addWrappedText(detail, { size: 8, color: [75, 82, 90] });
      y += compact ? 1 : 2;
    }
  }

  const pageCount = pdf.internal.pages.length - 1;
  for (let page = 1; page <= pageCount; page += 1) {
    pdf.setPage(page);
    pdf.setFont(fontFamily, 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(110, 116, 124);
    pdf.text(`${page} / ${pageCount}`, pageWidth - margin, footerY + 5, { align: 'right' });
  }

  return { blob: pdf.output('blob'), filename: fileName(draft) };
}
