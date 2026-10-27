import assert from 'node:assert/strict';
import test from 'node:test';
import { describeError, scrubMessage } from './failure.ts';

test('scrubMessage removes emails, tokens, credentials and long opaque strings', () => {
  const secret = 'a'.repeat(40);
  const message = scrubMessage(
    `failed for jane.doe@example.com using Bearer abc123 token=xyz789 ` +
      `postgres://user:pw@localhost/db and ${secret}`,
  );
  assert.equal(message.includes('jane.doe'), false);
  assert.equal(message.includes('abc123'), false);
  assert.equal(message.includes('xyz789'), false);
  assert.equal(message.includes('user:pw'), false);
  assert.equal(message.includes(secret), false);
  assert.match(message, /^failed for \[email\]/);
});

test('scrubMessage keeps ordinary diagnostic text and bounds length', () => {
  assert.equal(scrubMessage('Command lease lost'), 'Command lease lost');
  assert.equal(scrubMessage('x '.repeat(500)).length, 300);
});

test('describeError reports the name and scrubbed message, and only the type for non-errors', () => {
  const error = new TypeError('bad value for owner@example.com');
  assert.deepEqual(describeError(error), {
    errorName: 'TypeError',
    errorMessage: 'bad value for [email]',
  });
  assert.deepEqual(describeError('plain secret string'), { errorName: 'string', errorMessage: '' });
});
