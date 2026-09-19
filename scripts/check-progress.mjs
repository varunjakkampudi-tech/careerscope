#!/usr/bin/env node
// A percentage nobody can trace is worse than no percentage: it gets read,
// quoted and planned against. This refuses any area claiming VERIFIED without
// evidence, and any number without something behind it.

import { readFileSync } from 'node:fs';

const PATH = '.ai/progress.json';
const STATUSES = ['VERIFIED', 'IN PROGRESS', 'NOT STARTED', 'BLOCKED', 'UNMEASURED'];

let progress;
try {
  progress = JSON.parse(readFileSync(PATH, 'utf8'));
} catch (error) {
  // Unreadable is not "nothing to report".
  console.error(`::error::${PATH} is unreadable: ${error.message}. Refusing to report progress.`);
  process.exit(1);
}

if (!Array.isArray(progress.areas)) {
  console.error(`::error::${PATH} has no areas array. Refusing.`);
  process.exit(1);
}

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`  FAIL  ${message}`);
};

for (const area of progress.areas) {
  const name = area?.area ?? '(unnamed)';
  if (!area || typeof area !== 'object') {
    fail(`${name}: not an object`);
    continue;
  }
  if (!STATUSES.includes(area.status)) {
    fail(`${name}: status ${JSON.stringify(area.status)} is not one of ${STATUSES.join(', ')}`);
  }

  const evidence = Array.isArray(area.evidence) ? area.evidence.filter(Boolean) : [];

  if (area.status === 'VERIFIED' && evidence.length === 0) {
    fail(`${name}: claims VERIFIED with no evidence`);
  }
  if (area.percent !== null && evidence.length === 0) {
    fail(`${name}: states ${area.percent}% with no evidence`);
  }
  if (area.status === 'UNMEASURED' && area.percent !== null) {
    fail(`${name}: UNMEASURED but still reports a number (${area.percent})`);
  }
  if (
    area.percent !== null &&
    (typeof area.percent !== 'number' || area.percent < 0 || area.percent > 100)
  ) {
    fail(`${name}: percent ${JSON.stringify(area.percent)} is not a number between 0 and 100`);
  }
}

if (failures > 0) {
  console.error(`\n::error::${failures} progress claim(s) unsupported.`);
  process.exit(1);
}

const measured = progress.areas.filter((a) => a.percent !== null).length;
console.log(
  `PASS  ${progress.areas.length} areas, ${measured} measured with evidence, ` +
    `${progress.areas.length - measured} honestly unmeasured`,
);
