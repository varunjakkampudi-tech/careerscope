import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyze } from './check-toolchain.mjs';

const checker = fileURLToPath(new URL('./check-toolchain.mjs', import.meta.url));

function verify(overrides = {}, options) {
  const root = mkdtempSync(join(tmpdir(), 'careerscope-toolchain-'));
  const files = {
    'package.json': JSON.stringify({ engines: { node: '>=24' }, workspaces: ['apps/*'] }),
    '.nvmrc': '24\n',
    'infra/docker/Dockerfile':
      'ARG NODE_IMAGE=node:24.1.0-bookworm-slim@sha256:abc\nFROM ${NODE_IMAGE}\n',
    'apps/web/package.json': JSON.stringify({
      dependencies: { next: '16.4.3' },
      devDependencies: { 'eslint-config-next': '16.4.3' },
    }),
    'apps/api/package.json': JSON.stringify({ dependencies: { fastify: '^5.1.0' } }),
    'package-lock.json': JSON.stringify({
      packages: {
        'node_modules/next': { version: '16.4.3', engines: { node: '>=20.9.0' } },
        'node_modules/fastify': { version: '5.12.7' },
      },
    }),
    '.github/workflows/ci.yml': "env:\n  NODE_VERSION: '24'\n",
    ...overrides,
  };
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    return analyze(root, options);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a consistent toolchain passes', () => {
  assert.deepEqual(verify().errors, []);
});

test('.nvmrc, workflow pin and Dockerfile below the floor are rejected', () => {
  assert.match(verify({ '.nvmrc': '22' }).errors[0], /\.nvmrc major 22/);
  assert.match(
    verify({ '.github/workflows/ci.yml': "env:\n  NODE_VERSION: '22'\n" }).errors[0],
    /ci\.yml NODE_VERSION major 22/,
  );
  assert.match(
    verify({ 'infra/docker/Dockerfile': 'FROM node:22-slim\n' }).errors[0],
    /below the engines\.node floor/,
  );
});

test('a newer Dockerfile major warns, and fails under --strict', () => {
  const newer = { 'infra/docker/Dockerfile': 'ARG NODE_IMAGE=node:26.8.1-slim\n' };
  const relaxed = verify(newer);
  assert.deepEqual(relaxed.errors, []);
  assert.match(relaxed.warnings[0], /differs from the engines\.node floor/);
  assert.equal(verify(newer, { strict: true }).errors.length, 1);
});

test('Next.js and Fastify majors must agree with the lockfile and each other', () => {
  const lock = (next, fastify) =>
    JSON.stringify({
      packages: {
        'node_modules/next': { version: next },
        'node_modules/fastify': { version: fastify },
      },
    });
  assert.match(
    verify({ 'package-lock.json': lock('15.0.0', '5.1.0') }).errors[0],
    /next declares major 16/,
  );
  assert.match(
    verify({ 'package-lock.json': lock('16.4.3', '4.9.0') }).errors[0],
    /fastify declares major 5/,
  );
  assert.match(
    verify({
      'apps/web/package.json': JSON.stringify({
        dependencies: { next: '16.4.3' },
        devDependencies: { 'eslint-config-next': '15.0.0' },
      }),
    }).errors[0],
    /eslint-config-next major 15/,
  );
});

test('the CLI passes on the real repository', () => {
  const result = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS toolchain consistent/);
});
