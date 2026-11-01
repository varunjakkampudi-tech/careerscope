import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// zod-config.ts turns off zod's `new Function` probe, which the production CSP blocks. It only
// works if it runs before the first zod schema is built, so every client module that pulls in zod
// (directly or through @careerscope/shared) must import it first.

const srcDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

const importPattern = /^import\s+([^;]*?)\s*from\s*['"]([^'"]+)['"]|^import\s*['"]([^'"]+)['"]/gm;
const usesZod = (specifier: string) =>
  specifier === 'zod' || specifier.startsWith('@careerscope/shared');
const isZodConfig = (specifier: string) => /(^|\/)zod-config$/.test(specifier);

/** A value import erases to nothing when it is `import type ...` or every named member is `type`. */
function isTypeOnly(clause: string | undefined) {
  if (clause === undefined) return false;
  if (/^type\s/.test(clause)) return true;
  const named = /^\{([^}]*)\}$/.exec(clause.trim());
  return (
    named !== null &&
    named[1]!.split(',').every((part) => part.trim() === '' || /^type\s/.test(part.trim()))
  );
}

/** Returns the first import (in source order) that loads zod or shared, and whether zod-config precedes it. */
export function zodImportProblem(source: string) {
  let configSeen = false;
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[2] ?? match[3] ?? '';
    if (isZodConfig(specifier)) configSeen = true;
    else if (usesZod(specifier) && !isTypeOnly(match[1]) && !configSeen) return specifier;
  }
  return undefined;
}

test('the detector flags a zod or shared import that comes before zod-config', () => {
  assert.equal(zodImportProblem(`import { z } from 'zod';\nimport './zod-config';`), 'zod');
  assert.equal(zodImportProblem(`import { A } from '@careerscope/shared';`), '@careerscope/shared');
  assert.equal(
    zodImportProblem(`import '../lib/zod-config';\nimport { z } from 'zod';`),
    undefined,
  );
  assert.equal(zodImportProblem(`import type { A } from '@careerscope/shared';`), undefined);
  assert.equal(
    zodImportProblem(`import { type A, type B } from '@careerscope/shared';`),
    undefined,
  );
});

test('every client module that imports zod or @careerscope/shared imports zod-config first', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(srcDir)) {
    const rel = relative(srcDir, file).split(sep).join('/');
    if (rel === 'lib/zod-config.ts') continue;
    const source = readFileSync(file, 'utf8');
    const isClientModule =
      /^\s*['"]use client['"]/m.test(source) ||
      rel.startsWith('lib/') ||
      rel.startsWith('components/');
    const problem = isClientModule ? zodImportProblem(source) : undefined;
    if (problem) offenders.push(`${rel} imports ${problem} before (or without) zod-config`);
  }
  assert.deepEqual(offenders, []);
});
