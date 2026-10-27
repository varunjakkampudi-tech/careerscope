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
    assert.equal(body.message, 'Service unavailable');
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
