import assert from 'node:assert/strict';
import test from 'node:test';
import { describeError, emailAddressPattern, scrubMessage } from './failure.ts';

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
    [String.raw`body {\"password\":\"x-secret-pw\"} rejected`, ['x-secret-pw']],
    [String.raw`body {\"token\":\"x-secret-tok\"} rejected`, ['x-secret-tok']],
    [String.raw`body {\"password\":\"two words\"}`, ['two words', 'words']],
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

test('scrubMessage caps its input: a 1 MB string finishes under 100 ms', () => {
  const inputs = [
    'a1'.repeat(500_000),
    'token="'.repeat(150_000),
    '"'.repeat(1_000_000),
    'a:'.repeat(500_000),
    `${'x'.repeat(999_000)} password=hunter2`,
  ];
  for (const input of inputs) {
    // The fastest of five runs measures the scrubber itself rather than scheduler noise on a loaded host.
    let elapsed = Infinity;
    let output = '';
    for (let run = 0; run < 5; run++) {
      const started = performance.now();
      output = scrubMessage(input);
      elapsed = Math.min(elapsed, performance.now() - started);
    }
    assert.ok(elapsed < 100, `took ${elapsed.toFixed(1)} ms for ${input.slice(0, 12)}`);
    assert.ok(output.length <= 300);
  }
});

test('scrubMessage redacts quoted values, header lines, JSON bodies and more secret names', () => {
  const cases: [string, string[]][] = [
    ['Authorization: Token abc123def', ['abc123def']],
    ['Proxy-Authorization: Negotiate YIIabc123', ['YIIabc123']],
    ['{"cookie":"sid=abc; uid=991; theme=x"}', ['abc', '991']],
    ['{"password":"hunter 2 three"}', ['hunter']],
    ['password=ab;cd', ['password=ab']],
    ['token: "abc def"', ['abc', 'def']],
    ['{"pwd":"hunter2"}', ['hunter2']],
    ['request had _csrf=Zm9vYmFy', ['Zm9vYmFy']],
    ['xsrf=token9876', ['token9876']],
    ['passphrase=abc', ['passphrase=abc']],
    ['pass=letmein99', ['letmein99']],
    ['jwt=notreallyajwt', ['notreallyajwt']],
    ['ticket=T-4455-xyz', ['T-4455-xyz']],
    ['private=zzz-secret-material', ['zzz-secret-material']],
    ['apikey=qwerty123', ['qwerty123']],
    [String.raw`password="say \"hi there\" now" tail`, ['hi there']],
    [String.raw`password='it\'s a quoted one' tail`, ['quoted']],
  ];
  for (const [input, forbidden] of cases) {
    const output = scrubMessage(input);
    for (const secret of forbidden) {
      assert.equal(output.includes(secret), false, `${input} -> ${output}`);
    }
  }
  assert.equal(scrubMessage('password=ab;cd').includes('ab;'), false);
});

test('scrubMessage redacts escaped inner quotes, truncated escaped JSON and backslashes in bare values', () => {
  const cases: [string, string[]][] = [
    [String.raw`{\"password\":\"a\\\"b secret\"}`, ['secret']],
    [String.raw`{\"password\":\"abc`, ['abc']],
    [String.raw`password=ab\cd`, ['ab', 'cd']],
    [String.raw`password=C:\Users\x`, ['Users']],
    [String.raw`{\"password\":\"p\\\"w rest\"}`, ['rest']],
  ];
  for (const [input, forbidden] of cases) {
    const output = scrubMessage(input);
    for (const secret of forbidden) {
      assert.equal(output.includes(secret), false, `${input} -> ${output}`);
    }
  }
});

test('scrubMessage closes an escaped-quote value only on a quote with the same backslash count', () => {
  const cases: [string, string[]][] = [
    [String.raw`{\"password\":\"p\\\" hunter2 rest\"}`, ['hunter2', 'rest']],
    [String.raw`{\"password\":\"say \\\", then more\"}`, ['then', 'more', 'say']],
    [String.raw`{\"password\":\"a\\\"}tail\"}`, ['tail']],
    [String.raw`{\"password\":\"a"b" c\"}`, [' c', 'b"']],
  ];
  for (const [input, forbidden] of cases) {
    const output = scrubMessage(input);
    for (const secret of forbidden) {
      assert.equal(output.includes(secret), false, `${input} -> ${output}`);
    }
  }
});

test('scrubMessage redacts unterminated or truncated quoted values through the end of the input', () => {
  const cases: [string, string[]][] = [
    ['password: "abc def', ['abc', 'def']],
    [String.raw`{\"password\":\"abc def`, ['abc', 'def']],
    [String.raw`password="abc\"def ghi`, ['def', 'ghi', '\\"']],
    [String.raw`password=a\"b c`, ['b c', '\\"']],
    ["password: 'it's ok here'", ['it', 's ok', 'here']],
  ];
  for (const [input, forbidden] of cases) {
    const output = scrubMessage(input);
    for (const secret of forbidden) {
      assert.equal(output.includes(secret), false, `${input} -> ${output}`);
    }
  }
});

test('scrubMessage stays linear on 2000-character adversarial quote and backslash inputs', () => {
  const slash = '\\';
  const inputs = [
    'password="'.repeat(200),
    `password=${slash}"`.repeat(180),
    `password=${slash.repeat(4)} `.repeat(250),
    `${slash}"`.repeat(1000),
    `password=${slash}"a${`${slash}"a${slash}`.repeat(660)}`,
    `password=${slash.repeat(190)} `.repeat(10),
    `password=${slash}'${`x${slash}'`.repeat(660)}`,
    `key=${slash.repeat(5)}"x `.repeat(250),
  ];
  for (const input of inputs) {
    const capped = input.slice(0, 2000);
    const started = performance.now();
    for (let run = 0; run < 20; run++) scrubMessage(capped);
    const average = (performance.now() - started) / 20;
    assert.ok(average < 5, `averaged ${average.toFixed(2)} ms for ${capped.slice(0, 16)}`);
  }
});

test('scrubMessage redacts a URL password that contains a slash, for any scheme', () => {
  // The first URL is assembled at runtime so the privacy scanner does not read it as a real credential.
  for (const input of [
    `${['postgres://user:p/w', '@db/x'].join('')} refused`,
    'redis://:a/b/c@127.0.0.1:6379 refused',
    'amqps://svc:s3/cr/et@broker.example/vhost',
  ]) {
    const output = scrubMessage(input);
    assert.equal(/p\/w|a\/b\/c|s3\/cr/.test(output), false, `${input} -> ${output}`);
    assert.match(output, /\[url\]/);
  }
});

test('scrubMessage redacts known token prefixes, URL query strings and shorter mixed tokens', () => {
  // Assembled at runtime so no credential-shaped literal is committed to the repository.
  const aws = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
  const github = ['ghp', '_', 'abcdEFGH1234ijklMNOP'].join('');
  const slack = ['xoxb', '-', '123456-abcdef-Ghijkl'].join('');
  const stripe = ['sk', '_live_', 'AbCdEf'].join('');
  const stripeTest = ['sk', '_test_', 'ZyXwVu'].join('');
  for (const secret of [aws, github, slack, stripe, stripeTest]) {
    const output = scrubMessage(`upstream rejected ${secret} for the call`);
    assert.equal(output.includes(secret), false, output);
    assert.equal(output.includes(secret.slice(0, 8)), false, output);
    assert.match(output, /^upstream rejected \[redacted\] for the call$/);
  }
  const query = scrubMessage(
    'GET https://api.example.test/v1/items?page=2&cursor=opaque1&x=y failed',
  );
  assert.equal(query.includes('cursor'), false);
  assert.equal(query.includes('page=2'), false);
  assert.match(query, /^GET https:\/\/api\.example\.test\/v1\/items\?\[redacted\] failed$/);
  const mixed = 'Zq81hN4kP0xT7wBc92Lm';
  assert.equal(mixed.length, 20);
  assert.equal(scrubMessage(`bad value ${mixed} seen`).includes(mixed), false);
  // 20+ letters with no digit are ordinary words, not tokens.
  assert.equal(scrubMessage('internationalization'), 'internationalization');
  assert.equal(scrubMessage('short a1b2c3 stays'), 'short a1b2c3 stays');
});

test('scrubMessage fails closed: an ambiguous or missing escaped close redacts to the end of the line', () => {
  const cases: [string, string[]][] = [
    [String.raw`{\"password\":\"a\"b\" c\"}`, ['b\\"', ' c', 'a\\"']],
    [String.raw`{\"password\":\"p\\\" hunter2 rest\"}`, ['hunter2', 'rest']],
    [String.raw`{\"password\":\"say \\\", then more\"}`, ['then', 'more']],
    [String.raw`{\"password\":\"a\\\"}tail\"}`, ['tail']],
    [String.raw`{\"password\":\"abc def  (truncated)`, ['def', 'truncated']],
    [String.raw`password="abc\"def ghi`, ['def', 'ghi']],
    ["password: 'it's ok here'", ['ok here', 'here']],
  ];
  for (const [input, forbidden] of cases) {
    const output = scrubMessage(input);
    for (const secret of forbidden) {
      assert.equal(output.includes(secret), false, `${input} -> ${output}`);
    }
  }
  // The redaction stops at the end of the line.
  assert.match(scrubMessage(String.raw`{\"password\":\"abc` + '\nnext line'), /next line$/);
});

test('scrubMessage email pattern stays linear on 2000-character unspaced runs', () => {
  const run = 'a'.repeat(1000);
  const inputs = [
    `x@${'a'.repeat(1998)}`,
    `${'a'.repeat(1998)}@x`,
    `${'a.'.repeat(999)}@`,
    `a@${'b.'.repeat(999)}`,
    `${run}@${run}`,
    `${'a@'.repeat(1000)}`,
  ];
  for (const input of inputs) {
    let elapsed = Infinity;
    for (let attempt = 0; attempt < 5; attempt++) {
      const started = performance.now();
      for (let run = 0; run < 20; run++) input.replace(emailAddressPattern, '[email]');
      elapsed = Math.min(elapsed, (performance.now() - started) / 20);
    }
    assert.ok(elapsed < 1, `averaged ${elapsed.toFixed(3)} ms for ${input.slice(0, 12)}`);
  }
  assert.equal(scrubMessage('mail jane.doe@example.com now'), 'mail [email] now');
  assert.equal(scrubMessage(`${'x'.repeat(70)}@example.com`).includes('example'), false);
});
