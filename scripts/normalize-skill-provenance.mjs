#!/usr/bin/env node
// `gh skill install --from-local` records the temporary clone path in each
// SKILL.md. That leaks a local username and never reproduces elsewhere, so it is
// rewritten to the pinned upstream source. Safe to re-run.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const root = '.github/skills';
const upstream = 'sickn33/agentic-awesome-skills';
const tag = 'v17.5.0';
const commit = 'ebffb8789f6f36047ba76ed7233380b4d837d371';

let rewritten = 0;
for (const name of readdirSync(root)) {
  const file = join(root, name, 'SKILL.md');
  if (!existsSync(file)) continue;
  const content = readFileSync(file, 'utf8');
  const replaced = content.replace(
    /^(\s*)local-path:.*$/m,
    `$1upstream: ${upstream}\n$1pinned-tag: ${tag}\n$1pinned-commit: ${commit}`,
  );
  if (replaced !== content) {
    writeFileSync(file, replaced);
    rewritten += 1;
    process.stdout.write(`rewrote ${name}\n`);
  }
}
process.stdout.write(`${rewritten} skill(s) updated\n`);
