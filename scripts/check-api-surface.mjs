#!/usr/bin/env node
import assert from 'node:assert/strict';
import process from 'node:process';
import { URL } from 'node:url';

const { AbortSignal, Response, fetch } = globalThis;

const BASE = process.env.API_BASE ?? 'https://careerscope.tech';

const ROUTES = [
  ['/api/health', 200, 'public'],
  ['/api/session', 200, 'public signed-out session'],
  ['/api/profile', 401, 'private'],
  ['/api/preparation', 401, 'private'],
  ['/api/market/postings', 401, 'private'],
  ['/api/market/postings/deadbeef', 401, 'private'],
  ['/api/market/companies', 401, 'private'],
  ['/api/pipeline', 401, 'private'],
  ['/api/pipeline/stalled', 401, 'private'],
  ['/api/leads', 401, 'private'],
  ['/api/leads/00000000-0000-0000-0000-000000000000', 401, 'private'],
  ['/api/leads/00000000-0000-0000-0000-000000000000/history', 401, 'private'],
  ['/api/searches', 401, 'private'],
  ['/api/searches/00000000-0000-0000-0000-000000000000', 401, 'private'],
  ['/api/searches/00000000-0000-0000-0000-000000000000/export', 401, 'private'],
  ['/api/searches/00000000-0000-0000-0000-000000000000/events', 401, 'private stream'],
  ['/api/resumes', 401, 'private'],
  ['/api/resumes/00000000-0000-0000-0000-000000000000', 401, 'private'],
  ['/api/nonexistent-route', 401, 'global authentication precedes not-found handling'],
];

const LEAKS = [
  [/at\s+\/?\w+.*\.(ts|js):\d+/, 'stack trace'],
  [/postgres(ql)?:\/\//i, 'database URL'],
  [/redis:\/\//i, 'redis URL'],
  [/\/(home|root|app|srv)\//, 'filesystem path'],
  [/password|passwd|secret|api[_-]?key/i, 'credential word'],
];

async function validateResponse(response, path, expected) {
  assert.equal(response.status, expected, 'Unexpected HTTP status');
  assert.match(response.headers.get('content-type') ?? '', /^application\/json\b/i);
  assert.match(response.headers.get('cache-control') ?? '', /\bno-store\b/i);
  const body = await response.text();
  assert.ok(body.length <= 2000, 'Unexpectedly large anonymous response');
  const payload = JSON.parse(body);
  assert.ok(payload && typeof payload === 'object' && !Array.isArray(payload));
  assert.equal(
    LEAKS.some(([pattern]) => pattern.test(body)),
    false,
    'Potential information leak',
  );
  if (path === '/api/health') {
    assert.equal(payload.status, 'ok');
    assert.equal(typeof payload.version, 'string');
    assert.ok(payload.version.length > 0);
  } else if (path === '/api/session') {
    assert.equal(payload.authenticated, false);
    assert.equal(typeof payload.registrationEnabled, 'boolean');
    assert.equal('csrf' in payload, false);
  } else {
    assert.equal(payload.error, 'Authentication required');
    assert.match(payload.requestId ?? '', /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i);
  }
}

async function probe(path, expected, fetcher = fetch) {
  try {
    const response = await fetcher(new URL(path, BASE), {
      redirect: 'manual',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10000),
    });
    await validateResponse(response, path, expected);
    return { path, ok: true };
  } catch {
    return { path, ok: false };
  }
}

if (process.argv.includes('--self-test')) {
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  const fixture =
    (body, status = 200, suppliedHeaders = headers) =>
    async (_url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.redirect, 'manual');
      return new Response(body, { status, headers: suppliedHeaders });
    };
  const valid = JSON.stringify({ authenticated: false, registrationEnabled: false });
  assert.equal((await probe('/api/session', 200, fixture(valid))).ok, true);
  for (const body of [
    '',
    '{',
    'null',
    '[]',
    '{}',
    '{"authenticated":true}',
    '{"authenticated":false,"registrationEnabled":false,"csrf":"private"}',
  ]) {
    assert.equal((await probe('/api/session', 200, fixture(body))).ok, false);
  }
  assert.equal((await probe('/api/session', 200, fixture(valid, 500))).ok, false);
  assert.equal((await probe('/api/session', 200, fixture(valid, 200, {}))).ok, false);
  assert.equal(
    (
      await probe('/api/session', 200, async () => {
        throw new Error('unreachable');
      })
    ).ok,
    false,
  );
  const denial = JSON.stringify({
    error: 'Authentication required',
    requestId: '00000000-0000-0000-0000-000000000001',
  });
  assert.equal((await probe('/api/nonexistent-route', 401, fixture(denial, 401))).ok, true);
  assert.equal((await probe('/api/profile', 401, fixture('{}', 401))).ok, false);
  assert.equal(
    (await probe('/api/health', 200, fixture('{"status":"ok","version":"3.0.0"}'))).ok,
    true,
  );
  assert.equal(
    (await probe('/api/health', 200, fixture('{"status":"down","version":"3.0.0"}'))).ok,
    false,
  );
  process.stdout.write(
    'PASS: anonymous probe accepts valid responses and rejects invalid, malformed and unreachable responses.\n',
  );
  process.exit(0);
}

const results = [];
for (const [path, expected] of ROUTES) {
  results.push(await probe(path, expected));
}
for (const result of results) {
  process.stdout.write(`${result.ok ? 'PASS' : 'FAIL'}  ${result.path}\n`);
}
const failures = results.filter((result) => !result.ok).length;
process.stdout.write(
  `\n${results.length - failures}/${results.length} anonymous access checks passed. ` +
    'This does not prove route existence, authenticated functionality, writes or SSE streaming.\n',
);
process.exit(failures === 0 ? 0 : 1);
