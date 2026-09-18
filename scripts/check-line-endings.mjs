#!/usr/bin/env node
// Fails if a file that must be LF contains a CR byte in the working tree.
//
// .gitattributes governs what Git stores; it does not govern what a tool on
// this machine reads a moment after writing it. The defect this guards against
// was exactly that gap: a CRLF file made a multiline regex match nothing, and
// the validator reported "No entries yet" for a file holding three entries.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const LF_ONLY = /\.(md|json|js|cjs|mjs|ts|tsx|css|html|ya?ml|sh)$/i;

// The canonical state files are called out separately: these are the ones read
// by gates, and a silent parse difference here changes a release decision.
const CRITICAL = /^(\.ai\/|\.github\/(agents|workflows)\/|scripts\/)/;

let tracked;
try {
  tracked = execFileSync('git', ['ls-files', '-z'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
} catch (error) {
  // Being unable to list files is not "no offenders".
  console.error(`::error::Could not list tracked files: ${error.message}`);
  process.exit(1);
}

const offenders = [];
for (const file of tracked) {
  if (!LF_ONLY.test(file)) continue;
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch (error) {
    if (error.code === 'ENOENT') continue; // deleted but still indexed
    console.error(`::error::Could not read ${file}: ${error.message}`);
    process.exit(1);
  }
  if (buffer.includes(0x0d)) {
    offenders.push({ file, critical: CRITICAL.test(file) });
  }
}

if (offenders.length === 0) {
  console.log(
    `PASS  no CR bytes in ${tracked.filter((f) => LF_ONLY.test(f)).length} LF-only files`,
  );
  process.exit(0);
}

const critical = offenders.filter((o) => o.critical);
for (const { file, critical: isCritical } of offenders) {
  console.error(`  CRLF  ${file}${isCritical ? '  (read by a gate)' : ''}`);
}
console.error(
  `\n::error::${offenders.length} file(s) contain CR bytes where LF is required` +
    `${critical.length ? `, ${critical.length} of them read by a gate` : ''}.` +
    ` Fix with: git add --renormalize .`,
);
process.exit(1);
