import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const web = join(root, 'apps/web/src');
const read = (path: string) => readFileSync(path, 'utf8');
const document = read(join(root, 'docs/architecture/DESIGN-SYSTEM.md'));

const walk = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
const files = walk(web);
const stylesheets = files.filter((file) => file.endsWith('.css'));
const sources = files.filter((file) => /[.](css|tsx?)$/.test(file));

/** Every custom property declared in any stylesheet. */
const defined = new Set(
  stylesheets.flatMap((file) =>
    [...read(file).matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]!),
  ),
);

/**
 * Read by CSS but not declared in a stylesheet, each with the reason it is accepted:
 * `--font-sans` is declared by next/font in app/layout.tsx; `--surface-subtle` is only ever read
 * with a fallback, which the "Found and left as is" section of the document records.
 */
const declaredElsewhere = new Set(['--font-sans']);
const fallbackOnly = new Set(['--surface-subtle']);
/** Named in the document only to record a defect that was fixed. */
const historical = new Set(['--dash-primary', '--text']);

test('the font token comes from next/font in the root layout', () => {
  assert.match(read(join(web, 'app/layout.tsx')), /variable: '--font-sans'/);
});

test('every token named in DESIGN-SYSTEM.md exists in a stylesheet', () => {
  const named = [...document.matchAll(/`(--[a-z0-9-]+)`/g)].map((match) => match[1]!);
  assert.ok(named.length > 40, 'the document should name its tokens');
  const missing = named.filter(
    (token) =>
      !defined.has(token) &&
      !declaredElsewhere.has(token) &&
      !historical.has(token) &&
      !fallbackOnly.has(token),
  );
  assert.deepEqual([...new Set(missing)], []);
});

test('every lead status has background and foreground tokens in light and dark themes', () => {
  const css = read(join(web, 'components/dashboard-shell.module.css'));
  const [, light = '', dark = ''] = css.split(/^[.]shell(?:\[data-theme='dark'\])? [{]/m);
  const statuses = [
    'saved',
    'applied',
    'interviewing',
    'offer',
    'rejected',
    'archived',
    'withdrawn',
  ];
  for (const status of statuses) {
    assert.ok(document.includes('`' + status + '`'), `${status} is not documented`);
    for (const part of ['bg', 'fg']) {
      const token = `--dash-status-${status}-${part}:`;
      assert.ok(light.includes(token), `light theme lacks ${token}`);
      assert.ok(dark.includes(token), `dark theme lacks ${token}`);
    }
  }
});

test('CSS and inline styles read only tokens that something defines', () => {
  const undefinedTokens = sources.flatMap((file) =>
    [...read(file).matchAll(/var[(](--[a-z0-9-]+)([,)]|[$])/g)]
      .map((match) => match[1]!)
      .filter(
        (token) =>
          // A templated name such as --dash-status-${status}-bg is covered by the status test.
          !token.endsWith('-') &&
          !defined.has(token) &&
          !declaredElsewhere.has(token) &&
          !fallbackOnly.has(token),
      )
      .map((token) => `${file.slice(root.length)}: ${token}`),
  );
  assert.deepEqual(undefinedTokens, []);
  // A fallback-only token must stay fallback-only: reading it bare would resolve to nothing.
  for (const file of sources)
    for (const token of fallbackOnly)
      assert.doesNotMatch(read(file), new RegExp('var[(]' + token + '[)]'), `${file}: ${token}`);
});

test('every component and stylesheet the document names exists and exports the named component', () => {
  const rows = [...document.matchAll(/^[|] (.+?) +[|] `((?:components|styles)[/][^`]+)` +[|]/gm)];
  assert.ok(rows.length >= 7, 'the shared components table should list its files');
  for (const [, label, path] of rows) {
    const file = join(web, path!);
    assert.ok(existsSync(file), `${path} does not exist`);
    const names = [...label!.matchAll(/`([A-Za-z]+)`/g)].map((match) => match[1]!);
    for (const name of names.filter((candidate) => /^[A-Z]/.test(candidate)))
      assert.match(
        read(file),
        new RegExp('function ' + name + '[^A-Za-z]'),
        `${path} lacks ${name}`,
      );
  }
  for (const path of [
    'components/authenticated-shell.tsx',
    'components/hero-illustration.tsx',
    'components/dashboard-shell.module.css',
    'styles/reset.css',
    'app/globals.css',
  ])
    assert.ok(document.includes(path), `${path} is not mentioned`);
});

test('every stylesheet that composes the shared panel points at a file that exports it', () => {
  const surface = read(join(web, 'styles/surface.module.css'));
  assert.match(surface, /^[.]panel [{]/m);
  const composers = stylesheets.filter((file) =>
    /composes: panel from '[./]*styles[/]surface[.]module[.]css'/.test(read(file)),
  );
  assert.ok(composers.length >= 5, 'the document says five panels share the surface');
});
