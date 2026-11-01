import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { Auth, Database, refreshCookie, sessionCookie } from '@careerscope/core';
import { createApp } from './app.js';

test(
  'application CSV export is authenticated, owner-scoped and excludes non-application records',
  { timeout: 60_000 },
  async () => {
    const configuredDatabase = process.env.DATABASE_URL;
    assert.ok(configuredDatabase, 'integration test requires an isolated DATABASE_URL');
    const databaseUrl = new URL(configuredDatabase);
    assert.ok(['127.0.0.1', 'localhost'].includes(databaseUrl.hostname));

    const admin = new Database(configuredDatabase);
    const name = `test_${randomUUID().replaceAll('-', '')}`;
    // A cold container copies the template slowly; lift the pool statement timeout for this one statement only.
    const creator = await admin.pool.connect();
    try {
      await creator.query('SET statement_timeout = 0');
      await creator.query(`CREATE DATABASE "${name}"`);
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
      const applicationId = randomUUID();
      const foreignApplicationId = randomUUID();
      const savedLeadId = randomUUID();
      const candidateOnlyApplicationId = randomUUID();
      await database.pool.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [
        ownerId,
        `${ownerId}@example.test`,
        otherOwnerId,
        `${otherOwnerId}@example.test`,
      ]);
      const job = (fingerprint: string, title: string) => ({
        fingerprint,
        title,
        company: 'Synthetic Company',
        location: 'Remote',
        description: 'Must never appear in application export',
        source: 'greenhouse',
        sourceUrl: 'https://jobs.example.test/role',
        applyUrl: 'https://jobs.example.test/apply',
        postedAt: null,
        match: null,
      });
      const evidence = {
        method: 'Employer website',
        appliedAt: '2026-10-20T12:00:00.000Z',
        confirmation: 'received',
        source: 'Candidate entry',
        confidence: 'medium',
      };
      await database.pool.query(
        `INSERT INTO saved_leads
          (id, owner_id, fingerprint, data, notes, status, application_evidence)
         VALUES
          ($1, $2, $3, $4::jsonb, 'Candidate-owned note', 'applied', $5::jsonb),
          ($6, $7, $8, $9::jsonb, 'Foreign-owner secret', 'offer', $5::jsonb),
          ($10, $2, $11, $12::jsonb, 'Saved only', 'saved', NULL),
          ($13, $2, $14, $15::jsonb, 'Candidate-only application claim', 'applied', $5::jsonb)`,
        [
          applicationId,
          ownerId,
          `application-${applicationId}`,
          JSON.stringify(job(`application-${applicationId}`, 'Candidate Role')),
          JSON.stringify(evidence),
          foreignApplicationId,
          otherOwnerId,
          `application-${foreignApplicationId}`,
          JSON.stringify(job(`application-${foreignApplicationId}`, 'Foreign Secret Role')),
          savedLeadId,
          `saved-${savedLeadId}`,
          JSON.stringify(job(`saved-${savedLeadId}`, 'Saved Only Role')),
          candidateOnlyApplicationId,
          `application-${candidateOnlyApplicationId}`,
          JSON.stringify(job(`application-${candidateOnlyApplicationId}`, 'Candidate Claim Role')),
        ],
      );
      await database.pool.query(
        `INSERT INTO employer_application_acknowledgements
          (id, owner_id, lead_id, received_at, source, reference)
         VALUES ($1, $2, $3, $4, 'Employer confirmation email', 'synthetic-ref-1')`,
        [randomUUID(), ownerId, applicationId, '2026-10-21T10:00:00.000Z'],
      );

      const auth = new Auth(database);
      const credentials = await auth.loginWithVerifiedEmail(`${ownerId}@example.test`);
      const otherCredentials = await auth.loginWithVerifiedEmail(`${otherOwnerId}@example.test`);
      assert.ok(credentials);
      assert.ok(otherCredentials);
      const session = await auth.session(credentials.accessToken);
      const otherSession = await auth.session(otherCredentials.accessToken);
      assert.ok(session);
      assert.ok(otherSession);
      const cookie = `${sessionCookie}=${credentials.accessToken}; ${refreshCookie}=${credentials.refreshToken}`;
      const otherCookie = `${sessionCookie}=${otherCredentials.accessToken}; ${refreshCookie}=${otherCredentials.refreshToken}`;
      app = await createApp(database, origin, async () => true, {
        testAccess: { mode: 'disabled' },
      });

      const unauthenticated = await app.inject({ url: '/api/applications/export' });
      assert.equal(unauthenticated.statusCode, 401);

      const ownApplication = await app.inject({
        url: `/api/leads/${applicationId}`,
        headers: { cookie },
      });
      assert.equal(ownApplication.statusCode, 200, ownApplication.body);
      assert.equal(ownApplication.json().applicationEvidence.confirmation, 'received');
      const employerAcknowledgement = ownApplication.json().employerAcknowledgement as {
        receivedAt: string;
        source: string;
        reference: string | null;
      };
      assert.equal(
        Date.parse(employerAcknowledgement.receivedAt),
        Date.parse('2026-10-21T10:00:00.000Z'),
      );
      assert.equal(employerAcknowledgement.source, 'Employer confirmation email');
      assert.equal(employerAcknowledgement.reference, 'synthetic-ref-1');
      const candidateOnlyClaim = await app.inject({
        url: `/api/leads/${candidateOnlyApplicationId}`,
        headers: { cookie },
      });
      assert.equal(candidateOnlyClaim.statusCode, 200, candidateOnlyClaim.body);
      assert.equal(candidateOnlyClaim.json().applicationEvidence.confirmation, 'received');
      assert.equal(candidateOnlyClaim.json().employerAcknowledgement, null);
      const foreignLead = await app.inject({
        url: `/api/leads/${applicationId}`,
        headers: { cookie: otherCookie },
      });
      assert.equal(foreignLead.statusCode, 404);

      const exported = await app.inject({
        url: '/api/applications/export',
        headers: { cookie },
      });
      assert.equal(exported.statusCode, 200, exported.body);
      assert.match(exported.headers['content-type'] ?? '', /^text\/csv; charset=utf-8/i);
      assert.equal(exported.headers['cache-control'], 'private, no-store');
      assert.match(
        exported.headers['content-disposition'] ?? '',
        /^attachment; filename="careerscope-applications\.csv"$/,
      );
      assert.match(exported.body, /"Candidate Role","Synthetic Company"/);
      assert.match(exported.body, /"Candidate-reported applied at \(UTC\)"/);
      assert.match(exported.body, /"Employer website","received","medium","Candidate entry"/);
      assert.match(exported.body, /"Candidate-owned note"/);
      assert.doesNotMatch(
        exported.body,
        /Foreign-owner secret|Foreign Secret Role|Saved Only Role|Must never appear|applicationId|ownerId/,
      );

      const docs = await app.inject({ url: '/api/docs/json', headers: { cookie } });
      assert.equal(docs.statusCode, 200);
      assert.deepEqual(
        docs.json().paths['/api/applications/export']?.get?.responses?.['200']?.content,
        { 'text/csv': { schema: { type: 'string' } } },
      );
    } finally {
      await app?.close();
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.close();
    }
  },
);
