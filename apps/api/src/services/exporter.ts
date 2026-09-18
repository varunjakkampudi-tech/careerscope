/**
 * Lead export — XLSX and CSV.
 *
 * The spreadsheet is not a dump of the table on screen. It is what the user
 * actually works from: a tracker they sort, filter, annotate and come back to a
 * week later. Three decisions follow from that:
 *
 *  - **The score is a number, not "87%".** Written as `0.87` with a percent
 *    number format, so Excel's own sort and filter work on it. A string column
 *    sorts "9%" above "87%", which is exactly the sort a user reaches for first.
 *  - **Links are real hyperlinks.** Four of them per row — the posting, the
 *    company site, the careers portal and the ATS form — because clicking them
 *    is the point of the export.
 *  - **An unverified email is not exported as an email.** The cell says "Apply
 *    via portal" instead. An address this app guessed would be mailed by someone
 *    trusting the sheet, and that is a worse failure than a blank cell.
 *
 * CSV is written by hand rather than through exceljs. The library's CSV writer
 * drops the number formats and hyperlinks that justify the XLSX path at all, so
 * there is nothing to reuse — and writing it here is what allows the UTF-8 BOM
 * below, without which Excel renders ₹ and – as mojibake.
 */

import {
  formatSalary,
  MATCH_DIMENSION_LABELS,
  MATCH_WEIGHTS,
  type Lead,
  type MatchDimension,
} from '@job-radar/shared';
import ExcelJS from 'exceljs';

const SHEET = 'Job Leads';

/**
 * UTF-8 byte-order mark, prepended to every CSV.
 *
 * Load-bearing: without it Excel decodes the file as the system ANSI code page
 * and every ₹, – and é in it becomes mojibake. Every other tool ignores it.
 * Written as an escape rather than a literal so it survives an editor that
 * would otherwise strip an invisible character it cannot see.
 */
const BOM = '\uFEFF';

/** Excel's hard limit is 32,767 characters per cell; JDs do reach it. */
const MAX_CELL_CHARS = 32_000;

/** Header fill — the same navy the old application logbook used. */
const HEADER_FILL: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: 'FF1F4E78' },
};

const COLUMNS: ReadonlyArray<{ header: string; key: string; width: number }> = [
  { header: 'Match', key: 'score', width: 9 },
  { header: 'Role', key: 'title', width: 38 },
  { header: 'Company', key: 'company', width: 26 },
  { header: 'Package', key: 'package', width: 22 },
  { header: 'Location', key: 'location', width: 22 },
  { header: 'Remote', key: 'remote', width: 9 },
  { header: 'Employment', key: 'employment', width: 13 },
  { header: 'Experience', key: 'experience', width: 12 },
  { header: 'Posted', key: 'posted', width: 12 },
  { header: 'Status', key: 'status', width: 13 },
  { header: 'Source', key: 'source', width: 18 },
  { header: 'Tech Stack', key: 'techStack', width: 40 },
  { header: 'Matched Skills', key: 'matched', width: 40 },
  { header: 'Missing Skills', key: 'missing', width: 32 },
  { header: 'Apply Link', key: 'applyUrl', width: 42 },
  { header: 'Posting Link', key: 'sourceUrl', width: 42 },
  { header: 'Company Website', key: 'website', width: 34 },
  { header: 'Careers Portal', key: 'portal', width: 38 },
  { header: 'Careers Email', key: 'email', width: 30 },
  { header: 'Confidence', key: 'confidence', width: 12 },
  { header: 'Why This Score', key: 'rationale', width: 60 },
  { header: 'Notes', key: 'note', width: 40 },
  { header: 'Job Description', key: 'description', width: 80 },
];

/**
 * Dimension columns are appended so the score stays auditable in the sheet.
 *
 * Derived from `MATCH_WEIGHTS` rather than hand-listed — the schema builds its
 * dimension shape the same way, so adding a dimension to the engine reaches the
 * export without anyone remembering to come here.
 */
const DIMENSIONS = Object.keys(MATCH_WEIGHTS) as MatchDimension[];

export interface ExportOptions {
  /** Stamped into the workbook properties so an old export is identifiable. */
  generatedAt?: string | undefined;
  /** The threshold the leads were filtered at, recorded for the same reason. */
  minScore?: number | undefined;
}

/* -------------------------------------------------------------------------- */
/* XLSX                                                                       */
/* -------------------------------------------------------------------------- */

export async function exportLeadsXlsx(
  leads: readonly Lead[],
  options: ExportOptions = {},
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CareerScope';
  workbook.created = new Date(options.generatedAt ?? Date.now());
  // Recorded in the file's properties rather than in a banner row, so the sheet
  // stays a clean table that Excel's own filters and pivots can consume.
  workbook.description =
    options.minScore === undefined
      ? 'All stored leads'
      : `Leads at or above ${Math.round(options.minScore * 100)}%`;

  const sheet = workbook.addWorksheet(SHEET, {
    // Freeze the header and the Match column: scrolling right through twenty
    // columns is useless if you lose which row you are on.
    views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }],
  });

  sheet.columns = [
    ...COLUMNS.map((column) => ({ header: column.header, key: column.key, width: column.width })),
    ...DIMENSIONS.map((dimension) => ({
      header: MATCH_DIMENSION_LABELS[dimension],
      key: `dim_${dimension}`,
      width: 13,
    })),
  ];

  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = HEADER_FILL;
  header.alignment = { vertical: 'middle' };
  header.height = 22;

  for (const lead of leads) {
    const row = sheet.addRow(toRow(lead));

    // A number with a percent format, not a formatted string — see the module
    // note. The tint makes a strong match findable at a glance.
    const score = row.getCell('score');
    score.numFmt = '0%';
    score.font = { bold: true, color: { argb: scoreColour(lead.match.score) } };

    for (const dimension of DIMENSIONS) row.getCell(`dim_${dimension}`).numFmt = '0%';

    link(row.getCell('applyUrl'), lead.job.applyUrl);
    link(row.getCell('sourceUrl'), lead.job.sourceUrl);
    link(row.getCell('website'), lead.job.company.website);
    link(row.getCell('portal'), lead.job.company.atsPortalUrl ?? lead.job.company.careersUrl);
    if (isMailable(lead)) link(row.getCell('email'), `mailto:${lead.job.company.careersEmail}`);

    // Wrapped, top-aligned: without this a 4,000-character JD renders as one
    // unreadable line and the row heights are meaningless.
    for (const key of ['techStack', 'matched', 'missing', 'rationale', 'note', 'description']) {
      row.getCell(key).alignment = { wrapText: true, vertical: 'top' };
    }
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, leads.length + 1), column: sheet.columns.length },
  };

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/* -------------------------------------------------------------------------- */
/* CSV                                                                        */
/* -------------------------------------------------------------------------- */

export function exportLeadsCsv(leads: readonly Lead[]): string {
  const headers = [
    ...COLUMNS.map((c) => c.header),
    ...DIMENSIONS.map((d) => MATCH_DIMENSION_LABELS[d]),
  ];
  const lines = [headers.map(csvCell).join(',')];

  for (const lead of leads) {
    const row = toRow(lead);
    const values = [
      ...COLUMNS.map((column) => row[column.key]),
      ...DIMENSIONS.map((dimension) => row[`dim_${dimension}`]),
    ];
    lines.push(values.map(csvCell).join(','));
  }

  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/* -------------------------------------------------------------------------- */
/* Row shaping                                                                */
/* -------------------------------------------------------------------------- */

type RowValues = Record<string, string | number | null>;

function toRow(lead: Lead): RowValues {
  const { job, match } = lead;

  const row: RowValues = {
    score: round(match.score),
    title: job.title,
    company: job.company.name,
    package: formatSalary(job.salary),
    location: job.location,
    remote: job.isRemote ? 'Yes' : 'No',
    employment: job.employmentType ?? '',
    experience: formatYears(job.requiredYears),
    // Date only. The time a board happened to publish at is noise in a tracker,
    // and a bare date is what Excel will parse back into a date.
    posted: job.postedAt ? job.postedAt.slice(0, 10) : '',
    status: lead.status,
    // "JSearch · via LinkedIn" — see `sourcePublisher` in the job schema.
    source: job.sourcePublisher ? `${job.source} · via ${job.sourcePublisher}` : job.source,
    techStack: job.techStack.join(', '),
    matched: match.matchedSkills.join(', '),
    missing: match.missingSkills.join(', '),
    applyUrl: job.applyUrl,
    sourceUrl: job.sourceUrl,
    website: job.company.website ?? 'Not yet verified',
    portal: job.company.atsPortalUrl ?? job.company.careersUrl ?? 'Not yet verified',
    email: isMailable(lead) ? (job.company.careersEmail ?? '') : 'Apply via portal',
    confidence: match.confidence === 'low' ? 'Snippet only' : 'Full JD',
    rationale: rationale(lead),
    note: lead.note,
    description: truncate(job.descriptionText, MAX_CELL_CHARS),
  };

  for (const dimension of DIMENSIONS) {
    row[`dim_${dimension}`] = round(match.dimensions[dimension].score);
  }
  return row;
}

/**
 * The one-line "why".
 *
 * Prefers Claude's rationale when the semantic pass ran, because it reads as a
 * sentence. Otherwise the two weakest dimensions are named — what is wrong with
 * a match is more actionable than what is right with it.
 */
function rationale(lead: Lead): string {
  const { match } = lead;
  if (match.excludedReason) return `Excluded: ${match.excludedReason}`;
  if (match.llmRationale) return match.llmRationale;

  const weakest = DIMENSIONS.map((dimension) => ({
    dimension,
    ...match.dimensions[dimension],
  }))
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, 2)
    .map((entry) => entry.reason);

  const flagged = match.flaggedCompany ? 'Company is on your do-not-apply list. ' : '';
  return `${flagged}${weakest.join(' ')}`.trim();
}

/**
 * Whether an address is safe to put in a mailto.
 *
 * `unverified` means the app inferred it rather than read it off a page the
 * employer published. Those are never exported as addresses.
 */
function isMailable(lead: Lead): boolean {
  return (
    lead.job.company.careersEmail !== null && lead.job.company.emailConfidence !== 'unverified'
  );
}

/* -------------------------------------------------------------------------- */
/* Cell helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Turns a cell into a hyperlink, leaving it alone when there is nothing to link. */
function link(cell: ExcelJS.Cell, url: string | null): void {
  if (!url || !/^(https?:|mailto:)/i.test(url)) return;
  const text = String(cell.value ?? url);
  cell.value = { text, hyperlink: url };
  cell.font = { color: { argb: 'FF0563C1' }, underline: true };
}

/** Green at or above the default threshold, amber in the sixties, grey below. */
function scoreColour(score: number): string {
  if (score >= 0.85) return 'FF1E7B34';
  if (score >= 0.7) return 'FFB06000';
  return 'FF595959';
}

function formatYears(years: { min: number | null; max: number | null }): string {
  const { min, max } = years;
  if (min === null && max === null) return '';
  if (min !== null && max !== null) return min === max ? `${min} yrs` : `${min}–${max} yrs`;
  return min !== null ? `${min}+ yrs` : `up to ${max} yrs`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * RFC 4180 quoting.
 *
 * A leading `=`, `+`, `-` or `@` is prefixed with a tab, because Excel treats
 * such a cell as a formula. A job title starting with "-" is harmless; a
 * scraped field starting with `=cmd|` is a CSV injection, and neither this code
 * nor the user can tell them apart at export time.
 */
function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'number' ? String(value) : value;
  const guarded = /^[=+\-@\t\r]/.test(text) ? `\t${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
