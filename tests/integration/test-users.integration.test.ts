import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createApp } from '../../apps/api/src/app.js';
import { Database } from '../../packages/core/src/database.js';
import { testUsers } from '../../packages/core/src/test-users.js';

test('private test selection enforces the edge boundary, allowlist, rotation and owner isolation', async () => {
  assert.ok(process.env.DATABASE_URL);
  const url = new URL(process.env.DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1'].includes(url.hostname));
  const admin = new Database(url.href);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await admin.pool.query(`CREATE DATABASE "${name}"`);
  url.pathname = `/${name}`;
  const database = new Database(url.href);
  const origin = 'https://staging.example.invalid';
  const secret = 'a'.repeat(64);
  const app = await createApp(database, origin, async () => true, {
    testAccess: { mode: 'proxy', proxySecret: secret },
  });
  const headers = { origin, 'x-careerscope-staging-key': secret };
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../migrations', import.meta.url)),
    });
    for (const request of [
      { url: '/api/session' },
      { url: '/api/session', headers: { 'x-careerscope-staging-key': 'b'.repeat(64) } },
      { url: '/api/session', headers, remoteAddress: '203.0.113.5' },
    ])
      assert.equal((await app.inject(request)).statusCode, 403);
    const discovery = await app.inject({ url: '/api/session', headers });
    assert.equal(discovery.statusCode, 200);
    assert.deepEqual(
      discovery.json().testAccounts,
      testUsers.map(({ email, role }) => ({ email, role })),
    );
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers,
      payload: { email: 'unknown@example.invalid' },
    });
    assert.equal(unknown.statusCode, 401);
    assert.equal(
      Number((await database.pool.query('SELECT count(*) FROM users')).rows[0].count),
      0,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/login',
          headers,
          payload: { email: testUsers[0].email, role: 'admin' },
        })
      ).statusCode,
      400,
    );
    const candidate = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers,
      payload: { email: testUsers[0].email },
    });
    assert.equal(candidate.statusCode, 200);
    const candidateCookies = candidate.headers['set-cookie'];
    const candidateSetCookies = Array.isArray(candidateCookies)
      ? candidateCookies
      : [String(candidateCookies)];
    assert.equal(candidateSetCookies.length, 2);
    assert.ok(candidateSetCookies.every((value) => /HttpOnly/i.test(value)));
    assert.ok(candidateSetCookies.every((value) => /Secure/i.test(value)));
    assert.ok(candidateSetCookies.every((value) => /SameSite=Strict/i.test(value)));
    const cookie = candidateSetCookies
      .find((value) => value.startsWith('careerscope_v2_session='))!
      .split(';', 1)[0]!;
    const session = (
      await app.inject({ url: '/api/session', headers: { ...headers, cookie } })
    ).json();
    assert.equal(session.email, testUsers[0].email);
    assert.equal('phone' in session, false);
    assert.equal(session.testUser, 'candidate');
    const secondDevice = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers,
      payload: { email: testUsers[0].email },
    });
    assert.equal(secondDevice.statusCode, 200);
    const secondDeviceSetCookies = secondDevice.headers['set-cookie'];
    const secondDeviceCookie = (
      Array.isArray(secondDeviceSetCookies)
        ? secondDeviceSetCookies
        : [String(secondDeviceSetCookies)]
    )
      .find((value) => value.startsWith('careerscope_v2_session='))!
      .split(';', 1)[0]!;
    const secondDeviceSession = (
      await app.inject({ url: '/api/session', headers: { ...headers, cookie: secondDeviceCookie } })
    ).json();
    const inventory = await app.inject({
      url: '/api/account/sessions',
      headers: { ...headers, cookie },
    });
    assert.equal(inventory.statusCode, 200);
    assert.equal(inventory.json().sessions.length, 2);
    const otherDevice = inventory
      .json()
      .sessions.find((item: { id: string }) => item.id === secondDeviceSession.sessionId);
    assert.ok(otherDevice);
    assert.equal(otherDevice.current, false);
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/account/sessions/${otherDevice.id}`,
          headers: { ...headers, cookie, 'x-csrf-token': session.csrf },
        })
      ).statusCode,
      204,
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/session',
          headers: { ...headers, cookie: secondDeviceCookie },
        })
      ).json().authenticated,
      false,
      'revoking one device invalidates that device access token',
    );
    assert.equal(
      (
        await app.inject({
          url: '/api/account/sessions',
          headers: { ...headers, cookie },
        })
      ).json().sessions.length,
      1,
    );
    const rotated = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { ...headers, cookie },
      payload: { email: testUsers[0].email },
    });
    assert.equal(rotated.statusCode, 200);
    const rotatedSetCookies = rotated.headers['set-cookie'];
    const rotatedCookie = (
      Array.isArray(rotatedSetCookies) ? rotatedSetCookies : [String(rotatedSetCookies)]
    )
      .find((value) => value.startsWith('careerscope_v2_session='))!
      .split(';', 1)[0]!;
    const currentCandidateSession = (
      await app.inject({ url: '/api/session', headers: { ...headers, cookie: rotatedCookie } })
    ).json();
    assert.equal(
      (await app.inject({ url: '/api/session', headers: { ...headers, cookie } })).json()
        .authenticated,
      false,
    );
    const adminSession = await app.inject({
      method: 'POST',
      url: '/api/login',
      headers,
      payload: { email: testUsers[1].email },
    });
    assert.equal(adminSession.statusCode, 200);
    const adminSetCookies = adminSession.headers['set-cookie'];
    const adminCookie = (
      Array.isArray(adminSetCookies) ? adminSetCookies : [String(adminSetCookies)]
    )
      .find((value) => value.startsWith('careerscope_v2_session='))!
      .split(';', 1)[0]!;
    const adminIdentity = (
      await app.inject({ url: '/api/session', headers: { ...headers, cookie: adminCookie } })
    ).json();
    assert.equal(adminIdentity.testUser, 'admin');
    assert.notEqual(adminIdentity.owner, session.owner);
    assert.equal(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/account/sessions/${currentCandidateSession.sessionId}`,
          headers: { ...headers, cookie: adminCookie, 'x-csrf-token': adminIdentity.csrf },
        })
      ).statusCode,
      204,
      'a cross-owner session revoke is indistinguishable from a missing session',
    );
    assert.equal(
      (
        await app.inject({ url: '/api/session', headers: { ...headers, cookie: rotatedCookie } })
      ).json().authenticated,
      true,
      'an admin cannot revoke another owner session',
    );
    const run = await database.createSearch(testUsers[0].id, 'private-test-selection', {
      query: 'Private candidate search',
      sources: ['remoteok'],
    });
    assert.equal(
      (
        await app.inject({
          url: `/api/searches/${run.id}`,
          headers: { ...headers, cookie: adminCookie },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/register',
          headers,
          payload: { email: 'new@example.invalid', password: randomUUID() },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/account/password',
          headers: { ...headers, cookie: adminCookie, 'x-csrf-token': adminIdentity.csrf },
          payload: {},
        })
      ).statusCode,
      404,
    );
  } finally {
    await app.close();
    await database.close();
    await admin.pool.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.close();
  }
});
