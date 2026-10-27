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

test('every emitted event or message kind appears in docs/architecture/DOMAIN-EVENTS.md', () => {
  const missing = Object.entries(emitted).flatMap(([group, kinds]) =>
    kinds.filter((kind) => !document.includes(`\`${kind}\``)).map((kind) => `${group}: ${kind}`),
  );
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
