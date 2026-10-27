import assert from 'node:assert/strict';
import test from 'node:test';
import type { Database } from '@careerscope/core';
import { createApp, type RateLimit } from './app.js';

const origin = 'http://localhost:5280';
const token = 'a'.repeat(64);
const cookie = `careerscope_v2_session=${token}`;
const ownerId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';

/** Fake database whose session row can be revoked; counts how often the session is looked up by token. */
function fake() {
  const state = { live: true, lookups: 0 };
  const database = {
    pool: {
      query: async (sql: string) => {
        if (sql.includes('token_hash = $1 AND access_expires_at')) {
          state.lookups += 1;
          return { rows: state.live ? [{ id: sessionId, owner_id: ownerId }] : [] };
        }
        if (sql.includes('FROM users')) return { rows: [{ email: null, email_verified_at: null }] };
        return { rows: [] };
      },
    },
  } as unknown as Database;
  return { database, state };
}

test('the session is resolved once per request and a revoked session is rejected', async () => {
  const { database, state } = fake();
  const app = await createApp(database, origin, async () => true);
  try {
    const listed = await app.inject({
      method: 'GET',
      url: '/api/account/sessions',
      headers: { cookie },
    });
    assert.equal(listed.statusCode, 200);
    assert.equal(state.lookups, 1);

    state.lookups = 0;
    const current = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
    assert.equal(current.json().authenticated, true);
    assert.equal(state.lookups, 1);

    state.lookups = 0;
    const csrf = current.json().csrf as string;
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/account/sessions/${sessionId}`,
      headers: { cookie, origin, 'x-csrf-token': csrf },
    });
    assert.equal(removed.statusCode, 204);
    assert.equal(state.lookups, 1);

    state.live = false;
    const revokedList = await app.inject({
      method: 'GET',
      url: '/api/account/sessions',
      headers: { cookie },
    });
    assert.equal(revokedList.statusCode, 401);
    const revokedDelete = await app.inject({
      method: 'DELETE',
      url: `/api/account/sessions/${sessionId}`,
      headers: { cookie, origin, 'x-csrf-token': csrf },
    });
    assert.equal(revokedDelete.statusCode, 401);
    const revokedSession = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie },
    });
    assert.equal(revokedSession.json().authenticated, false);
  } finally {
    await app.close();
  }
});

test('authenticated reads, refresh and logout are rate limited by user or token hash', async () => {
  const { database } = fake();
  const keys: string[] = [];
  let allow = true;
  const limiter: RateLimit = async (key) => {
    keys.push(key);
    return allow;
  };
  const app = await createApp(database, origin, limiter);
  try {
    const refreshCookie = `careerscope_v2_refresh=${'b'.repeat(64)}`;
    const request = (method: 'GET' | 'POST', url: string, headers: Record<string, string>) =>
      app.inject({ method, url, headers });
    const csrf = (await request('GET', '/api/session', { cookie })).json().csrf as string;

    for (const url of ['/api/account/sessions', '/api/account/marketing-consent', '/api/resumes']) {
      allow = true;
      assert.notEqual((await request('GET', url, { cookie })).statusCode, 429, url);
      allow = false;
      assert.equal((await request('GET', url, { cookie })).statusCode, 429, url);
    }
    allow = false;
    assert.equal(
      (await request('POST', '/api/session/refresh', { origin, cookie: refreshCookie })).statusCode,
      429,
    );
    assert.equal(
      (await request('POST', '/api/logout', { origin, cookie, 'x-csrf-token': csrf })).statusCode,
      429,
    );
    // Keys carry the user id or a token hash, never the raw token.
    assert.ok(keys.some((key) => key === `sessions-read:${ownerId}`));
    assert.ok(keys.some((key) => /^logout:[a-f0-9]{64}$/.test(key)));
    assert.ok(keys.some((key) => /^session-refresh:[a-f0-9]{64}$/.test(key)));
    assert.ok(keys.every((key) => !key.includes(token)));
  } finally {
    await app.close();
  }
});
