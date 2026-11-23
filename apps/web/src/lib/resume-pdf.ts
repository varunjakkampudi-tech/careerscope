import { jsPDF } from 'jspdf';
import type { ResumeDraft } from './api-schemas';

export type ResumePdfDraft = Pick<ResumeDraft, 'title' | 'targetRole' | 'template' | 'content'>;

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

export function supportsDirectResumePdf(draft: ResumePdfDraft) {
  return collectResumeText(draft).every((value) =>
    Array.from(value).every(isSupportedPdfCharacter),
  );
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

export function createResumePdf(draft: ResumePdfDraft) {
  if (!supportsDirectResumePdf(draft)) throw new UnsupportedResumePdfTextError();

  const pdf = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    putOnlyUsedFonts: true,
  });
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
    pdf.setFont('helvetica', options.bold ? 'bold' : 'normal');
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
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(compact ? 10 : 11);
    pdf.setTextColor(...accent);
    pdf.text(heading, margin, y);
    y += compact ? 4 : 5;
    pdf.setDrawColor(...accent);
    pdf.setLineWidth(0.25);
    pdf.line(margin, y, pageWidth - margin, y);
    y += compact ? 4 : 5;
  };

  pdf.setFont('helvetica', 'bold');
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
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(110, 116, 124);
    pdf.text(`${page} / ${pageCount}`, pageWidth - margin, footerY + 5, { align: 'right' });
  }

  return { blob: pdf.output('blob'), filename: fileName(draft) };
}
