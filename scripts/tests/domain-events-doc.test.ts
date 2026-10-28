import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandSchema } from '@careerscope/core';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8');
const document = read('docs/architecture/DOMAIN-EVENTS.md');

const matches = (source: string, pattern: RegExp) => [
  ...new Set([...source.matchAll(pattern)].map((match) => match[1]!)),
];

/** Every kind below is read from the code that emits it, so a new kind cannot ship undocumented. */
const emitted: Record<string, string[]> = {
  'command type': [...commandSchema.shape.type.options],
  'run event type': matches(read('packages/core/src/database.ts'), /'(Search[A-Za-z]+)'/g),
  'notification kind': matches(
    read('packages/core/src/notification-delivery.ts'),
    /NotificationKind\s*=\s*([^;]+);/g,
  ).flatMap((union) => [...union.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!)),
  'notification template': matches(
    read('packages/core/src/notification-delivery.ts'),
    /^ {4}([a-z_]+): \{\s*(?:subject|$)/gm,
  ),
  'notification channel': matches(
    read('packages/core/src/notification-delivery.ts'),
    /NotificationChannel\s*=\s*([^;]+);/g,
  ).flatMap((union) => [...union.matchAll(/'([a-z_]+)'/g)].map((match) => match[1]!)),
  'server-sent event': matches(read('apps/api/src/app.ts'), /event: ([a-z-]+)\\n/g),
  'email code purpose': matches(
    read('packages/core/src/email-otp-delivery.ts'),
    /purpose\?: ([^;]+);/g,
  ).flatMap((union) => [...union.matchAll(/'([a-z-]+)'/g)].map((match) => match[1]!)),
};

test('the extractors find the kinds they are meant to guard', () => {
  assert.ok(emitted['command type']!.includes('search.collect'));
  assert.ok(emitted['run event type']!.includes('SearchQueued'));
  assert.ok(emitted['run event type']!.length >= 6);
  assert.deepEqual(emitted['notification kind']!.sort(), [
    'application',
    'interview',
    'marketing',
    'security',
  ]);
  assert.ok(emitted['notification template']!.includes('interview_reminder'));
  assert.equal(emitted['notification template']!.length, 4);
  assert.deepEqual(emitted['notification channel']!.sort(), ['email', 'in_app', 'web_push']);
  assert.ok(emitted['server-sent event']!.includes('progress'));
  assert.equal(emitted['email code purpose']!.length, 3);
});

/** The text of the numbered section whose heading starts with `## <number>.`. */
function sectionOf(source: string, number: number) {
  const start = source.search(new RegExp(`^## ${number}\\. `, 'm'));
  assert.ok(start >= 0, `section ${number} is missing`);
  const next = source.slice(start + 3).search(/^## \d+\. /m);
  return next < 0 ? source.slice(start) : source.slice(start, start + 3 + next);
}

/** Kinds named in the first cell of a table row, the only place a kind counts as documented. */
function tableKinds(section: string) {
  return new Set([...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map((match) => match[1]!));
}

/** Section of the document that must carry each group's kinds in a table. */
const sectionOfGroup: Record<string, number> = {
  'command type': 1,
  'run event type': 2,
  'notification kind': 3,
  'notification template': 3,
  'notification channel': 3,
  'server-sent event': 5,
  'email code purpose': 6,
};

test('table extraction counts only first-cell kinds, not prose mentions', () => {
  const sample = [
    'Prose mentions `ghost` and `only-prose`.',
    '| Kind | Notes |',
    '| -- | -- |',
    '| `real` | mentions `ghost` |',
  ].join('\n');
  assert.deepEqual([...tableKinds(sample)], ['real']);
  assert.match(sectionOf(document, 3), /Notification kinds/);
  assert.doesNotMatch(sectionOf(document, 3), /^## 4\. /m);
});

test('every emitted event or message kind is in a table of its section of docs/architecture/DOMAIN-EVENTS.md', () => {
  const missing = Object.entries(emitted).flatMap(([group, kinds]) => {
    const documented = tableKinds(sectionOf(document, sectionOfGroup[group]!));
    return kinds.filter((kind) => !documented.has(kind)).map((kind) => `${group}: ${kind}`);
  });
  assert.deepEqual(missing, []);
});

test('every kind in the document that claims a producer is still emitted by the code', () => {
  // Guards the other direction for commands: a "Declared only" kind must not gain a producer silently.
  const declaredOnly = [...document.matchAll(/^\| `([a-z]+\.[a-z]+)`\s+\| Declared only/gm)].map(
    (match) => match[1]!,
  );
  assert.ok(declaredOnly.length > 0);
  const source = [
    read('packages/core/src/database.ts'),
    read('packages/core/src/resumes.ts'),
    read('apps/workers/search/src/publisher.ts'),
  ].join('\n');
  for (const kind of declaredOnly)
    assert.doesNotMatch(source, new RegExp(`type: '${kind}'|'${kind}':`), `${kind} has a producer`);
});
