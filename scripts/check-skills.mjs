#!/usr/bin/env node
// Validates project-local agent skills: parseable frontmatter, a name matching
// the directory, a usable description, a substantive body, no machine-specific
// paths, and recorded provenance for anything vendored from a catalog.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const root = '.github/skills';
const failures = [];
const rows = [];

// Supports `key: value`, quoted values, block scalars (`|`, `>`) used by the
// catalog for long descriptions, and nested keys such as `metadata.upstream`.
// Nesting is flattened because only leaf names are checked.
function parseFrontmatter(block) {
  const fields = new Map();
  const lines = block.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const pair = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[index]);
    if (!pair) continue;
    const [, key, rawValue] = pair;
    if (/^[|>][-+]?$/.test(rawValue.trim())) {
      const indent = /^(\s*)/.exec(lines[index])[1].length;
      const collected = [];
      while (
        index + 1 < lines.length &&
        /\S/.test(lines[index + 1]) &&
        /^(\s*)/.exec(lines[index + 1])[1].length > indent
      ) {
        collected.push(lines[index + 1].trim());
        index += 1;
      }
      fields.set(key, collected.join(' '));
      continue;
    }
    if (rawValue.trim()) fields.set(key, rawValue.trim().replace(/^["']|["']$/g, ''));
  }
  return fields;
}

for (const name of readdirSync(root)) {
  const directory = join(root, name);
  if (!statSync(directory).isDirectory()) continue;
  const file = join(directory, 'SKILL.md');
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    failures.push(`${name}: missing SKILL.md`);
    continue;
  }

  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) {
    failures.push(`${name}: missing frontmatter block`);
    continue;
  }

  const fields = parseFrontmatter(match[1]);
  const description = fields.get('description') ?? '';
  const body = content.slice(match[0].length).trim();

  if (!fields.get('name')) failures.push(`${name}: no name`);
  else if (fields.get('name') !== name) {
    failures.push(`${name}: name is "${fields.get('name')}", expected "${name}"`);
  }
  if (description.length < 30) failures.push(`${name}: description too short`);
  if (body.length < 400) failures.push(`${name}: body is a stub (${body.length} bytes)`);

  // An absolute install path leaks a local username and never reproduces.
  if (/[A-Za-z]:\\|\/home\/|\/Users\/|AppData|local-path:/.test(match[1])) {
    failures.push(`${name}: frontmatter contains a machine-specific path`);
  }
  const vendored = fields.has('source') || fields.has('upstream');
  if (vendored && !fields.get('upstream')) {
    failures.push(`${name}: vendored skill has no recorded upstream`);
  }
  if (fields.get('upstream') && !fields.get('pinned-commit')) {
    failures.push(`${name}: upstream recorded without a pinned commit`);
  }

  rows.push({ name, description: description.length, body: body.length, vendored });
}

for (const row of rows) {
  process.stdout.write(
    `${row.name.padEnd(32)} desc=${String(row.description).padStart(4)} body=${String(
      row.body,
    ).padStart(6)} ${row.vendored ? 'vendored' : 'project'}\n`,
  );
}

if (failures.length) {
  process.stdout.write(`\n${failures.length} problem(s):\n${failures.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`\n${rows.length} skills valid.\n`);
}
