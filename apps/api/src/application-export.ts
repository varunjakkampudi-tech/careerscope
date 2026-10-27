/**
 * CSV export of a user's applications. Takes `LeadRecord`s from `@careerscope/core`; the route in
 * `app.ts` supplies only the signed-in user's rows.
 */

import type { LeadRecord } from '@careerscope/core';

/** Header row. Columns that come from the candidate's own claim are labelled "Candidate-reported". */
const columns = [
  'Job title',
  'Company',
  'Location',
  'Source',
  'Official job URL',
  'Application status',
  'Status updated at (UTC)',
  'Candidate-reported applied at (UTC)',
  'Candidate-reported method',
  'Candidate-reported confirmation',
  'Candidate-reported confidence',
  'Candidate-reported source',
  'Notes',
] as const;

/** Quotes a value for CSV and neutralises spreadsheet formulas: a leading `=`, `+`, `-` or `@` (after any whitespace or control characters) gets a `'` prefix. */
function csvCell(value: string | Date | null): string {
  const text = value instanceof Date ? value.toISOString() : (value ?? '');
  // Spreadsheet applications may execute cells beginning with formula
  // operators. Prefix those values as text, including when whitespace/control
  // characters precede the operator. CSV quoting alone does not prevent this.
  let firstContent = 0;
  while (
    firstContent < text.length &&
    (text.charCodeAt(firstContent) <= 0x20 || text.charCodeAt(firstContent) === 0x7f)
  ) {
    firstContent++;
  }
  const firstCharacter = text[firstContent];
  const safe = ['=', '+', '-', '@'].includes(firstCharacter ?? '') ? `'${text}` : text;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** Builds the CSV text with CRLF line endings. Every cell is quoted and formula-safe. */
export function applicationsCsv(records: readonly LeadRecord[]): string {
  const rows = records.map((record) => {
    const evidence = record.applicationEvidence;
    return [
      record.data.title,
      record.data.company,
      record.data.location,
      record.data.source,
      record.data.applyUrl,
      record.status,
      record.updatedAt,
      evidence?.appliedAt ?? null,
      evidence?.method ?? null,
      evidence?.confirmation ?? null,
      evidence?.confidence ?? null,
      evidence?.source ?? null,
      record.notes,
    ] as const;
  });
  return [columns, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
