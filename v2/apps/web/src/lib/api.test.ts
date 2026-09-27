import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, api, offersDiscardAndReload } from './api';

/**
 * CS-35 AC3, client half: every supported conflict code, an unknown code and a
 * set of malformed 409 bodies, asserted against the real `api()` helper the
 * components call - not a copy of its logic.
 *
 * The fetch stub returns a real `Response`, so body parsing runs for real; a
 * body that cannot be parsed has to be handled by `api()` itself rather than by
 * the test.
 */
const GENERIC_CONFLICT = 'This record changed in another session. Your edits have not been saved.';

// Deliberately shaped like something an internal error could leak: if any of
// these tests ever sees this string, the client is echoing server text.
const SERVER_DETAIL = 'relation "searches" does not exist at character 42';

function stubFetch(body: string, init: ResponseInit = { status: 409 }) {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(body, { headers: { 'Content-Type': 'application/json' }, ...init });
  return () => {
    globalThis.fetch = original;
  };
}

async function conflictFrom(body: string): Promise<ApiError> {
  const restore = stubFetch(body);
  try {
    // A malformed or unknown conflict must never resolve: `api()` returning a
    // value here would mean the caller treated a 409 as a saved record.
    const result = await api('/profile', { method: 'PUT', body: '{}' }).then(
      (value) => ({ resolved: true, value }) as const,
      (error: unknown) => ({ resolved: false, error }) as const,
    );
    assert.equal(result.resolved, false, 'a 409 must reject, never resolve');
    assert.ok(result.resolved === false && result.error instanceof ApiError);
    return result.error;
  } finally {
    restore();
  }
}

const SUPPORTED: [code: string, message: string][] = [
  ['PROFILE_REVISION_CONFLICT', GENERIC_CONFLICT],
  ['LEAD_REVISION_CONFLICT', GENERIC_CONFLICT],
  [
    'PROFILE_NOT_SAVED',
    'Save your profile before enabling this option. Your edits are still here.',
  ],
  ['MISSING_TARGET_ROLES', 'Add target roles to your profile before starting this search.'],
  ['IDEMPOTENCY_KEY_REUSED', 'This request already completed with different details. Try again.'],
  ['UPLOAD_CANCELLED', 'This upload was already cancelled.'],
  ['UPLOAD_NOT_CANCELLABLE', 'This upload can no longer be cancelled.'],
  ['UPLOAD_VERSION_CONFLICT', 'This upload changed. Refresh and try again.'],
];

test('CS-35: every supported conflict code reaches the client and picks its own message', async () => {
  const seen = new Set<string>();
  for (const [code, message] of SUPPORTED) {
    const error = await conflictFrom(
      JSON.stringify({ error: SERVER_DETAIL, code, requestId: 'r-1' }),
    );
    assert.equal(error.status, 409);
    assert.equal(error.code, code, `${code} must survive the network boundary`);
    assert.equal(error.message, message);
    assert.ok(!error.message.includes(SERVER_DETAIL), `${code} must not echo server text`);
    seen.add(message);
  }
  // The bug this ticket exists to fix: several distinct conflicts sharing one
  // message. The two revision conflicts legitimately share one, so seven of the
  // eight messages must still be distinct from each other.
  assert.equal(seen.size, 7);
});

test('CS-35: an unknown code falls back to the generic conflict without carrying the code', async () => {
  const error = await conflictFrom(
    JSON.stringify({ error: SERVER_DETAIL, code: 'SOME_FUTURE_CODE', requestId: 'r-2' }),
  );
  assert.equal(error.status, 409);
  assert.equal(error.code, undefined);
  assert.equal(error.message, GENERIC_CONFLICT);
  assert.ok(!error.message.includes(SERVER_DETAIL));
});

test('CS-35: malformed conflict bodies fall back safely and never read as success', async () => {
  const malformed = [
    'not json at all',
    '',
    'null',
    '[{"code":"PROFILE_REVISION_CONFLICT"}]',
    '"PROFILE_REVISION_CONFLICT"',
    '{"code":42}',
    '{"code":null}',
    '{"code":{"toString":"PROFILE_REVISION_CONFLICT"}}',
    `{"code":["PROFILE_REVISION_CONFLICT"],"error":${JSON.stringify(SERVER_DETAIL)}}`,
    '{"error":"no code field"}',
    '{"code":"__proto__"}',
    '{"code":"toString"}',
  ];
  for (const body of malformed) {
    const error = await conflictFrom(body);
    assert.equal(error.status, 409, body);
    assert.equal(error.code, undefined, body);
    assert.equal(error.message, GENERIC_CONFLICT, body);
    assert.ok(!error.message.includes(SERVER_DETAIL), body);
  }
});

test('CS-35: only a revision or unrecognised conflict offers to discard unsaved edits', async () => {
  for (const code of ['PROFILE_REVISION_CONFLICT', 'LEAD_REVISION_CONFLICT']) {
    assert.equal(offersDiscardAndReload(new ApiError(409, GENERIC_CONFLICT, code)), true, code);
  }
  // A 409 with no recognised code keeps the pre-CS-35 behaviour, so a genuine
  // stale record is still recoverable when the code is missing.
  assert.equal(offersDiscardAndReload(new ApiError(409, GENERIC_CONFLICT)), true);

  for (const [code] of SUPPORTED.filter(([value]) => !value.endsWith('_REVISION_CONFLICT'))) {
    assert.equal(
      offersDiscardAndReload(new ApiError(409, 'irrelevant', code)),
      false,
      `${code} must not invite the owner to discard unsaved edits`,
    );
  }
  assert.equal(offersDiscardAndReload(new ApiError(400, 'Check the fields and try again.')), false);
  assert.equal(offersDiscardAndReload(new Error('not an ApiError')), false);
  assert.equal(offersDiscardAndReload(undefined), false);
});

test('CS-35: non-conflict statuses keep their existing messages and carry no code', async () => {
  for (const [status, message] of [
    [400, 'Check the fields and try again.'],
    [413, 'The submitted data is too large.'],
    [429, 'Too many requests. Try again shortly.'],
    [500, 'Request failed. Please try again.'],
  ] as [number, string][]) {
    const restore = stubFetch(JSON.stringify({ error: SERVER_DETAIL, code: 'UPLOAD_CANCELLED' }), {
      status,
    });
    try {
      await assert.rejects(
        api('/profile', { method: 'PUT', body: '{}' }),
        (error: unknown) =>
          error instanceof ApiError &&
          error.status === status &&
          error.message === message &&
          error.code === undefined,
      );
    } finally {
      restore();
    }
  }
});
