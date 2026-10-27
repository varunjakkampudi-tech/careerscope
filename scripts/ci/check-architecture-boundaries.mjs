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
  web: ['shared', 'core', 'matching', 'providers', 'resume'],
  'search-worker': ['shared', 'core', 'matching', 'providers', 'resume'],
};

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

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
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

export function analyze(root) {
  const workspaces = loadWorkspaces(root);
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
  const violations = [];
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
        else if (!(ALLOWED[workspace.name] ?? []).includes(target.name))
          report(`${workspace.name} may not import ${target.name}`);
      }
    }
  }
  return { violations, files, workspaces: workspaces.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv.find((value) => value.startsWith('--root='));
  const root = argument
    ? resolve(argument.slice('--root='.length))
    : fileURLToPath(new URL('../..', import.meta.url));
  const { violations, files, workspaces } = analyze(root);
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
