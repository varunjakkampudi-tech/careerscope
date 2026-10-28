import assert from 'node:assert/strict';
import test from 'node:test';
import type { Database } from '@careerscope/core';
import { createApp } from './app.js';

const origin = 'http://localhost:5280';
const database = {
  pool: {
    query: async () => {
      throw new Error('unexpected database query');
    },
  },
} as unknown as Database;

test('an unsupported content type is a 415 with a generic message, not a 500', async () => {
  const app = await createApp(database, origin, async () => true);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/otp/request',
      headers: { origin, 'content-type': 'application/xml' },
      payload: '<email>candidate@example.test</email>',
    });
    assert.equal(response.statusCode, 415);
    const body = response.json();
    assert.equal(body.message, 'Unsupported media type');
    assert.deepEqual(Object.keys(body).sort(), ['code', 'message', 'requestId']);
    assert.doesNotMatch(response.body, /candidate@example\.test/);
  } finally {
    await app.close();
  }
});

test('a body that is not valid JSON stays a 400', async () => {
  const app = await createApp(database, origin, async () => true);
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/otp/request',
      headers: { origin, 'content-type': 'application/json' },
      payload: '{not json',
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().message, 'Invalid request');
  } finally {
    await app.close();
  }
});

// ---- Error envelope contract: { code, message, requestId, details? } on every failure ----

const ownerId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const cookie = `careerscope_v2_session=${'a'.repeat(64)}`;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fake database with one live session; `failures` makes every other query throw a generic error. */
const sessionDatabase = (failures = false) =>
  ({
    pool: {
      query: async (sql: string) => {
        if (sql.includes('token_hash = $1 AND access_expires_at'))
          return { rows: [{ id: sessionId, owner_id: ownerId }] };
        if (failures) throw new Error('synthetic private database detail');
        return { rows: [], rowCount: 0 };
      },
    },
  }) as unknown as Database;

const assertEnvelope = (response: { statusCode: number; body: string; json(): unknown }) => {
  const body = response.json() as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(body).filter((key) => !['code', 'message', 'requestId', 'details'].includes(key)),
    [],
    `unexpected envelope fields in ${response.body}`,
  );
  assert.match(String(body.code), /^[A-Z][A-Z0-9_]*$/);
  assert.equal(typeof body.message, 'string');
  assert.ok((body.message as string).length > 0);
  assert.match(String(body.requestId), uuidPattern);
  if ('details' in body) assert.equal(typeof body.details, 'object');
  assert.doesNotMatch(response.body, /synthetic private/);
  return body as { code: string; message: string; requestId: string; details?: unknown };
};

test('every status the API emits uses the envelope with a stable code', async () => {
  const csrfOf = async (app: Awaited<ReturnType<typeof createApp>>) =>
    (await app.inject({ url: '/api/session', headers: { cookie } })).json().csrf as string;
  const sessionHeaders = (csrf: string) => ({ cookie, origin, 'x-csrf-token': csrf });

  // 400 validation, 401, 403 (origin and CSRF), 404, 413, 415.
  const app = await createApp(sessionDatabase(), origin, async () => true);
  try {
    const csrf = await csrfOf(app);
    const validation = await app.inject({
      method: 'PUT',
      url: '/api/profile/scheduled-discovery',
      headers: { ...sessionHeaders(csrf), 'content-type': 'application/json' },
      payload: { enabled: 'yes' },
    });
    assert.equal(validation.statusCode, 400);
    const invalid = assertEnvelope(validation);
    assert.equal(invalid.code, 'INVALID_REQUEST');
    assert.deepEqual(invalid.details, { issues: [{ path: 'enabled', code: 'invalid_type' }] });
    assert.doesNotMatch(validation.body, /"yes"/);

    const anonymous = await app.inject({ url: '/api/profile' });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(assertEnvelope(anonymous).code, 'AUTHENTICATION_REQUIRED');

    const badOrigin = await app.inject({
      method: 'POST',
      url: '/api/logout',
      headers: { origin: 'http://evil.example' },
    });
    assert.equal(badOrigin.statusCode, 403);
    assert.equal(assertEnvelope(badOrigin).code, 'FORBIDDEN');

    const badCsrf = await app.inject({
      method: 'PUT',
      url: '/api/profile/scheduled-discovery',
      headers: { cookie, origin, 'x-csrf-token': 'wrong', 'content-type': 'application/json' },
      payload: { enabled: true },
    });
    assert.equal(badCsrf.statusCode, 403);
    assert.equal(assertEnvelope(badCsrf).message, 'CSRF check failed');

    const unmatched = await app.inject({ url: '/api/does-not-exist', headers: { cookie } });
    assert.equal(unmatched.statusCode, 404);
    assert.equal(assertEnvelope(unmatched).code, 'NOT_FOUND');

    const tooLarge = await app.inject({
      method: 'POST',
      url: '/api/otp/request',
      headers: { origin, 'content-type': 'application/json' },
      payload: JSON.stringify({ email: 'a'.repeat(20_000) }),
    });
    assert.equal(tooLarge.statusCode, 413);
    assert.equal(assertEnvelope(tooLarge).code, 'PAYLOAD_TOO_LARGE');

    const unsupported = await app.inject({
      method: 'POST',
      url: '/api/otp/request',
      headers: { origin, 'content-type': 'application/xml' },
      payload: '<x/>',
    });
    assert.equal(unsupported.statusCode, 415);
    assert.equal(assertEnvelope(unsupported).code, 'UNSUPPORTED_MEDIA_TYPE');

    const missingSession = await app.inject({
      method: 'DELETE',
      url: `/api/account/sessions/${'33333333-3333-4333-8333-333333333333'}`,
      headers: sessionHeaders(csrf),
    });
    assert.equal(missingSession.statusCode, 404);
    assert.equal(assertEnvelope(missingSession).message, 'Session not found');
  } finally {
    await app.close();
  }

  // 429 from the shared limiter.
  const limited = await createApp(sessionDatabase(), origin, async () => false);
  try {
    const response = await limited.inject({ url: '/api/account/sessions', headers: { cookie } });
    assert.equal(response.statusCode, 429);
    assert.equal(assertEnvelope(response).code, 'RATE_LIMITED');
  } finally {
    await limited.close();
  }

  // 503 when the limiter itself is down (fail closed) and when readiness fails.
  const down = await createApp(
    sessionDatabase(),
    origin,
    async () => {
      throw new Error('synthetic private limiter detail');
    },
    {
      readiness: async () => {
        throw new Error('synthetic private readiness detail');
      },
    },
  );
  try {
    const unavailable = await down.inject({ url: '/api/account/sessions', headers: { cookie } });
    assert.equal(unavailable.statusCode, 503);
    assert.equal(assertEnvelope(unavailable).code, 'SERVICE_UNAVAILABLE');
    const health = await down.inject({ url: '/api/health' });
    assert.equal(health.statusCode, 503);
    assert.equal(assertEnvelope(health).code, 'SERVICE_UNAVAILABLE');
  } finally {
    await down.close();
  }

  // 500 for an unexpected failure, with the private detail withheld.
  const broken = await createApp(sessionDatabase(true), origin, async () => true);
  try {
    const response = await broken.inject({
      url: '/api/account/marketing-consent',
      headers: { cookie },
    });
    assert.equal(response.statusCode, 500);
    const body = assertEnvelope(response);
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.equal(body.message, 'Internal error');
  } finally {
    await broken.close();
  }
});

test('an unauthenticated or cross-origin call to every documented route answers in the envelope', async () => {
  const app = await createApp(sessionDatabase(), origin, async () => true);
  try {
    await app.ready();
    const document = app.swagger() as { paths: Record<string, Record<string, unknown>> };
    const paths = Object.entries(document.paths);
    assert.ok(paths.length > 30);
    let probed = 0;
    for (const [path, operations] of paths) {
      for (const method of Object.keys(operations)) {
        const url = path.replace(/\{[^}]+\}/g, '33333333-3333-4333-8333-333333333333');
        const unsafe = !['get', 'head', 'options'].includes(method);
        const response = await app.inject({
          method: method.toUpperCase() as 'GET',
          url,
          headers: unsafe ? { origin: 'http://evil.example' } : {},
        });
        if (response.statusCode < 400) continue; // public routes such as /api/health answer normally
        assertEnvelope(response);
        probed += 1;
      }
    }
    assert.ok(probed > 30, `only ${probed} documented routes produced an error to check`);
  } finally {
    await app.close();
  }
});

test('the OpenAPI document declares the envelope for every error response', async () => {
  const app = await createApp(sessionDatabase(), origin, async () => true, {
    emailOtp: { secret: Buffer.alloc(32, 7), provider: { send: async () => undefined } },
  });
  try {
    await app.ready();
    const document = app.swagger() as unknown as {
      paths: Record<
        string,
        Record<
          string,
          {
            responses: Record<
              string,
              { content?: Record<string, { schema?: Record<string, unknown> }> }
            >;
          }
        >
      >;
    };
    let checked = 0;
    for (const [path, operations] of Object.entries(document.paths)) {
      for (const [method, operation] of Object.entries(operations)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          if (!/^[45]/.test(status)) continue;
          const schema = response.content?.['application/json']?.schema as
            { required?: string[]; properties?: Record<string, unknown> } | undefined;
          const where = `${method.toUpperCase()} ${path} ${status}`;
          assert.deepEqual(
            Object.keys(schema?.properties ?? {}).sort(),
            ['code', 'details', 'message', 'requestId'],
            where,
          );
          assert.deepEqual(
            [...(schema?.required ?? [])].sort(),
            ['code', 'message', 'requestId'],
            where,
          );
          checked += 1;
        }
      }
    }
    assert.ok(checked > 100, `only ${checked} error responses were declared`);
    // The retired password registration stub is no longer routed or documented.
    assert.equal(document.paths['/api/register'], undefined);
  } finally {
    await app.close();
  }
});

/** Returns the source text of the message argument (the second) of every `new HttpError(` call. */
function httpErrorMessageArguments(source: string) {
  const messages: string[] = [];
  for (const match of source.matchAll(/new HttpError\(/g)) {
    let depth = 1;
    let quote = '';
    let argument = 0;
    let current = '';
    for (let index = match.index + match[0].length; index < source.length; index += 1) {
      const character = source[index]!;
      if (quote) {
        current += character;
        if (character === '\\') current += source[++index] ?? '';
        else if (character === quote) quote = '';
        continue;
      }
      if (character === "'" || character === '"' || character === '`') quote = character;
      else if ('([{'.includes(character)) depth += 1;
      else if (')]}'.includes(character)) depth -= 1;
      if (depth === 0) break;
      if (character === ',' && depth === 1) {
        if (argument === 1) break;
        argument += 1;
        current = '';
        continue;
      }
      if (argument === 1) current += character;
    }
    messages.push(current.trim());
  }
  return messages;
}

test('HttpError messages in app.ts are literals, never template literals', async () => {
  const { readFile } = await import('node:fs/promises');
  const messages = httpErrorMessageArguments(
    await readFile(new URL('./app.ts', import.meta.url), 'utf8'),
  );
  assert.ok(messages.length > 20, 'the scan must find the HttpError calls');
  assert.deepEqual(
    messages.filter((message) => message.startsWith('`')),
    [],
  );
  // The scanner itself: it must flag a template literal, including one split over lines.
  assert.deepEqual(
    httpErrorMessageArguments("new HttpError(400,\n  `bad ${value}`);new HttpError(404, 'a, (b)')"),
    ['`bad ${value}`', "'a, (b)'"],
  );
});

test('405 and 408 answer in the envelope with their stable codes and hide the thrown text', async () => {
  const app = await createApp(sessionDatabase(), origin, async () => true);
  // Framework-shaped errors (Fastify attaches `statusCode`), thrown by throwaway routes. The
  // handler passes 4xx framework statuses through, so these exercise the 405 and 408 mapping.
  const frameworkError = (statusCode: number, code: string) =>
    Object.assign(new Error('synthetic private framework detail'), { statusCode, code });
  app.get('/api/__probe/method', async () => {
    throw frameworkError(405, 'FST_ERR_METHOD_NOT_ALLOWED');
  });
  app.get('/api/__probe/timeout', async () => {
    throw frameworkError(408, 'FST_ERR_CTP_REQUEST_TIMEOUT');
  });
  try {
    const notAllowed = await app.inject({ url: '/api/__probe/method', headers: { cookie } });
    assert.equal(notAllowed.statusCode, 405);
    const method = assertEnvelope(notAllowed);
    assert.equal(method.code, 'METHOD_NOT_ALLOWED');
    assert.equal(method.message, 'Method not allowed');

    const timedOut = await app.inject({ url: '/api/__probe/timeout', headers: { cookie } });
    assert.equal(timedOut.statusCode, 408);
    const timeout = assertEnvelope(timedOut);
    assert.equal(timeout.code, 'REQUEST_TIMEOUT');
    assert.equal(timeout.message, 'Request timeout');
  } finally {
    await app.close();
  }
});

test('an unknown route answers 401 to an anonymous caller (auth runs first) and 404 once signed in', async () => {
  const app = await createApp(sessionDatabase(), origin, async () => true);
  try {
    const anonymous = await app.inject({ url: '/api/does-not-exist' });
    assert.equal(anonymous.statusCode, 401);
    assert.equal(assertEnvelope(anonymous).code, 'AUTHENTICATION_REQUIRED');
    const signedIn = await app.inject({ url: '/api/does-not-exist', headers: { cookie } });
    assert.equal(signedIn.statusCode, 404);
    assert.equal(assertEnvelope(signedIn).code, 'NOT_FOUND');
  } finally {
    await app.close();
  }
});

test('the health endpoint reports no version and is rate-limited per client address', async () => {
  const healthy = {
    pool: { query: async () => ({ rows: [{ '?column?': 1 }] }) },
  } as unknown as Database;
  const counts = new Map<string, number>();
  const limiter = async (key: string, limit: number) => {
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    return count <= limit;
  };
  const app = await createApp(healthy, origin, limiter);
  try {
    const first = await app.inject({ url: '/api/health' });
    assert.equal(first.statusCode, 200);
    assert.deepEqual(first.json(), { status: 'ok' });
    assert.equal('version' in first.json(), false);
    let limited = 0;
    for (let request = 0; request < 80; request += 1) {
      const response = await app.inject({ url: '/api/health' });
      if (response.statusCode === 429) {
        limited += 1;
        assert.equal(assertEnvelope(response).code, 'RATE_LIMITED');
      }
    }
    assert.equal(limited, 80 + 1 - 60, 'every request past the 60th is refused');
    // A different client address has its own budget.
    const other = await app.inject({ url: '/api/health', remoteAddress: '198.51.100.7' });
    assert.equal(other.statusCode, 200);
  } finally {
    await app.close();
  }
});
