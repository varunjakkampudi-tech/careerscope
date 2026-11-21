import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { Auth, Database, refreshCookie, sessionCookie } from '@careerscope/core';
import { createApp } from './app.js';

const content = {
  fullName: 'Synthetic Candidate',
  email: 'candidate@example.test',
  phone: null,
  location: 'Bengaluru',
  summary: 'Candidate-entered summary.',
  experience: [
    {
      id: 'experience-1',
      role: 'Software Engineer',
      company: 'Synthetic Systems',
      location: 'Bengaluru',
      startDate: '2022',
      endDate: null,
      bullets: ['Built a test service from candidate-provided facts.'],
    },
  ],
  education: [],
  skills: ['TypeScript', 'PostgreSQL'],
};

test(
  'resume drafts are owner-scoped, revision-guarded, and approval is cleared by edits',
  { timeout: 60_000 },
  async () => {
    const configuredDatabase = process.env.DATABASE_URL;
    assert.ok(configuredDatabase, 'integration test requires an isolated DATABASE_URL');
    const databaseUrl = new URL(configuredDatabase);
    assert.ok(['127.0.0.1', 'localhost'].includes(databaseUrl.hostname));
    const admin = new Database(configuredDatabase);
    const name = `test_${randomUUID().replaceAll('-', '')}`;
    const creator = await admin.pool.connect();
    try {
      await creator.query('SET statement_timeout = 0');
      await creator.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    } finally {
      creator.release();
    }
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
      const auth = new Auth(database);
      const ownerCredentials = await auth.loginWithVerifiedEmail(`${ownerId}@example.test`);
      const otherCredentials = await auth.loginWithVerifiedEmail(`${otherOwnerId}@example.test`);
      assert.ok(ownerCredentials);
      assert.ok(otherCredentials);
      const ownerSession = await auth.session(ownerCredentials.accessToken);
      const otherSession = await auth.session(otherCredentials.accessToken);
      assert.ok(ownerSession);
      assert.ok(otherSession);
      const ownerCookie = `${sessionCookie}=${ownerCredentials.accessToken}; ${refreshCookie}=${ownerCredentials.refreshToken}`;
      const otherCookie = `${sessionCookie}=${otherCredentials.accessToken}; ${refreshCookie}=${otherCredentials.refreshToken}`;
      app = await createApp(database, origin, async () => true, {
        testAccess: { mode: 'disabled' },
      });

      const anonymous = await app.inject({
        method: 'GET',
        url: '/api/resume-drafts',
        headers: { origin },
      });
      assert.equal(anonymous.statusCode, 401);

      const created = await app.inject({
        method: 'POST',
        url: '/api/resume-drafts',
        headers: { origin, cookie: ownerCookie, 'x-csrf-token': ownerSession.csrf },
        payload: {
          title: 'Senior engineer',
          targetRole: 'Senior Engineer',
          template: 'classic',
          content,
        },
      });
      assert.equal(created.statusCode, 201, created.body);
      const draft = created.json();
      assert.equal(draft.revision, 1);
      assert.equal(draft.approvedAt, null);
      const otherList = await app.inject({
        url: '/api/resume-drafts',
        headers: { cookie: otherCookie },
      });
      assert.deepEqual(otherList.json().items, []);
      const foreignUpdate = await app.inject({
        method: 'PUT',
        url: `/api/resume-drafts/${draft.id}`,
        headers: { origin, cookie: otherCookie, 'x-csrf-token': otherSession.csrf },
        payload: {
          revision: 1,
          title: 'Changed',
          targetRole: 'Senior Engineer',
          template: 'classic',
          content,
        },
      });
      assert.equal(foreignUpdate.statusCode, 404);

      const approved = await app.inject({
        method: 'POST',
        url: `/api/resume-drafts/${draft.id}/approve`,
        headers: { origin, cookie: ownerCookie, 'x-csrf-token': ownerSession.csrf },
        payload: { revision: 1 },
      });
      assert.equal(approved.statusCode, 200, approved.body);
      assert.ok(approved.json().approvedAt);
      const staleApproval = await app.inject({
        method: 'POST',
        url: `/api/resume-drafts/${draft.id}/approve`,
        headers: { origin, cookie: ownerCookie, 'x-csrf-token': ownerSession.csrf },
        payload: { revision: 2 },
      });
      assert.equal(staleApproval.statusCode, 409);

      const updatedContent = { ...content, summary: 'Candidate-reviewed updated summary.' };
      const updated = await app.inject({
        method: 'PUT',
        url: `/api/resume-drafts/${draft.id}`,
        headers: { origin, cookie: ownerCookie, 'x-csrf-token': ownerSession.csrf },
        payload: {
          revision: 1,
          title: 'Senior engineer',
          targetRole: 'Senior Engineer',
          template: 'modern',
          content: updatedContent,
        },
      });
      assert.equal(updated.statusCode, 200, updated.body);
      assert.equal(updated.json().revision, 2);
      assert.equal(updated.json().approvedAt, null);
      const staleEdit = await app.inject({
        method: 'PUT',
        url: `/api/resume-drafts/${draft.id}`,
        headers: { origin, cookie: ownerCookie, 'x-csrf-token': ownerSession.csrf },
        payload: {
          revision: 1,
          title: 'Senior engineer',
          targetRole: 'Senior Engineer',
          template: 'modern',
          content: updatedContent,
        },
      });
      assert.equal(staleEdit.statusCode, 409);

      const removed = await app.inject({
        method: 'DELETE',
        url: `/api/resume-drafts/${draft.id}`,
        headers: { origin, cookie: ownerCookie, 'x-csrf-token': ownerSession.csrf },
      });
      assert.equal(removed.statusCode, 204);
    } finally {
      await app?.close();
      await database.close();
      await admin.pool.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.close();
    }
  },
);
