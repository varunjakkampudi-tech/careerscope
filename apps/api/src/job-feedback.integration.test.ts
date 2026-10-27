import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Auth, Database, refreshCookie, sessionCookie } from '@careerscope/core';
import { createApp } from './app.js';

test(
  'job feedback is validated, owner-scoped, idempotent per owner/job, and follows search-job retention',
  { timeout: 60_000 },
  async () => {
    const configuredDatabase = process.env.DATABASE_URL;
    assert.ok(configuredDatabase, 'integration test requires an isolated DATABASE_URL');
    const databaseUrl = new URL(configuredDatabase);
    assert.ok(['127.0.0.1', 'localhost'].includes(databaseUrl.hostname));
    const admin = new Database(configuredDatabase);
    const name = `test_${randomUUID().replaceAll('-', '')}`;
    await admin.pool.query(`CREATE DATABASE "${name}"`);
    databaseUrl.pathname = `/${name}`;
    const database = new Database(databaseUrl.href);
    const origin = 'https://careerscope.test';
    let app: FastifyInstance | undefined;

    try {
      await migrate(database.db, {
        migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
      });
      const ownerId = randomUUID();
      const otherOwnerId = randomUUID();
      await database.pool.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [
        ownerId,
        `${ownerId}@example.test`,
        otherOwnerId,
        `${otherOwnerId}@example.test`,
      ]);
      const ownerSearch = await database.createSearch(ownerId, 'feedback-owner-search', {
        query: 'React engineer',
        sources: ['remoteok'],
      });
      const foreignSearch = await database.createSearch(otherOwnerId, 'feedback-foreign-search', {
        query: 'React engineer',
        sources: ['remoteok'],
      });
      const ownerJobId = randomUUID();
      const foreignJobId = randomUUID();
      const job = {
        fingerprint: 'synthetic-feedback-posting',
        sourceJobId: 'synthetic-feedback-posting',
        title: 'React Engineer',
        company: 'Synthetic Company',
        location: 'Remote',
        description: 'Synthetic job used only for isolated integration tests.',
        source: 'remoteok',
        sourceUrl: 'https://remoteok.com/remote-jobs/feedback-fixture',
        applyUrl: 'https://example.test/apply',
        postedAt: null,
        match: null,
      };
      await database.pool.query(
        `INSERT INTO search_jobs (id, owner_id, run_id, fingerprint, data)
         VALUES ($1, $2, $3, $4, $5::jsonb), ($6, $7, $8, $9, $5::jsonb)`,
        [
          ownerJobId,
          ownerId,
          ownerSearch.id,
          job.fingerprint,
          JSON.stringify(job),
          foreignJobId,
          otherOwnerId,
          foreignSearch.id,
          'synthetic-foreign-feedback-posting',
        ],
      );

      const auth = new Auth(database);
      const ownerCredentials = await auth.loginWithVerifiedEmail(`${ownerId}@example.test`);
      const foreignCredentials = await auth.loginWithVerifiedEmail(`${otherOwnerId}@example.test`);
      assert.ok(ownerCredentials);
      assert.ok(foreignCredentials);
      const ownerSession = await auth.session(ownerCredentials.accessToken);
      const foreignSession = await auth.session(foreignCredentials.accessToken);
      assert.ok(ownerSession);
      assert.ok(foreignSession);
      const ownerCookie = `${sessionCookie}=${ownerCredentials.accessToken}; ${refreshCookie}=${ownerCredentials.refreshToken}`;
      const foreignCookie = `${sessionCookie}=${foreignCredentials.accessToken}; ${refreshCookie}=${foreignCredentials.refreshToken}`;
      let allowed = true;
      app = await createApp(database, origin, async () => allowed, {
        testAccess: { mode: 'disabled' },
      });

      const endpoint = `/api/search-jobs/${ownerJobId}/feedback`;
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: endpoint,
            headers: { origin },
            payload: { reason: 'irrelevant' },
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: endpoint,
            headers: { origin, cookie: ownerCookie },
            payload: { reason: 'irrelevant' },
          })
        ).statusCode,
        403,
        'a feedback mutation requires CSRF protection',
      );

      const invalid = await app.inject({
        method: 'PUT',
        url: endpoint,
        headers: { origin, cookie: ownerCookie, 'x-csrf-token': ownerSession.csrf },
        payload: { reason: 'fake', details: 'must not be accepted or stored' },
      });
      assert.equal(invalid.statusCode, 400);
      assert.equal(
        (await database.pool.query('SELECT id FROM job_feedback')).rowCount,
        0,
        'invalid feedback has no persistence side effect',
      );

      const listBefore = await app.inject({
        url: `/api/searches/${ownerSearch.id}`,
        headers: { cookie: ownerCookie },
      });
      assert.equal(listBefore.statusCode, 200);
      assert.equal(listBefore.json().jobs[0].feedbackReason, null);
      assert.equal(
        (
          await app.inject({
            url: `/api/searches/${ownerSearch.id}`,
            headers: { cookie: foreignCookie },
          })
        ).statusCode,
        404,
      );

      const headers = { origin, cookie: ownerCookie, 'x-csrf-token': ownerSession.csrf };
      for (const reason of ['irrelevant', 'duplicate'] as const) {
        const saved: LightMyRequestResponse = await app.inject({
          method: 'PUT',
          url: endpoint,
          headers,
          payload: { reason },
        });
        assert.equal(saved.statusCode, 200, saved.body);
        assert.deepEqual(saved.json(), { reason });
      }
      const row = await database.pool.query(
        'SELECT owner_id, job_id, reason FROM job_feedback WHERE owner_id = $1 AND job_id = $2',
        [ownerId, ownerJobId],
      );
      assert.deepEqual(row.rows, [{ owner_id: ownerId, job_id: ownerJobId, reason: 'duplicate' }]);
      assert.equal((await database.pool.query('SELECT id FROM job_feedback')).rowCount, 1);

      const detailAfter = await app.inject({
        url: `/api/searches/${ownerSearch.id}`,
        headers: { cookie: ownerCookie },
      });
      assert.equal(detailAfter.json().jobs[0].feedbackReason, 'duplicate');
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/search-jobs/${ownerJobId}/feedback`,
            headers: { origin, cookie: foreignCookie, 'x-csrf-token': foreignSession.csrf },
            payload: { reason: 'suspicious' },
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: `/api/search-jobs/${foreignJobId}/feedback`,
            headers,
            payload: { reason: 'suspicious' },
          })
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/search-jobs/not-a-uuid/feedback',
            headers,
            payload: { reason: 'suspicious' },
          })
        ).statusCode,
        400,
      );

      allowed = false;
      assert.equal(
        (
          await app.inject({
            method: 'PUT',
            url: endpoint,
            headers,
            payload: { reason: 'incorrect' },
          })
        ).statusCode,
        429,
      );
      allowed = true;

      const docs = await app.inject({ url: '/api/docs/json', headers: { cookie: ownerCookie } });
      assert.equal(docs.statusCode, 200);
      assert.ok(docs.json().paths['/api/search-jobs/{id}/feedback']?.put);
      const searchDetailSchema =
        docs.json().paths['/api/searches/{id}']?.get?.responses?.['200']?.content?.[
          'application/json'
        ]?.schema?.properties?.jobs?.items?.properties;
      assert.deepEqual(searchDetailSchema?.feedbackReason, {
        type: 'string',
        nullable: true,
        enum: ['irrelevant', 'duplicate', 'incorrect', 'unavailable', 'suspicious'],
      });
      await database.pool.query('DELETE FROM search_jobs WHERE id = $1', [ownerJobId]);
      assert.equal(
        (await database.pool.query('SELECT id FROM job_feedback WHERE job_id = $1', [ownerJobId]))
          .rowCount,
        0,
        'feedback is deleted with its retained search result',
      );
    } finally {
      await app?.close();
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.close();
    }
  },
);
