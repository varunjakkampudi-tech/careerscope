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

/** Field names declared one per line in a block such as a type body or a column list. */
const fieldNames = (block: string) => [...block.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]!);

/** `snake_case` column to the `camelCase` name the document uses. */
const camel = (column: string) =>
  column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());

/** Column names of `CREATE TABLE "<table>"` in the initial migration. */
function columnsOf(table: string) {
  const body = read('migrations/0000_initial_schema.sql').match(
    new RegExp(`CREATE TABLE "${table}" \\(([\\s\\S]*?)\\r?\\n\\);`),
  )?.[1];
  assert.ok(body, `table ${table} not found in the initial migration`);
  return [...body.matchAll(/^\s*"([a-z_]+)"\s+\w/gm)].map((m) => camel(m[1]!));
}

/** Fields the code emits per message, read from the source that defines them. */
function emittedFields(): Record<string, string[]> {
  const typeBody = (source: string, name: string) => {
    const body = source.match(new RegExp(`export type ${name} = \\{([\\s\\S]*?)\\r?\\n\\};`))?.[1];
    assert.ok(body, `type ${name} not found`);
    return fieldNames(body);
  };
  const app = read('apps/api/src/app.ts');
  const progress = app.match(
    /query<\{([^}]*)\}>\(\s*`SELECT sequence::text AS cursor, type, created_at AS "createdAt" FROM run_events/,
  )?.[1];
  assert.ok(progress, 'the progress event query was not found');
  const reset = app.match(/event: reset\\ndata: (\{[^']*\})/)?.[1];
  assert.ok(reset, 'the reset event was not found');
  return {
    'command envelope': Object.keys(commandSchema.shape),
    'run event row': columnsOf('run_events'),
    'notification event': typeBody(
      read('packages/core/src/notification-delivery.ts'),
      'NotificationEvent',
    ),
    // `leadId` is joined at read time (packages/core/src/notifications.ts), not a stored column.
    'in-app reminder row': [...columnsOf('in_app_notifications'), 'leadId'],
    progress: fieldNames(progress),
    reset: Object.keys(JSON.parse(reset) as object),
    'email delivery message': typeBody(
      read('packages/core/src/email-otp-delivery.ts'),
      'EmailOtpDeliveryMessage',
    ),
  };
}

/** `message -> field -> personal-data class` from the section 7 table; `(none)` rows map to no field. */
function documentedFields() {
  const rows = new Map<string, Map<string, string>>();
  for (const line of sectionOf(document, 7).split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    const message = cells[1]?.match(/^`([^`]+)`$/)?.[1];
    if (!message || cells.length < 6) continue;
    const field = cells[2]!.match(/^`([^`]+)`$/)?.[1];
    const fields = rows.get(message) ?? new Map<string, string>();
    if (field) fields.set(field, cells[4]!);
    rows.set(message, fields);
  }
  return rows;
}

test('every payload field the code emits has a row with a personal-data class in section 7', () => {
  const documented = documentedFields();
  const classes = new Set(['Direct', 'Linked', 'Secret', 'None']);
  const problems: string[] = [];
  for (const [message, fields] of Object.entries(emittedFields())) {
    const rows = documented.get(message);
    if (!rows) {
      problems.push(`${message}: no rows`);
      continue;
    }
    for (const field of fields)
      if (!rows.has(field)) problems.push(`${message}: ${field} undocumented`);
    for (const field of rows.keys())
      if (!fields.includes(field)) problems.push(`${message}: ${field} is stale`);
  }
  for (const [message, fields] of documented)
    for (const [field, classification] of fields)
      if (!classes.has(classification))
        problems.push(`${message}.${field}: class "${classification}"`);
  assert.deepEqual(problems, []);
});

test('every server-sent event, including payload-free ones, has a section 7 row', () => {
  const documented = documentedFields();
  for (const event of emitted['server-sent event']!)
    assert.ok(documented.has(event), `server-sent event ${event} has no payload contract`);
  // A payload-free event has no fields and its code writes `data: {}`.
  for (const event of ['settled', 'session-expired', 'unavailable'])
    assert.equal(documented.get(event)?.size, 0, `${event} must be documented as payload-free`);
  assert.match(read('apps/api/src/app.ts'), /event: settled\\ndata: \{\}/);
});

test('the payload extractors find the fields they are meant to guard', () => {
  const fields = emittedFields();
  assert.deepEqual(fields['run event row']!.sort(), [
    'createdAt',
    'id',
    'ownerId',
    'runId',
    'sequence',
    'type',
  ]);
  assert.deepEqual(fields.progress!.sort(), ['createdAt', 'cursor', 'type']);
  assert.deepEqual(fields.reset, ['reason']);
  assert.ok(fields['notification event']!.includes('payload'));
  assert.deepEqual(fields['email delivery message']!.sort(), [
    'code',
    'email',
    'idempotencyKey',
    'purpose',
  ]);
  assert.ok(fields['in-app reminder row']!.includes('retiredAt'));
});
