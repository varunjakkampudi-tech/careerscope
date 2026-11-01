import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  analyze,
  extractSpecifiers,
  isTestFile,
  stripComments,
} from './check-architecture-boundaries.mjs';

const checker = fileURLToPath(new URL('./check-architecture-boundaries.mjs', import.meta.url));

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'careerscope-boundaries-'));
  const write = (path, content) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  write('package.json', JSON.stringify({ workspaces: ['apps/*', 'packages/*'] }));
  for (const name of ['shared', 'core', 'matching', 'providers', 'resume'])
    write(`packages/${name}/package.json`, JSON.stringify({ name: `@careerscope/${name}` }));
  write('apps/api/package.json', JSON.stringify({ name: '@careerscope/api' }));
  write('apps/web/package.json', JSON.stringify({ name: '@careerscope/web' }));
  for (const [path, content] of Object.entries(files)) write(path, content);
  return root;
}

function rules(files) {
  const root = fixture(files);
  try {
    return analyze(root).violations.map((violation) => violation.rule);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the allowed graph produces no violations', () => {
  assert.deepEqual(
    rules({
      'packages/core/src/a.ts':
        "import { x } from '@careerscope/shared';\nimport '@careerscope/resume';",
      'packages/providers/src/a.ts': "export * from '@careerscope/matching';",
      'apps/api/src/a.ts': "import { y } from '@careerscope/core';\nimport pg from 'pg';",
      'apps/api/src/a.test.ts': "import './a.ts';\nimport './helper.test.ts';",
    }),
    [],
  );
});

test('packages importing apps are rejected, by package name or relative path', () => {
  assert.match(
    rules({ 'packages/core/src/a.ts': "import '@careerscope/api';" })[0],
    /package core imports app api/,
  );
  assert.match(
    rules({ 'packages/core/src/a.ts': "import x from '../../../apps/api/src/b.ts';" })[0],
    /package core imports app api/,
  );
});

test('shared may not import any internal package', () => {
  assert.match(
    rules({ 'packages/shared/src/a.ts': "import '@careerscope/matching';" })[0],
    /shared imports internal package matching/,
  );
});

test('providers, matching and resume may not import core', () => {
  for (const name of ['providers', 'matching', 'resume']) {
    assert.deepEqual(rules({ [`packages/${name}/src/a.ts`]: "import '@careerscope/core/x';" }), [
      `${name} imports core`,
    ]);
  }
});

test('other edges outside the allowlist are rejected', () => {
  assert.deepEqual(rules({ 'packages/matching/src/a.ts': "import '@careerscope/providers';" }), [
    'matching may not import providers',
  ]);
});

test('non-test modules may not import test files, including dynamic imports', () => {
  assert.deepEqual(
    rules({
      'apps/api/src/a.ts': "const m = await import('./b.test.ts');",
      'apps/api/src/b.test.ts': 'export {};',
    }),
    ['module imports from a test file'],
  );
});

test('commented-out imports are ignored and specifiers are extracted', () => {
  assert.deepEqual(
    extractSpecifiers("// import '@careerscope/api';\n/* import 'x' */\nimport a, { b } from 'm';"),
    ['m'],
  );
  assert.equal(isTestFile('a/b.integration.test.ts'), true);
  assert.equal(isTestFile('a/b.ts'), false);
});

test('comment markers inside strings cannot swallow a following import', () => {
  // A naive /* ... */ stripper would start at the glob in the string and delete the import below.
  const source = [
    "const glob = './a/*';",
    "import x from '@careerscope/api';",
    "const end = '*/';",
  ];
  assert.deepEqual(extractSpecifiers(source.join('\n')), ['@careerscope/api']);
  assert.equal(stripComments("const u = 'http://x'; // note"), "const u = 'http://x'; ");
  assert.equal(stripComments('a /* b\nc */ d'), 'a     \n     d');
  // A trailing comment is removed, and an import written after a block comment is kept.
  assert.deepEqual(extractSpecifiers("/* c */ import a from 'm'; // import b from 'n'"), ['m']);
  // An apostrophe in a comment or JSX text does not leak into the next line.
  assert.deepEqual(extractSpecifiers("// don't\nimport a from 'm';"), ['m']);
  assert.deepEqual(extractSpecifiers("const t = <p>Don't</p>;\nimport a from 'm';"), ['m']);
  assert.equal(
    rules({
      'packages/shared/src/a.ts': ["const g = './x/*';", "import '@careerscope/core';"].join('\n'),
    })[0],
    'shared imports internal package core',
  );
});

test('web may not import core, except the named baseline files, which only warn', () => {
  assert.deepEqual(rules({ 'apps/web/src/a.ts': "import type { X } from '@careerscope/core';" }), [
    'web may not import core',
  ]);
  assert.deepEqual(rules({ 'apps/web/src/a.ts': "import { X } from '@careerscope/shared';" }), []);
  const root = fixture({ 'apps/web/src/known.tsx': "import type { X } from '@careerscope/core';" });
  try {
    const result = analyze(root, { webCoreBaseline: new Set(['apps/web/src/known.tsx']) });
    assert.deepEqual(result.violations, []);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].file, 'apps/web/src/known.tsx');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI exits non-zero on a violation and zero on the real repository', () => {
  const root = fixture({ 'packages/shared/src/a.ts': "import '@careerscope/core';" });
  try {
    const failed = spawnSync(process.execPath, [checker, `--root=${root}`], { encoding: 'utf8' });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /shared imports internal package core/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const real = spawnSync(process.execPath, [checker], { encoding: 'utf8' });
  assert.equal(real.status, 0, real.stderr);
});
