import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Database } from './database.js';
import { Auth } from './auth.js';
import { boundedLimit, boundedRange } from './admin.js';
import { errorFingerprint } from './errors.js';
import { createApp } from '../../../apps/api/src/app.js';

// Proves the admin surface cannot be used to reach another account's data, and
// that it does not leak secrets into its own responses.
test('admin debugging is owner-gated, bounded and free of secrets', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured);
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  const root = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await root.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  const origin = 'http://localhost:5280';
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const auth = new Auth(database);
    const password = randomUUID();
    await auth.register('operator@example.test', password);
    await auth.register('subject@example.test', password);
    await auth.register('intruder@example.test', password);

    const sessionFor = async (email: string) => {
      const token = await auth.login(email, password);
      assert.ok(token);
      const session = await auth.session(token);
      assert.ok(session);
      return { token, csrf: session.csrf, ownerId: session.ownerId };
    };
    const operator = await sessionFor('operator@example.test');
    const subject = await sessionFor('subject@example.test');
    const intruder = await sessionFor('intruder@example.test');

    // Only the operator is an administrator, and only because the database says
    // so. Nothing in a request can grant this.
    await database.pool.query('UPDATE users SET is_admin = true WHERE id = $1', [operator.ownerId]);

    const app = await createApp(database, origin, async () => true);
    try {
      const call = (url: string, who?: { token: string }) =>
        app.inject({
          method: 'GET',
          url,
          headers: {
            origin,
            ...(who ? { cookie: `careerscope_v2_session=${who.token}` } : {}),
          },
        });
      // Without the body the failure is just "500 !== 200", which says nothing
      // about which query was wrong.
      const expectStatus = async (
        url: string,
        who: { token: string } | undefined,
        expected: number,
      ) => {
        const response = await call(url, who);
        assert.equal(
          response.statusCode,
          expected,
          `${url} -> ${response.statusCode}: ${response.body}`,
        );
        return response;
      };

      // Unauthenticated, then authenticated-but-not-admin.
      await expectStatus('/api/admin/overview', undefined, 401);
      await expectStatus('/api/admin/overview', intruder, 403);
      await expectStatus(`/api/admin/timeline?user=subject@example.test`, intruder, 403);
      await expectStatus('/api/admin/overview', operator, 200);

      // The denial is recorded against the account that attempted it.
      const denials = await database.pool.query(
        `SELECT actor_id, outcome FROM audit_events WHERE outcome = 'denied' AND actor_id = $1`,
        [intruder.ownerId],
      );
      assert.ok(denials.rowCount && denials.rowCount >= 2);

      // A non-admin cannot become one by naming themselves, and an admin cannot
      // reach an account that does not exist.
      await expectStatus('/api/admin/timeline?user=does-not-exist@example.test', operator, 404);
      await expectStatus('/api/admin/timeline?user=', operator, 400);

      // Ownership is resolved server-side: asking for one account never returns
      // another account's rows.
      const subjectRun = randomUUID();
      const intruderRun = randomUUID();
      for (const [owner, id] of [
        [subject.ownerId, subjectRun],
        [intruder.ownerId, intruderRun],
      ] as const) {
        await database.pool.query(
          `INSERT INTO search_runs (id, owner_id, request, request_hash, idempotency_key, status)
           VALUES ($1, $2, '{}'::jsonb, 'hash', $3, 'completed')`,
          [id, owner, `key-${id}`],
        );
      }
      const crossOwner = await call(
        `/api/admin/runs/${intruderRun}?user=subject@example.test`,
        operator,
      );
      assert.equal(
        crossOwner.statusCode,
        404,
        `a run belonging to another owner must not resolve: ${crossOwner.body}`,
      );
      await expectStatus(`/api/admin/runs/${subjectRun}?user=subject@example.test`, operator, 200);

      // No secret material may appear in any admin response.
      const surfaces = await Promise.all(
        [
          '/api/admin/overview',
          '/api/admin/users?user=subject@example.test',
          '/api/admin/timeline?user=subject@example.test',
          '/api/admin/diagnostics',
          '/api/admin/audit',
        ].map((url) => call(url, operator)),
      );
      for (const response of surfaces) {
        assert.equal(response.statusCode, 200, response.body);
        const body = response.body.toLowerCase();
        for (const forbidden of [
          'password_hash',
          'passwordhash',
          'token_hash',
          'tokenhash',
          'csrf',
          'encryption',
          'postgres://',
          'redis://',
          'secret',
          '$argon2',
        ]) {
          assert.ok(!body.includes(forbidden), `admin response leaked ${forbidden}`);
        }
      }

      // Pagination and ranges are clamped rather than trusted.
      const flooded = await call('/api/admin/audit?limit=100000', operator);
      assert.equal(flooded.statusCode, 200);
      assert.ok(JSON.parse(flooded.body).entries.length <= 100);
    } finally {
      await app.close();
    }
  } finally {
    await database.pool.end();
    await root.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root.pool.end();
  }
});

test('admin query bounds cannot be widened by the caller', () => {
  assert.equal(boundedLimit(undefined), 50);
  assert.equal(boundedLimit(1_000_000), 100);
  assert.equal(boundedLimit(-5), 50);
  assert.equal(boundedLimit('20'), 20);
  assert.equal(boundedLimit(Number.NaN), 50);

  // A range longer than the maximum is clamped to it, not honoured.
  const wide = boundedRange('1970-01-01T00:00:00.000Z', '2026-01-31T00:00:00.000Z');
  const days = (wide.end.getTime() - wide.start.getTime()) / 86_400_000;
  assert.ok(days <= 31, `range was ${days} days`);
  assert.throws(() => boundedRange('not-a-date', undefined), RangeError);
});

test('error fingerprints group recurrences without absorbing unrelated failures', () => {
  const base = {
    errorCode: 'internal_error',
    service: 'api',
    route: '/api/leads/:id',
    method: 'GET',
    errorClass: 'TypeError',
  };
  // Same failure, different occurrence: must group.
  assert.equal(errorFingerprint(base), errorFingerprint({ ...base }));
  // Anything that identifies the *kind* of failure must split it.
  assert.notEqual(errorFingerprint(base), errorFingerprint({ ...base, errorCode: 'rate_limited' }));
  assert.notEqual(errorFingerprint(base), errorFingerprint({ ...base, route: '/api/searches' }));
  assert.notEqual(errorFingerprint(base), errorFingerprint({ ...base, method: 'POST' }));
  assert.notEqual(errorFingerprint(base), errorFingerprint({ ...base, service: 'worker' }));
  // Stable across processes, so it can be stored and compared later.
  assert.match(errorFingerprint(base), /^[a-f0-9]{16}$/);
});

test('advanced admin surfaces stay owner-gated, bounded and redacted', async () => {
  const configured = process.env.DATABASE_URL;
  assert.ok(configured);
  const base = new URL(configured);
  assert.ok(['127.0.0.1', 'localhost'].includes(base.hostname));
  const root = new Database(configured);
  const name = `test_${randomUUID().replaceAll('-', '')}`;
  await root.pool.query(`CREATE DATABASE "${name}"`);
  base.pathname = `/${name}`;
  const database = new Database(base.href);
  const origin = 'http://localhost:5280';
  try {
    await migrate(database.db, {
      migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
    });
    const auth = new Auth(database);
    const password = randomUUID();
    await auth.register('adv-operator@example.test', password);
    await auth.register('adv-intruder@example.test', password);
    const sessionFor = async (email: string) => {
      const token = await auth.login(email, password);
      assert.ok(token);
      const session = await auth.session(token);
      assert.ok(session);
      return { token, csrf: session.csrf, ownerId: session.ownerId };
    };
    const operator = await sessionFor('adv-operator@example.test');
    const intruder = await sessionFor('adv-intruder@example.test');
    await database.pool.query('UPDATE users SET is_admin = true WHERE id = $1', [operator.ownerId]);

    const app = await createApp(database, origin, async () => true);
    try {
      const get = (url: string, who?: { token: string }) =>
        app.inject({
          method: 'GET',
          url,
          headers: { origin, ...(who ? { cookie: `careerscope_v2_session=${who.token}` } : {}) },
        });

      const advanced = [
        '/api/admin/fingerprints',
        '/api/admin/revisions',
        '/api/admin/security',
        '/api/admin/debug-sessions',
      ];
      // Every new surface inherits the same gate as the rest.
      for (const url of advanced) {
        assert.equal((await get(url)).statusCode, 401, `${url} unauthenticated`);
        assert.equal((await get(url, intruder)).statusCode, 403, `${url} non-admin`);
        const allowed = await get(url, operator);
        assert.equal(allowed.statusCode, 200, `${url} -> ${allowed.body}`);
        const body = allowed.body.toLowerCase();
        for (const forbidden of ['password_hash', 'token_hash', 'csrf', '$argon2', 'postgres://']) {
          assert.ok(!body.includes(forbidden), `${url} leaked ${forbidden}`);
        }
      }

      // A debug session must carry a reason, cannot be opened by a non-admin,
      // and cannot be opened for longer than the cap.
      const open = (payload: unknown, who: { token: string; csrf: string }) =>
        app.inject({
          method: 'POST',
          url: '/api/admin/debug-sessions',
          headers: {
            origin,
            cookie: `careerscope_v2_session=${who.token}`,
            'x-csrf-token': who.csrf,
            'content-type': 'application/json',
          },
          payload,
        });
      assert.equal((await open({ reason: 'investigating report' }, intruder)).statusCode, 403);
      assert.equal((await open({ reason: 'no' }, operator)).statusCode, 400);
      assert.equal(
        (await open({ reason: 'valid reason', minutes: 9999 }, operator)).statusCode,
        400,
      );

      const started = await open({ reason: 'investigating a user report', minutes: 5 }, operator);
      assert.equal(started.statusCode, 200, started.body);
      const session = JSON.parse(started.body);
      assert.ok(new Date(session.expiresAt) > new Date(session.startedAt));
      assert.ok(
        new Date(session.expiresAt).getTime() - new Date(session.startedAt).getTime() <=
          120 * 60_000,
        'debug session must not exceed the cap',
      );

      // Starting and ending are both accountable.
      const audited = await database.pool.query(
        `SELECT action FROM audit_events WHERE action LIKE 'admin.debug-session%' ORDER BY sequence`,
      );
      assert.ok(audited.rows.some((row) => row.action === 'admin.debug-session.start'));

      const ended = await app.inject({
        method: 'DELETE',
        url: `/api/admin/debug-sessions/${session.id}`,
        headers: {
          origin,
          cookie: `careerscope_v2_session=${operator.token}`,
          'x-csrf-token': operator.csrf,
        },
      });
      assert.equal(ended.statusCode, 204, ended.body);
      const closed = await database.pool.query(
        `SELECT ended_at FROM debug_sessions WHERE id = $1`,
        [session.id],
      );
      assert.ok(closed.rows[0].ended_at, 'ending a debug session must record when it closed');

      // The security view must not be a dumping ground for ordinary activity.
      const securityView = await get('/api/admin/security', operator);
      for (const entry of JSON.parse(securityView.body).entries) {
        assert.ok(
          String(entry.action).startsWith('security.'),
          `security view returned a non-security action: ${entry.action}`,
        );
      }
    } finally {
      await app.close();
    }
  } finally {
    await database.pool.end();
    await root.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root.pool.end();
  }
});
