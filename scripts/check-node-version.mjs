#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const rootArgument = process.argv.find((argument) => argument.startsWith('--root='));
const root = rootArgument
  ? rootArgument.slice('--root='.length)
  : fileURLToPath(new URL('..', import.meta.url));

function major(value, source, range = false) {
  const pattern = range ? /^>=\s*(\d+)(?:\.\d+)?(?:\.\d+)?$/ : /^v?(\d+)(?:\.\d+)?(?:\.\d+)?$/;
  const match = pattern.exec(String(value).trim());
  if (!match) throw new Error(`${source} declares an unsupported Node version: ${value}`);
  return Number(match[1]);
}

try {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (!manifest.engines?.node) throw new Error('package.json must declare engines.node.');
  const declarations = [
    {
      source: 'package.json engines.node',
      major: major(manifest.engines.node, 'package.json', true),
    },
    { source: '.nvmrc', major: major(readFileSync(join(root, '.nvmrc'), 'utf8'), '.nvmrc') },
  ];

  // Hosted automation is optional after its owner-authorized removal. Any
  // restored workflow pins remain subject to the same consistency check.
  const directory = join(root, '.github', 'workflows');
  const workflows = existsSync(directory)
    ? readdirSync(directory).filter((name) => /\.ya?ml$/.test(name))
    : [];
  let pins = 0;
  for (const name of workflows) {
    const text = readFileSync(join(directory, name), 'utf8');
    const pinned = /^\s*NODE_VERSION:\s*['"]?(\d+(?:\.\d+){0,2})['"]?\s*$/m.exec(text);
    if (pinned) {
      pins += 1;
      declarations.push({ source: name, major: major(pinned[1], name) });
    }
  }
  if (workflows.length && !pins) throw new Error('No workflow pins NODE_VERSION.');
  if (!workflows.length)
    process.stdout.write('Hosted workflows are absent; validating local Node declarations.\n');

  if (new Set(declarations.map((entry) => entry.major)).size !== 1) {
    throw new Error(
      `Inconsistent Node declarations: ${declarations.map((entry) => `${entry.source}=${entry.major}`).join(', ')}`,
    );
  }
  const required = declarations[0].major;
  if (major(process.versions.node, 'running runtime') < required) {
    throw new Error(`Node v${process.versions.node} is below the required major ${required}.`);
  }
  process.stdout.write(
    `PASS Node v${process.versions.node} satisfies the floor of ${required}, declared consistently in ${declarations.length} places\n`,
  );
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
}
