import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const webRequire = createRequire(join(root, 'apps/web/package.json'));
const configRequire = createRequire(webRequire.resolve('eslint-config-next'));
const pluginPath = configRequire.resolve('@next/eslint-plugin-next');
const pluginRequire = createRequire(pluginPath);
const plugin = pluginRequire(pluginPath);
const { getRootDirs } = pluginRequire(join(dirname(pluginPath), 'utils/get-root-dirs.js'));

function vulnerableLockEntries(lock) {
  return Object.entries(lock.packages).filter(([path, entry]) => {
    if (/(?:^|\/)node_modules\/(?:braces|micromatch|sprintf-js)$/.test(path)) return true;
    if (path.endsWith('/argparse')) return Number(entry.version.split('.')[0]) < 2;
    if (path.endsWith('/esbuild')) {
      const [major, minor] = entry.version.split('.').map(Number);
      return major === 0 && minor < 25;
    }
    if (path.endsWith('/vite')) return /^8\.3\.[012]$/.test(entry.version);
    return false;
  });
}

test('lockfile removes the vulnerable dependency chains rather than masking advisories', () => {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  assert.deepEqual(vulnerableLockEntries(lock), []);
  assert.equal(
    pluginRequire('fast-glob/package.json').name,
    'tinyglobby',
    'the scoped replacement must retain its real published identity',
  );
  assert.equal(pluginRequire('fast-glob/package.json').version, '0.2.17');
});

test('lockfile guard rejects vulnerable versions, including inherited audit chains', () => {
  const packages = {
    'node_modules/braces': { version: '3.0.3' },
    'node_modules/micromatch': { version: '4.0.8' },
    'node_modules/sprintf-js': { version: '1.1.3' },
    'node_modules/mammoth/node_modules/argparse': { version: '1.0.10' },
    'node_modules/core-utils/node_modules/esbuild': { version: '0.18.20' },
    'node_modules/vite': { version: '8.3.2' },
  };
  assert.equal(vulnerableLockEntries({ packages }).length, Object.keys(packages).length);
  assert.deepEqual(
    vulnerableLockEntries({
      packages: {
        'node_modules/argparse': { version: '2.0.1' },
        'node_modules/esbuild': { version: '0.25.12' },
        'node_modules/vite': { version: '8.3.4' },
      },
    }),
    [],
  );
});

test('real Next plugin discovers directory roots for literal, glob, array and Windows paths', () => {
  const directory = mkdtempSync(join(tmpdir(), 'careerscope-glob-'));
  try {
    const first = join(directory, 'apps', 'candidate web');
    const second = join(directory, 'apps', 'admin', 'nested');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    writeFileSync(join(directory, 'apps', 'not-a-directory.txt'), 'synthetic');
    const roots = (rootDir) => getRootDirs({ cwd: root, settings: { next: { rootDir } } });
    const normalize = (paths) => paths.map((path) => resolve(path)).sort();
    assert.deepEqual(normalize(roots(first)), [resolve(first)]);
    assert.deepEqual(normalize(roots(first.replaceAll('/', '\\'))), [resolve(first)]);
    assert.deepEqual(
      normalize(roots(join(directory, 'apps', '*'))),
      normalize([first, dirname(second)]),
    );
    assert.deepEqual(normalize(roots([first, second])), normalize([first, second]));
    assert.deepEqual(normalize(roots(join(directory, 'apps', '**', 'nested'))), [resolve(second)]);
    assert.deepEqual(roots(join(directory, 'absent', '*')), []);
    assert.deepEqual(getRootDirs({ cwd: root, settings: {} }), [root]);
    assert.deepEqual(roots([first, 123]), roots(first));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('actual Next lint rule still rejects internal anchors through glob-based discovery', () => {
  const directory = mkdtempSync(join(tmpdir(), 'careerscope-next-lint-'));
  try {
    const pages = join(directory, 'web', 'pages');
    mkdirSync(pages, { recursive: true });
    writeFileSync(join(pages, 'about.js'), 'export default function About() { return null; }');
    const { Linter } = require('eslint');
    const linter = new Linter();
    const configuration = {
      languageOptions: { parserOptions: { ecmaFeatures: { jsx: true } } },
      plugins: { next: plugin },
      settings: { next: { rootDir: join(directory, '*') } },
      rules: { 'next/no-html-link-for-pages': 'error' },
    };
    const messages = linter.verify('const view = <a href="/about/">About</a>;', configuration);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].ruleId, 'next/no-html-link-for-pages');
    assert.match(messages[0].message, /Use.*<Link/);
    assert.deepEqual(
      linter.verify('const view = <a href="https://example.com">Site</a>;', configuration),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('Mammoth retains real CLI and library DOCX conversion with upgraded argparse', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'careerscope-docx-'));
  try {
    const JSZip = require('jszip');
    const archive = new JSZip();
    archive.file(
      '[Content_Types].xml',
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    );
    archive.file(
      'word/document.xml',
      '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic resume text</w:t></w:r></w:p></w:body></w:document>',
    );
    const buffer = await archive.generateAsync({ type: 'nodebuffer' });
    const path = join(directory, 'synthetic.docx');
    writeFileSync(path, buffer);
    const mammoth = require('mammoth');
    assert.equal((await mammoth.extractRawText({ buffer })).value.trim(), 'Synthetic resume text');
    const cli = join(dirname(require.resolve('mammoth/package.json')), 'bin/mammoth');
    const expectedWarnings = new Set([
      "ArgumentParser(): following options are renamed: 'addHelp' -> 'add_help'",
      '_ActionsContainer.addArgument() is renamed to _ActionsContainer.add_argument()',
      "use add_argument('docx-path', {...}) instead of add_argument([ 'docx-path' ], { ... })",
      '_ActionsContainer.addMutuallyExclusiveGroup() is renamed to _ActionsContainer.add_mutually_exclusive_group()',
      "add_argument(): following options are renamed: 'defaultValue' -> 'default'",
      'ArgumentParser.parseArgs() is renamed to ArgumentParser.parse_args()',
      'use {type:"str"} or {type:String} instead of {type:"string"}',
    ]);
    const run = (args) => {
      const result = spawnSync(process.execPath, [cli, ...args], {
        encoding: 'utf8',
        timeout: 10000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 0, result.stderr);
      for (const line of result.stderr.trim().split(/\r?\n/).filter(Boolean)) {
        if (
          /^\(Use `node --trace-deprecation \.\.\.` to show where the warning was created\)$/.test(
            line,
          )
        )
          continue;
        const warning = line.replace(/^\(node:\d+\) DeprecationWarning: /, '');
        assert.ok(expectedWarnings.has(warning), `Unexpected Mammoth CLI stderr: ${line}`);
      }
      return result.stdout;
    };
    assert.match(run(['--help']), /--output-format/);
    assert.equal(run([path]).trim(), '<p>Synthetic resume text</p>');
    assert.equal(run([path, '--output-format', 'markdown']).trim(), 'Synthetic resume text');
    const output = join(directory, 'output.html');
    run([path, output]);
    assert.equal(readFileSync(output, 'utf8').trim(), '<p>Synthetic resume text</p>');
    assert.throws(
      () =>
        execFileSync(process.execPath, [cli, path, '--output-format', 'unsupported'], {
          stdio: 'pipe',
          timeout: 10000,
        }),
      (error) => error.status === 2,
    );
    await assert.rejects(mammoth.extractRawText({ buffer: Buffer.from('not a zip file') }));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('TypeScript transform dependency preserves sync/async output and syntax errors', async () => {
  const { transform, transformSync } = require('@esbuild-kit/core-utils');
  const file = join(tmpdir(), 'careerscope-config-compat.ts');
  const source = 'const count: number = 7; globalThis.result = count;';
  for (const result of [transformSync(source, file), await transform(source, file)]) {
    const context = {};
    runInNewContext(result.code, context);
    assert.equal(context.result, 7);
    assert.ok(result.map);
  }
  assert.throws(() => transformSync('const = ;', file));
  await assert.rejects(transform('const = ;', file));
});

test('actual Drizzle CLI reads TypeScript config and preserves all copied migration bytes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'careerscope-drizzle-'));
  try {
    const output = join(directory, 'migrations');
    cpSync(join(root, 'migrations'), output, { recursive: true });
    const snapshot = (base) =>
      readdirSync(base, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => [
          join(entry.parentPath, entry.name).slice(base.length),
          readFileSync(join(entry.parentPath, entry.name)).toString('base64'),
        ])
        .sort(([left], [right]) => left.localeCompare(right));
    const before = snapshot(output);
    const config = join(directory, 'drizzle.config.ts');
    writeFileSync(
      config,
      `const dialect: 'postgresql' = 'postgresql';\nexport default { dialect, schema: ${JSON.stringify(join(root, 'packages/core/src/schema.ts').replaceAll('\\', '/'))}, out: './migrations' };\n`,
    );
    const cli = join(dirname(require.resolve('drizzle-kit')), 'bin.cjs');
    const result = spawnSync(process.execPath, [cli, 'generate', `--config=${config}`], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.stderr, '');
    assert.match(result.stdout, /No schema changes, nothing to migrate/);
    assert.deepEqual(snapshot(output), before);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
