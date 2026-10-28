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

test('scrubMessage removes every shape of address, bearer token, cookie, JWT and one-time code', () => {
  const session = 'q'.repeat(43);
  // Assembled at runtime so no JWT-shaped literal is committed to the repository.
  const jwt = ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJl'].join('.');
  const cases: [string, string[]][] = [
    ['rejected First.Last+tag@Example.CO.uk', ['First.Last', 'example', 'Example']],
    ['Authorization: Bearer abc.def.ghi failed', ['abc.def.ghi']],
    [`Bearer ${session}`, [session]],
    ['cookie: careerscope_v2_session=abcdef123456', ['abcdef123456']],
    ['Set-Cookie: sid=abc123; Path=/', ['abc123']],
    [`jwt ${jwt}`, [jwt, 'eyJzdWIi']],
    ['invalid code 123456 for the challenge', ['123456']],
    ['otp is 654321', ['654321']],
    ['redis://:queue-password@127.0.0.1:6379 refused', ['queue-password']],
    ['postgres://careerscope:db-password@127.0.0.1/db', ['db-password']],
    ['password=hunter2 refused', ['hunter2']],
    [`session ${session} not found`, [session]],
  ];
  for (const [input, forbidden] of cases) {
    const output = scrubMessage(input);
    for (const secret of forbidden) {
      assert.equal(output.includes(secret), false, `${input} -> ${output}`);
    }
  }
});

test('scrubMessage removes Basic credentials, cookie lines, JSON bodies, prose secrets and signed URLs', () => {
  const cases: [string, string[]][] = [
    ['Authorization: Basic dGVzdDp0ZXN0', ['dGVzdDp0ZXN0']],
    ['Cookie: sid=abc123; csrf=zzz999', ['abc123', 'zzz999']],
    ['Set-Cookie: sid=abc123; csrf=zzz999; Path=/', ['abc123', 'zzz999']],
    ['request body {"password":"hunter2"} rejected', ['hunter2']],
    ['password is hunter2', ['hunter2']],
    ['GET https://files.example.test/a.pdf?sig=abcdef&x=1 failed', ['abcdef']],
  ];
  for (const [input, forbidden] of cases) {
    const output = scrubMessage(input);
    for (const secret of forbidden) {
      assert.equal(output.includes(secret), false, `${input} -> ${output}`);
    }
  }
});

test('describeError exposes only the error name and scrubbed message, never stack, cause or fields', () => {
  const error = Object.assign(new Error('failed for owner@example.test'), {
    detail: 'Key (email)=(owner@example.test) already exists',
    cause: new Error('Bearer secret-token-value'),
  });
  const described = describeError(error);
  assert.deepEqual(Object.keys(described).sort(), ['errorMessage', 'errorName']);
  const serialised = JSON.stringify(described);
  assert.equal(serialised.includes('owner@example.test'), false);
  assert.equal(serialised.includes('secret-token-value'), false);
  assert.equal(serialised.includes('at '), false, 'no stack frames');
});
