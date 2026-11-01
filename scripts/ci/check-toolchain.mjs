#!/usr/bin/env node
// Fails when the declared toolchain disagrees with itself:
//   - Node: package.json engines floor, .nvmrc, workflow NODE_VERSION pins and
//     the Dockerfile base image major.
//   - Next.js and Fastify: the major declared by every workspace, the major
//     resolved in package-lock.json, and eslint-config-next against next.
// The engines value is a floor (">=24"). .nvmrc and workflow pins must equal it.
// The production image must run the same Node major as .nvmrc and CI: a different
// major is a failure, never a warning, because tests do not run on the other major.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DOCKERFILES = ['infra/docker/Dockerfile', 'Dockerfile'];

function majorOf(value, source) {
  const match = /(\d+)(?:\.\d+)?(?:\.\d+)?/.exec(String(value));
  if (!match) throw new Error(`${source}: cannot read a major version from "${value}"`);
  return Number(match[1]);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function workspaceManifests(root) {
  const manifests = [{ path: 'package.json', json: readJson(join(root, 'package.json')) }];
  for (const pattern of manifests[0].json.workspaces ?? []) {
    if (!pattern.endsWith('/*')) continue;
    const base = join(root, pattern.slice(0, -2));
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const file = join(base, entry.name, 'package.json');
      if (entry.isDirectory() && existsSync(file))
        manifests.push({
          path: `${pattern.slice(0, -1)}${entry.name}/package.json`,
          json: readJson(file),
        });
    }
  }
  return manifests;
}

export function analyze(root) {
  const errors = [];
  const warnings = [];
  const facts = [];
  let nvmMajor = null;
  const manifest = readJson(join(root, 'package.json'));

  // Node
  if (!manifest.engines?.node) errors.push('package.json must declare engines.node');
  const floor = manifest.engines?.node ? majorOf(manifest.engines.node, 'engines.node') : null;
  if (floor !== null) facts.push(`engines.node floor ${floor}`);
  if (!existsSync(join(root, '.nvmrc'))) errors.push('.nvmrc is missing');
  else {
    const nvm = majorOf(readFileSync(join(root, '.nvmrc'), 'utf8'), '.nvmrc');
    facts.push(`.nvmrc ${nvm}`);
    nvmMajor = nvm;
    if (floor !== null && nvm !== floor)
      errors.push(`.nvmrc major ${nvm} does not equal the engines.node floor ${floor}`);
  }
  const workflows = join(root, '.github', 'workflows');
  for (const name of existsSync(workflows) ? readdirSync(workflows) : []) {
    if (!/\.ya?ml$/.test(name)) continue;
    const pin = /^\s*NODE_VERSION:\s*['"]?(\d+(?:\.\d+){0,2})['"]?\s*$/m.exec(
      readFileSync(join(workflows, name), 'utf8'),
    );
    if (!pin) continue;
    const pinned = majorOf(pin[1], name);
    facts.push(`${name} NODE_VERSION ${pinned}`);
    if (floor !== null && pinned !== floor)
      errors.push(
        `${name} NODE_VERSION major ${pinned} does not equal the engines.node floor ${floor}`,
      );
  }
  const dockerfile = DOCKERFILES.map((path) => join(root, path)).find((path) => existsSync(path));
  if (!dockerfile) errors.push(`no Dockerfile found (looked for ${DOCKERFILES.join(', ')})`);
  else {
    const text = readFileSync(dockerfile, 'utf8');
    const images = [...text.matchAll(/^(?:ARG\s+NODE_IMAGE=|FROM\s+)node:(\d+)[^\s@]*/gm)].map(
      (match) => Number(match[1]),
    );
    if (!images.length) errors.push('Dockerfile does not declare a node:<major> base image');
    for (const image of new Set(images)) {
      facts.push(`Dockerfile node image ${image}`);
      if (floor !== null && image < floor)
        errors.push(`Dockerfile Node major ${image} is below the engines.node floor ${floor}`);
      else if (nvmMajor !== null && image !== nvmMajor)
        errors.push(
          `Dockerfile Node major ${image} differs from .nvmrc major ${nvmMajor}; the production image must run the Node major that CI tests`,
        );
      else if (floor !== null && image !== floor)
        errors.push(`Dockerfile Node major ${image} differs from the engines.node floor ${floor}`);
    }
  }

  // Next.js and Fastify
  const lockPath = join(root, 'package-lock.json');
  const lock = existsSync(lockPath) ? readJson(lockPath) : null;
  if (!lock) errors.push('package-lock.json is missing');
  const manifests = workspaceManifests(root);
  const declared = (name) =>
    manifests.flatMap(({ path, json }) => {
      const range = { ...json.dependencies, ...json.devDependencies }[name];
      return range ? [{ path, major: majorOf(range, `${path} ${name}`) }] : [];
    });
  const resolved = {};
  for (const name of ['next', 'fastify']) {
    const entries = declared(name);
    if (!entries.length) {
      errors.push(`no workspace declares ${name}`);
      continue;
    }
    if (new Set(entries.map((entry) => entry.major)).size !== 1)
      errors.push(
        `${name} major differs between workspaces: ${entries.map((e) => `${e.path}=${e.major}`).join(', ')}`,
      );
    const locked = lock?.packages?.[`node_modules/${name}`];
    if (!locked?.version) {
      errors.push(`package-lock.json does not resolve ${name}`);
      continue;
    }
    resolved[name] = majorOf(locked.version, `lockfile ${name}`);
    facts.push(`${name} declared ${entries[0].major}, locked ${locked.version}`);
    if (resolved[name] !== entries[0].major)
      errors.push(
        `${name} declares major ${entries[0].major} but the lockfile resolves ${locked.version}`,
      );
    const required = /^>=\s*(\d+)/.exec(locked.engines?.node ?? '');
    if (required && floor !== null && Number(required[1]) > floor)
      errors.push(
        `${name} ${locked.version} requires Node >=${required[1]}, above the floor ${floor}`,
      );
  }
  const configs = declared('eslint-config-next');
  for (const entry of configs)
    if (resolved.next !== undefined && entry.major !== resolved.next)
      errors.push(
        `${entry.path} eslint-config-next major ${entry.major} differs from next ${resolved.next}`,
      );

  return { errors, warnings, facts };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argument = process.argv.find((value) => value.startsWith('--root='));
  const root = argument
    ? resolve(argument.slice('--root='.length))
    : fileURLToPath(new URL('../..', import.meta.url));
  try {
    const { errors, warnings, facts } = analyze(root);
    for (const warning of warnings) console.warn(`::warning::${warning}`);
    if (errors.length) {
      for (const error of errors) console.error(`::error::${error}`);
      console.error(`FAIL ${errors.length} toolchain disagreement(s)`);
      process.exitCode = 1;
    } else {
      process.stdout.write(`PASS toolchain consistent: ${facts.join('; ')}\n`);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
