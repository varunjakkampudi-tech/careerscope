import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Auth, Database, refreshCookie, sessionCookie } from '@careerscope/core';
import { createApp } from './app.js';

test(
  'moderator review is admin-only, privacy-minimized, paged, and audited; changed candidate reasons return to pending',
  { timeout: 60_000 },
  async () => {
    const configuredDatabase = process.env.DATABASE_URL;
    assert.ok(configuredDatabase, 'integration test requires an isolated DATABASE_URL');
    const databaseUrl = new URL(configuredDatabase);
    assert.ok(['127.0.0.1', 'localhost'].includes(databaseUrl.hostname));
    const adminDatabase = new Database(configuredDatabase);
    const name = `test_${randomUUID().replaceAll('-', '')}`;
    await adminDatabase.pool.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
    databaseUrl.pathname = `/${name}`;
    const database = new Database(databaseUrl.href);
    const origin = 'https://careerscope.test';
    let app: FastifyInstance | undefined;

    try {
      await migrate(database.db, {
        migrationsFolder: fileURLToPath(new URL('../../../migrations', import.meta.url)),
      });
      const candidateId = randomUUID();
      const moderatorId = randomUUID();
      await database.pool.query(`INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)`, [
        candidateId,
        `${candidateId}@example.test`,
        moderatorId,
        `${moderatorId}@example.test`,
      ]);
      await database.pool.query(
        "UPDATE users SET totp_enabled_at = now(), role = 'admin' WHERE id = $1",
        [moderatorId],
      );
      const search = await database.createSearch(candidateId, 'moderator-report-fixture', {
        query: 'React engineer',
        sources: ['remoteok'],
      });
      const jobId = randomUUID();
      await database.pool.query(
        `INSERT INTO search_jobs (id, owner_id, run_id, fingerprint, data)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          jobId,
          candidateId,
          search.id,
          'moderator-report-fixture',
          JSON.stringify({
            title: 'React Engineer',
            company: 'Synthetic Company',
            location: 'Remote',
            source: 'remoteok',
            sourceUrl: 'https://remoteok.com/remote-jobs/moderator-fixture',
          }),
        ],
      );
      const additionalJobIds = [randomUUID(), randomUUID()];
      for (let index = 0; index < additionalJobIds.length; index += 1) {
        const additionalJobId = additionalJobIds[index]!;
        await database.pool.query(
          `INSERT INTO search_jobs (id, owner_id, run_id, fingerprint, data)
           VALUES ($1, $2, $3, $4, $5::jsonb)`,
          [
            additionalJobId,
            candidateId,
            search.id,
            `moderator-report-fixture-${index + 2}`,
            JSON.stringify({
              title: `React Engineer ${index + 2}`,
              company: 'Synthetic Company',
              location: 'Remote',
              source: 'remoteok',
              sourceUrl: `https://remoteok.com/remote-jobs/moderator-fixture-${index + 2}`,
            }),
          ],
        );
      }

      const auth = new Auth(database);
      const candidateCredentials = await auth.loginWithVerifiedEmail(`${candidateId}@example.test`);
      const moderatorCredentials = await auth.loginWithVerifiedEmail(`${moderatorId}@example.test`);
      assert.ok(candidateCredentials);
      assert.ok(moderatorCredentials);
      const candidateSession = await auth.session(candidateCredentials.accessToken);
      const moderatorSession = await auth.session(moderatorCredentials.accessToken);
      assert.ok(candidateSession);
      assert.ok(moderatorSession);
      const cookieFor = (credentials: NonNullable<typeof candidateCredentials>) =>
        `${sessionCookie}=${credentials.accessToken}; ${refreshCookie}=${credentials.refreshToken}`;
      const candidateCookie = cookieFor(candidateCredentials);
      const moderatorCookie = cookieFor(moderatorCredentials);
      const moderatorHeaders = {
        origin,
        cookie: moderatorCookie,
        'x-csrf-token': moderatorSession.csrf,
      };
      app = await createApp(database, origin, async () => true, {
        testAccess: { mode: 'disabled' },
      });

      const candidateFeedback = await app.inject({
        method: 'PUT',
        url: `/api/search-jobs/${jobId}/feedback`,
        headers: {
          origin,
          cookie: candidateCookie,
          'x-csrf-token': candidateSession.csrf,
        },
        payload: { reason: 'suspicious' },
      });
      assert.equal(candidateFeedback.statusCode, 200, candidateFeedback.body);
      for (let index = 0; index < additionalJobIds.length; index += 1) {
        const additionalJobId = additionalJobIds[index]!;
        const feedbackSubmission: { statusCode: number; body: string } = await app.inject({
          method: 'PUT',
          url: `/api/search-jobs/${additionalJobId}/feedback`,
          headers: {
            origin,
            cookie: candidateCookie,
            'x-csrf-token': candidateSession.csrf,
          },
          payload: { reason: index === 0 ? 'incorrect' : 'unavailable' },
        });
        assert.equal(feedbackSubmission.statusCode, 200, feedbackSubmission.body);
      }
      await database.pool.query(
        `UPDATE job_feedback SET created_at = '2026-01-02T00:00:00Z'
         WHERE owner_id = $1`,
        [candidateId],
      );

      const denied = await app.inject({
        url: '/api/admin/job-feedback',
        headers: { cookie: candidateCookie },
      });
      assert.equal(denied.statusCode, 403);
      const queue = await app.inject({
        url: '/api/admin/job-feedback?limit=50',
        headers: { cookie: moderatorCookie },
      });
      assert.equal(queue.statusCode, 200, queue.body);
      assert.equal(queue.json().items.length, 3);
      const report = queue
        .json()
        .items.find((item: Record<string, unknown>) => item.jobId === jobId) as
        Record<string, unknown> | undefined;
      assert.ok(report);
      assert.equal(report.reason, 'suspicious');
      assert.equal(report.title, 'React Engineer');
      assert.equal(report.company, 'Synthetic Company');
      assert.equal('ownerId' in report, false);
      assert.equal('email' in report, false);
      assert.equal('candidateEmail' in report, false);

      const firstPage = await app.inject({
        url: '/api/admin/job-feedback?limit=1',
        headers: { cookie: moderatorCookie },
      });
      assert.equal(firstPage.json().items.length, 1);
      const firstPageId = firstPage.json().items[0].reportId as string;
      const secondPage = await app.inject({
        url: `/api/admin/job-feedback?limit=1&before=${firstPageId}`,
        headers: { cookie: moderatorCookie },
      });
      assert.equal(secondPage.statusCode, 200, secondPage.body);
      assert.equal(secondPage.json().items.length, 1);
      const secondPageId = secondPage.json().items[0].reportId as string;
      assert.notEqual(secondPageId, firstPageId);
      const thirdPage = await app.inject({
        url: `/api/admin/job-feedback?limit=1&before=${secondPageId}`,
        headers: { cookie: moderatorCookie },
      });
      assert.equal(thirdPage.statusCode, 200, thirdPage.body);
      assert.equal(thirdPage.json().items.length, 1);
      assert.notEqual(thirdPage.json().items[0].reportId, firstPageId);
      assert.notEqual(thirdPage.json().items[0].reportId, secondPageId);
      assert.equal(
        (
          await app.inject({
            url: `/api/admin/job-feedback?status=confirmed&before=${firstPageId}`,
            headers: { cookie: moderatorCookie },
          })
        ).statusCode,
        400,
        'a cursor from another status cannot change the result page boundary',
      );
      assert.equal(
        (
          await app.inject({
            url: `/api/admin/job-feedback?before=${randomUUID()}`,
            headers: { cookie: moderatorCookie },
          })
        ).statusCode,
        400,
        'unknown cursor ids are rejected',
      );

      const missingCsrf = await app.inject({
        method: 'PUT',
        url: `/api/admin/job-feedback/${report.reportId}/review`,
        headers: { origin, cookie: moderatorCookie },
        payload: {
          status: 'confirmed',
          expectedRevision: report.revision as number,
          expectedReviewRevision: null,
        },
      });
      assert.equal(missingCsrf.statusCode, 403);
      const invalidCsrf = await app.inject({
        method: 'PUT',
        url: `/api/admin/job-feedback/${report.reportId}/review`,
        headers: { origin, cookie: moderatorCookie, 'x-csrf-token': 'invalid' },
        payload: {
          status: 'confirmed',
          expectedRevision: report.revision as number,
          expectedReviewRevision: null,
        },
      });
      assert.equal(invalidCsrf.statusCode, 403);

      const firstDecision = await app.inject({
        method: 'PUT',
        url: `/api/admin/job-feedback/${report.reportId}/review`,
        headers: moderatorHeaders,
        payload: {
          status: 'confirmed',
          note: 'Source listing does not match the employer domain.',
          expectedRevision: report.revision as number,
          expectedReviewRevision: null,
        },
      });
      assert.equal(firstDecision.statusCode, 200, firstDecision.body);
      assert.deepEqual(firstDecision.json(), { reportId: report.reportId, status: 'confirmed' });
      const confirmed = await app.inject({
        url: '/api/admin/job-feedback?status=confirmed',
        headers: { cookie: moderatorCookie },
      });
      assert.equal(confirmed.json().items.length, 1);
      assert.equal(confirmed.json().items[0].reviewStatus, 'confirmed');
      assert.equal(
        confirmed.json().items[0].reviewNote,
        'Source listing does not match the employer domain.',
      );

      const secondDecision = await app.inject({
        method: 'PUT',
        url: `/api/admin/job-feedback/${report.reportId}/review`,
        headers: moderatorHeaders,
        payload: {
          status: 'dismissed',
          expectedRevision: report.revision as number,
          expectedReviewRevision: confirmed.json().items[0].reviewRevision as number,
        },
      });
      assert.equal(secondDecision.statusCode, 200, secondDecision.body);
      assert.equal(
        (
          await database.pool.query(
            'SELECT status FROM job_feedback_review_events WHERE feedback_id = $1 ORDER BY created_at',
            [report.reportId],
          )
        ).rowCount,
        2,
        'review decisions are append-only even when the current disposition changes',
      );

      const changedReason = await app.inject({
        method: 'PUT',
        url: `/api/search-jobs/${jobId}/feedback`,
        headers: {
          origin,
          cookie: candidateCookie,
          'x-csrf-token': candidateSession.csrf,
        },
        payload: { reason: 'incorrect' },
      });
      assert.equal(changedReason.statusCode, 200, changedReason.body);
      const pendingAgain = await app.inject({
        url: '/api/admin/job-feedback',
        headers: { cookie: moderatorCookie },
      });
      assert.equal(pendingAgain.json().items.length, 3);
      const refreshed = pendingAgain
        .json()
        .items.find((item: Record<string, unknown>) => item.reportId === report.reportId) as
        Record<string, unknown> | undefined;
      assert.ok(refreshed);
      assert.equal(refreshed.reason, 'incorrect');
      assert.equal(refreshed.reviewStatus, null);
      const changedCursorPage = await app.inject({
        url: `/api/admin/job-feedback?status=confirmed&before=${report.reportId}`,
        headers: { cookie: moderatorCookie },
      });
      assert.equal(changedCursorPage.statusCode, 400);
      assert.equal(
        (
          await app.inject({
            url: `/api/admin/job-feedback?status=pending&before=${report.reportId}`,
            headers: { cookie: moderatorCookie },
          })
        ).statusCode,
        200,
        'a cursor whose report status changed to pending is usable only for pending results',
      );

      const [concurrentCandidateUpdate, concurrentModeratorReview] = await Promise.all([
        app.inject({
          method: 'PUT',
          url: `/api/search-jobs/${jobId}/feedback`,
          headers: {
            origin,
            cookie: candidateCookie,
            'x-csrf-token': candidateSession.csrf,
          },
          payload: { reason: 'unavailable' },
        }),
        app.inject({
          method: 'PUT',
          url: `/api/admin/job-feedback/${report.reportId}/review`,
          headers: moderatorHeaders,
          payload: {
            status: 'confirmed',
            expectedRevision: refreshed.revision as number,
            expectedReviewRevision: refreshed.reviewRevision as number | null,
          },
        }),
      ]);
      assert.equal(concurrentCandidateUpdate.statusCode, 200, concurrentCandidateUpdate.body);
      assert.ok([200, 409].includes(concurrentModeratorReview.statusCode));
      const afterConcurrentRace = await app.inject({
        url: '/api/admin/job-feedback',
        headers: { cookie: moderatorCookie },
      });
      const racedReport = afterConcurrentRace
        .json()
        .items.find((item: Record<string, unknown>) => item.reportId === report.reportId);
      assert.equal(racedReport.reason, 'unavailable');
      assert.equal(
        racedReport.reviewStatus,
        null,
        'a disposition for a superseded reason can never remain current',
      );
      const staleRevisionReview = await app.inject({
        method: 'PUT',
        url: `/api/admin/job-feedback/${report.reportId}/review`,
        headers: moderatorHeaders,
        payload: {
          status: 'confirmed',
          expectedRevision: refreshed.revision as number,
          expectedReviewRevision: refreshed.reviewRevision as number | null,
        },
      });
      assert.equal(staleRevisionReview.statusCode, 409, staleRevisionReview.body);

      const [moderatorDecisionA, moderatorDecisionB] = await Promise.all([
        app.inject({
          method: 'PUT',
          url: `/api/admin/job-feedback/${report.reportId}/review`,
          headers: moderatorHeaders,
          payload: {
            status: 'confirmed',
            expectedRevision: racedReport.revision as number,
            expectedReviewRevision: racedReport.reviewRevision as number | null,
          },
        }),
        app.inject({
          method: 'PUT',
          url: `/api/admin/job-feedback/${report.reportId}/review`,
          headers: moderatorHeaders,
          payload: {
            status: 'dismissed',
            expectedRevision: racedReport.revision as number,
            expectedReviewRevision: racedReport.reviewRevision as number | null,
          },
        }),
      ]);
      assert.deepEqual(
        [moderatorDecisionA.statusCode, moderatorDecisionB.statusCode].sort(),
        [200, 409],
        'only one moderator decision based on the same disposition revision can succeed',
      );
      const moderatorRaceState = await database.pool.query<{
        revision: number;
        status: string;
      }>('SELECT revision, status FROM job_feedback_reviews WHERE feedback_id = $1', [
        report.reportId,
      ]);
      assert.equal(moderatorRaceState.rows[0]!.revision, 1);
      assert.ok(['confirmed', 'dismissed'].includes(moderatorRaceState.rows[0]!.status));
      assert.equal(
        (
          await database.pool.query(
            'SELECT id FROM job_feedback_review_events WHERE feedback_id = $1',
            [report.reportId],
          )
        ).rowCount,
        3,
        'the stale competing moderator decision is not appended',
      );

      const docs = await app.inject({
        url: '/api/docs/json',
        headers: { cookie: moderatorCookie },
      });
      assert.equal(docs.statusCode, 200);
      assert.ok(docs.json().paths['/api/admin/job-feedback']?.get);
      assert.ok(docs.json().paths['/api/admin/job-feedback/{id}/review']?.put);
      const candidateCanNotReview = await app.inject({
        method: 'PUT',
        url: `/api/admin/job-feedback/${report.reportId}/review`,
        headers: {
          origin,
          cookie: candidateCookie,
          'x-csrf-token': candidateSession.csrf,
        },
        payload: { status: 'dismissed' },
      });
      assert.equal(candidateCanNotReview.statusCode, 403);
      await database.pool.query("UPDATE users SET role = 'candidate' WHERE id = $1", [moderatorId]);
      const revokedModeratorRead = await app.inject({
        url: '/api/admin/job-feedback',
        headers: { cookie: moderatorCookie },
      });
      assert.equal(revokedModeratorRead.statusCode, 403);
      const revokedModeratorReview = await app.inject({
        method: 'PUT',
        url: `/api/admin/job-feedback/${report.reportId}/review`,
        headers: moderatorHeaders,
        payload: {
          status: 'dismissed',
          expectedRevision: racedReport.revision as number,
          expectedReviewRevision: moderatorRaceState.rows[0]!.revision,
        },
      });
      assert.equal(revokedModeratorReview.statusCode, 403);
    } finally {
      await app?.close();
      await database.close();
      await adminDatabase.pool.query(`DROP DATABASE "${name}"`);
      await adminDatabase.close();
    }
  },
);
