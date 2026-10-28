#!/usr/bin/env node
// Enforces the workspace dependency graph documented in
// docs/architecture/BOUNDARIES.md by reading every workspace's source imports.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

// Workspace name (without scope) -> workspaces it may import. Anything not
// listed is a violation. Apps never import other apps.
export const ALLOWED = {
  shared: [],
  matching: ['shared'],
  resume: ['shared'],
  providers: ['shared', 'matching'],
  core: ['shared', 'resume'],
  api: ['shared', 'core', 'matching', 'providers', 'resume'],
  web: ['shared', 'matching', 'providers', 'resume'],
  'search-worker': ['shared', 'core', 'matching', 'providers', 'resume'],
};

// The web app must not depend on core (database, queue and server-side code). Three components
// still import types from it; those exact files are reported as warnings instead of failing the
// build, and any other web import of core fails. Remove an entry when its import is removed.
export const WEB_CORE_BASELINE = new Set([
  'apps/web/src/components/job-search-view.tsx',
  'apps/web/src/components/match-evidence.tsx',
  'apps/web/src/components/profile-editor.tsx',
]);

const SCOPE = '@careerscope/';
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const SKIPPED_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  'dist-types',
  '.next',
  '__fixtures__',
]);

export function isTestFile(path) {
  return TEST_FILE.test(path) || path.split(/[\\/]/).includes('__tests__');
}

function expandWorkspaces(root, patterns) {
  const directories = [];
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const base = join(root, pattern.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        const directory = join(base, entry.name);
        if (entry.isDirectory() && existsSync(join(directory, 'package.json')))
          directories.push(directory);
      }
    } else if (existsSync(join(root, pattern, 'package.json'))) {
      directories.push(join(root, pattern));
    }
  }
  return directories;
}

export function loadWorkspaces(root) {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  return expandWorkspaces(root, manifest.workspaces ?? []).map((directory) => {
    const name = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).name ?? '';
    const short = name.startsWith(SCOPE) ? name.slice(SCOPE.length) : name;
    return {
      name: short,
      directory,
      kind: relative(root, directory).split(sep)[0] === 'packages' ? 'package' : 'app',
    };
  });
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (SOURCE_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) yield path;
  }
}

/**
 * Removes comments without touching string literals, so a comment marker inside a string (for
 * example the glob in `import x from './a/*'`) can neither hide a later import nor be mistaken
 * for a comment start. Comments become spaces, keeping line breaks, so `^` anchors still work.
 * Limits: a regex literal that contains a quote or a backtick can confuse the scanner; quote
 * state is reset at each line break for ' and " strings so such a mistake cannot run on.
 */
export function stripComments(source) {
  let output = '';
  let index = 0;
  let quote = null;
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      output += char;
      if (char === '\\' && next !== undefined) {
        output += next;
        index += 2;
        continue;
      }
      if (char === quote || (char === '\n' && quote !== '`')) quote = null;
      index += 1;
    } else if (char === '"' || char === "'" || char === '`') {
      quote = char;
      output += char;
      index += 1;
    } else if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
    } else if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      output += source.slice(index, stop).replace(/[^\n]/g, ' ');
      index = stop;
    } else {
      output += char;
      index += 1;
    }
  }
  return output;
}

export function extractSpecifiers(source) {
  const text = stripComments(source);
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s[^'";]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /^\s*import\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns)
    for (const match of text.matchAll(pattern)) specifiers.add(match[1]);
  return [...specifiers];
}

function owner(workspaces, path) {
  return workspaces.find((workspace) => {
    const inside = relative(workspace.directory, path);
    return inside !== '' && !inside.startsWith('..') && !/^[a-zA-Z]:/.test(inside);
  });
}

export function analyze(root, { webCoreBaseline = WEB_CORE_BASELINE } = {}) {
  const workspaces = loadWorkspaces(root);
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const violations = [];
  const warnings = [];
  let files = 0;

  for (const workspace of workspaces) {
    const source = join(workspace.directory, 'src');
    if (!existsSync(source) || !statSync(source).isDirectory()) continue;
    for (const file of walk(source)) {
      files += 1;
      const display = relative(root, file).split(sep).join('/');
      for (const specifier of extractSpecifiers(readFileSync(file, 'utf8'))) {
        let target;
        let resolvedPath;
        if (specifier.startsWith(SCOPE)) {
          target = byName.get(specifier.slice(SCOPE.length).split('/')[0]);
        } else if (specifier.startsWith('.')) {
          resolvedPath = resolve(dirname(file), specifier);
          target = owner(workspaces, resolvedPath);
        } else {
          continue;
        }
        const report = (rule) => violations.push({ file: display, specifier, rule });

        if (resolvedPath && isTestFile(resolvedPath) && !isTestFile(file))
          report('module imports from a test file');
        if (!target || target === workspace) continue;
        if (target.kind === 'app' && workspace.kind === 'package')
          report(`package ${workspace.name} imports app ${target.name}`);
        else if (target.kind === 'app') report(`app ${workspace.name} imports app ${target.name}`);
        else if (workspace.name === 'shared')
          report(`shared imports internal package ${target.name}`);
        else if (
          target.name === 'core' &&
          ['providers', 'matching', 'resume'].includes(workspace.name)
        )
          report(`${workspace.name} imports core`);
        else if (workspace.name === 'web' && target.name === 'core') {
          if (webCoreBaseline.has(display))
            warnings.push({
              file: display,
              specifier,
              rule: 'web imports core (known, to remove)',
            });
          else report('web may not import core');
        } else if (!(ALLOWED[workspace.name] ?? []).includes(target.name))
          report(`${workspace.name} may not import ${target.name}`);
      }
    }
  }
  return { violations, warnings, files, workspaces: workspaces.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv.find((value) => value.startsWith('--root='));
  const root = argument
    ? resolve(argument.slice('--root='.length))
    : fileURLToPath(new URL('../..', import.meta.url));
  const { violations, warnings, files, workspaces } = analyze(root);
  for (const w of warnings)
    console.warn(`::warning file=${w.file}::${w.rule}: imports '${w.specifier}'`);
  if (violations.length) {
    for (const v of violations)
      console.error(`::error file=${v.file}::${v.rule}: imports '${v.specifier}'`);
    console.error(`FAIL ${violations.length} architecture boundary violation(s)`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `PASS architecture boundaries: ${files} files in ${workspaces} workspaces\n`,
    );
  }
}
