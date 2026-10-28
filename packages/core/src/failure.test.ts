import assert from 'node:assert/strict';
import test from 'node:test';
import pino from 'pino';
import { describeError, errorSerializers, serializeError } from './failure.ts';

const email = 'jane.doe@example.com';
const bearer = 'Bearer abcdef0123456789secret';
const password = 'hunter2-correct-horse';
const message = `failed for ${email} with ${bearer} and password=${password}`;
const secrets = [email, 'jane.doe', 'abcdef0123456789secret', password, 'hunter2', 'failed for'];

const assertNoSecrets = (text: string) => {
  for (const secret of secrets) assert.equal(text.includes(secret), false, `leaked: ${secret}`);
};

test('describeError reports the class name and code, never the message', () => {
  const error = Object.assign(new TypeError(message), { code: '23505' });
  assert.deepEqual(describeError(error), { errorName: 'TypeError', errorCode: '23505' });
  assertNoSecrets(JSON.stringify(describeError(error)));
});

test('describeError omits a missing, non-string, overlong or unsafe code', () => {
  assert.deepEqual(describeError(new Error(message)), { errorName: 'Error' });
  const withCode = (code: unknown) => describeError(Object.assign(new Error(message), { code }));
  assert.deepEqual(withCode(23505), { errorName: 'Error' });
  assert.deepEqual(withCode('a'.repeat(65)), { errorName: 'Error' });
  assert.deepEqual(withCode(`bad code ${email}`), { errorName: 'Error' });
  assert.deepEqual(withCode(''), { errorName: 'Error' });
  assert.deepEqual(withCode('ECONNRESET'), { errorName: 'Error', errorCode: 'ECONNRESET' });
  assert.deepEqual(withCode('a'.repeat(64)), { errorName: 'Error', errorCode: 'a'.repeat(64) });
});

test('describeError reports only the type for non-errors and a safe name for odd class names', () => {
  assert.deepEqual(describeError('plain secret string'), { errorName: 'string' });
  assert.deepEqual(describeError(null), { errorName: 'object' });
  const odd = Object.assign(new Error(message), { name: `Weird ${email}` });
  assert.deepEqual(describeError(odd), { errorName: 'Error' });
});

test('describeError exposes only name and code, never stack, cause or fields', () => {
  const error = Object.assign(new Error(message), {
    code: 'ECONNRESET',
    detail: `Key (email)=(${email}) already exists`,
    cause: new Error(bearer),
  });
  const described = describeError(error);
  assert.deepEqual(Object.keys(described).sort(), ['errorCode', 'errorName']);
  const serialised = JSON.stringify(described);
  assertNoSecrets(serialised);
  assert.equal(serialised.includes('at '), false, 'no stack frames');
});

test('serializeError returns name and code only', () => {
  const error = Object.assign(new RangeError(message), { code: 'ERR_OUT_OF_RANGE' });
  assert.deepEqual(serializeError(error), { name: 'RangeError', code: 'ERR_OUT_OF_RANGE' });
  assert.deepEqual(serializeError(new Error(message)), { name: 'Error' });
});

test('a pino line for an error carrying secrets has the name and code and none of the secrets', () => {
  const lines: string[] = [];
  const log = pino(
    { base: undefined, serializers: errorSerializers },
    { write: (line: string) => lines.push(line) },
  );
  const error = Object.assign(new TypeError(message), { code: 'ECONNRESET' });
  log.error({ err: error, requestId: 'req-1' }, 'Request failed');
  log.error({ error, executionId: 'exec-1' }, 'Operation failed');
  log.error({ error: `${email} ${bearer} ${password}` }, 'String error');
  assert.equal(lines.length, 3);
  for (const line of lines) assertNoSecrets(line);
  const first = JSON.parse(lines[0]!) as { err: unknown; requestId: string };
  assert.deepEqual(first.err, { name: 'TypeError', code: 'ECONNRESET' });
  assert.equal(first.requestId, 'req-1');
  const second = JSON.parse(lines[1]!) as { error: unknown; executionId: string };
  assert.deepEqual(second.error, { name: 'TypeError', code: 'ECONNRESET' });
  assert.equal(second.executionId, 'exec-1');
});

test('a pino line built from describeError carries the name and code, not the message', () => {
  const lines: string[] = [];
  const log = pino({ base: undefined }, { write: (line: string) => lines.push(line) });
  const error = Object.assign(new Error(message), { code: 'ECONNRESET' });
  log.error({ ...describeError(error), commandId: 'cmd-1', fence: 3 }, 'Operation failed');
  const line = lines[0]!;
  assertNoSecrets(line);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.equal(parsed.errorName, 'Error');
  assert.equal(parsed.errorCode, 'ECONNRESET');
  assert.equal(parsed.commandId, 'cmd-1');
  assert.equal('errorMessage' in parsed, false);
});
