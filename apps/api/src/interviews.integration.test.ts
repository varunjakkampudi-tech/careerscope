import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import {
  Auth,
  Database,
  refreshCookie,
  ResumeUploadRepository,
  sessionCookie,
  InAppNotificationRepository,
  ProfileRepository,
  publishDueInterviewReminders,
} from '@careerscope/core';
import { createApp } from './app.js';

test(
  'interview rounds are candidate-owned, revision guarded, and do not imply an application event',
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
      const ownLeadId = randomUUID();
      const foreignLeadId = randomUUID();
      await database.pool.query('INSERT INTO users (id, email) VALUES ($1, $2), ($3, $4)', [
        ownerId,
        `${ownerId}@example.test`,
        otherOwnerId,
        `${otherOwnerId}@example.test`,
      ]);
      await database.pool.query(
        `INSERT INTO saved_leads (id, owner_id, fingerprint, data, status)
         VALUES ($1, $2, $3, '{}'::jsonb, 'saved'), ($4, $5, $6, '{}'::jsonb, 'saved')`,
        [
          ownLeadId,
          ownerId,
          `own-${ownLeadId}`,
          foreignLeadId,
          otherOwnerId,
          `foreign-${foreignLeadId}`,
        ],
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
      let deletedObjects = 0;
      app = await createApp(database, origin, async () => true, {
        testAccess: { mode: 'disabled' },
        resumeStorage: {
          bucket: 'careerscope-private',
          initialize: async () => {},
          put: async () => 'synthetic-version',
          get: async () => Buffer.alloc(0),
          recoverVersion: async () => null,
          delete: async () => {
            deletedObjects += 1;
          },
        },
      });

      await new ProfileRepository(database).save(ownerId, {
        revision: 0,
        profile: {
          candidate: {
            fullName: 'Synthetic Owner Profile',
            email: `${ownerId}@example.test`,
            location: 'Hyderabad',
          },
          preferences: { titles: ['Synthetic Role'], techStack: ['TypeScript'] },
          application: { yearsOfExperience: 2 },
          accessibility: { reducedMotion: true },
        },
      });
      const foreignProfile = await app.inject({
        url: '/api/profile',
        headers: { cookie: otherCookie },
      });
      assert.equal(foreignProfile.statusCode, 200);
      assert.equal(foreignProfile.json().profile, null);
      assert.doesNotMatch(foreignProfile.body, /Synthetic Owner Profile|Synthetic Role/);
      const ownedAccessibility = await app.inject({
        url: '/api/profile/accessibility',
        headers: { cookie },
      });
      assert.equal(ownedAccessibility.statusCode, 200);
      assert.deepEqual(ownedAccessibility.json(), { reducedMotion: true });
      const foreignAccessibility = await app.inject({
        url: '/api/profile/accessibility',
        headers: { cookie: otherCookie },
      });
      assert.equal(foreignAccessibility.statusCode, 200);
      assert.deepEqual(foreignAccessibility.json(), { reducedMotion: false });
      assert.doesNotMatch(foreignAccessibility.body, /Synthetic Owner Profile|Synthetic Role/);
      assert.equal((await app.inject({ url: '/api/profile/accessibility' })).statusCode, 401);

      const foreignLeadRead = await app.inject({
        url: `/api/leads/${ownLeadId}`,
        headers: { cookie: otherCookie },
      });
      assert.equal(foreignLeadRead.statusCode, 404);
      const foreignLeadHistory = await app.inject({
        url: `/api/leads/${ownLeadId}/history`,
        headers: { cookie: otherCookie },
      });
      assert.equal(foreignLeadHistory.statusCode, 404);

      const uploadId = randomUUID();
      const parseCommandId = randomUUID();
      await database.pool.query('INSERT INTO outbox_events (id, command) VALUES ($1, $2::jsonb)', [
        parseCommandId,
        JSON.stringify({ id: parseCommandId, type: 'resume.parse', version: 1 }),
      ]);
      await database.pool.query(
        `INSERT INTO resume_uploads
          (id, owner_id, idempotency_key, bucket, sha256, bytes, content_type,
           object_version, command_id, status)
         VALUES ($1, $2, 'interviewdoc1', 'careerscope-private', $3, 64,
           'application/pdf', 'synthetic-version', $4, 'queued')`,
        [uploadId, ownerId, 'a'.repeat(64), parseCommandId],
      );
      await database.pool.query(
        `INSERT INTO resume_results (upload_id, owner_id, command_id, status, parsed)
         VALUES ($1, $2, $3, 'parsed', '{}'::jsonb)`,
        [uploadId, ownerId, parseCommandId],
      );

      const input = {
        title: 'Technical interview',
        startsAt: '2030-05-10T15:00:00.000Z',
        timeZone: 'Asia/Kolkata',
        format: 'video',
        status: 'scheduled',
        contacts: [{ name: 'Synthetic interviewer', role: 'Engineering', email: null }],
        checklist: [{ id: randomUUID(), label: 'Review system design notes', completed: false }],
        notes: 'Synthetic preparation note',
        reminderAt: '2030-05-10T14:00:00.000Z',
        resumeUploadIds: [uploadId],
      };
      const unauthenticated = await app.inject({ url: `/api/leads/${ownLeadId}/interviews` });
      assert.equal(unauthenticated.statusCode, 401);

      const foreignResumeRead = await app.inject({
        url: `/api/resumes/${uploadId}`,
        headers: { cookie: otherCookie },
      });
      assert.equal(foreignResumeRead.statusCode, 404);
      assert.doesNotMatch(foreignResumeRead.body, /Synthetic Owner Profile|resume_results|parsed/);
      const foreignResumeList = await app.inject({
        url: '/api/resumes',
        headers: { cookie: otherCookie },
      });
      assert.equal(foreignResumeList.statusCode, 200);
      assert.deepEqual(foreignResumeList.json().items, []);
      const foreignResumeDelete = await app.inject({
        method: 'DELETE',
        url: `/api/resumes/${uploadId}`,
        headers: { origin, cookie: otherCookie, 'x-csrf-token': otherSession.csrf },
      });
      assert.equal(foreignResumeDelete.statusCode, 204);
      assert.equal(deletedObjects, 0, 'foreign-owner deletion must never call storage');
      assert.equal(
        (
          await database.pool.query(
            'SELECT id FROM resume_uploads WHERE owner_id = $1 AND id = $2',
            [ownerId, uploadId],
          )
        ).rowCount,
        1,
        'a foreign-owner request must leave the owner upload untouched',
      );

      const create = await app.inject({
        method: 'POST',
        url: `/api/leads/${ownLeadId}/interviews`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: input,
      });
      assert.equal(create.statusCode, 200, create.body);
      const round = create.json();
      assert.equal(round.leadId, ownLeadId);
      assert.equal(round.revision, 1);
      assert.equal(Object.hasOwn(round, 'ownerId'), false);
      assert.deepEqual(round.resumeUploadIds, [uploadId]);

      const ownList = await app.inject({
        url: `/api/leads/${ownLeadId}/interviews`,
        headers: { cookie },
      });
      assert.equal(ownList.statusCode, 200);
      assert.equal(ownList.json().items.length, 1);
      assert.equal(ownList.json().items[0].title, input.title);

      const foreignRead = await app.inject({
        url: `/api/leads/${ownLeadId}/interviews`,
        headers: { cookie: otherCookie },
      });
      assert.equal(foreignRead.statusCode, 404);
      const foreignWrite = await app.inject({
        method: 'POST',
        url: `/api/leads/${foreignLeadId}/interviews`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: input,
      });
      assert.equal(foreignWrite.statusCode, 404);

      const invalidReminder = await app.inject({
        method: 'POST',
        url: `/api/leads/${ownLeadId}/interviews`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: { ...input, reminderAt: input.startsAt },
      });
      assert.equal(invalidReminder.statusCode, 400);

      const csrfRejected = await app.inject({
        method: 'POST',
        url: `/api/leads/${ownLeadId}/interviews`,
        headers: { origin, cookie },
        payload: input,
      });
      assert.equal(csrfRejected.statusCode, 403);

      const updateInput = {
        ...input,
        status: 'completed',
        revision: round.revision,
      };
      const update = await app.inject({
        method: 'PUT',
        url: `/api/interviews/${round.id}`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: updateInput,
      });
      assert.equal(update.statusCode, 200, update.body);
      assert.equal(update.json().status, 'completed');
      assert.equal(update.json().revision, 2);

      const staleUpdate = await app.inject({
        method: 'PUT',
        url: `/api/interviews/${round.id}`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: updateInput,
      });
      assert.equal(staleUpdate.statusCode, 409);
      assert.equal(staleUpdate.json().code, 'INTERVIEW_REVISION_CONFLICT');
      assert.equal(staleUpdate.json().message, 'Interview round changed; reload before saving');

      const lead = await database.pool.query<{ status: string }>(
        'SELECT status FROM saved_leads WHERE owner_id = $1 AND id = $2',
        [ownerId, ownLeadId],
      );
      assert.equal(
        lead.rows[0]?.status,
        'saved',
        'a scheduled/completed round is not an application event',
      );

      const now = Date.now();
      const dueInput = {
        ...input,
        startsAt: new Date(now + 2 * 60 * 60_000).toISOString(),
        reminderAt: new Date(now - 60_000).toISOString(),
        resumeUploadIds: [],
        contacts: [],
      };
      const dueRounds = await Promise.all(
        ['Due interview A', 'Due interview B'].map(async (title) => {
          const response = await app!.inject({
            method: 'POST',
            url: `/api/leads/${ownLeadId}/interviews`,
            headers: { origin, cookie, 'x-csrf-token': session.csrf },
            payload: { ...dueInput, title },
          });
          assert.equal(response.statusCode, 200, response.body);
          return response.json() as { id: string };
        }),
      );
      const expiredRoundResponse = await app.inject({
        method: 'POST',
        url: `/api/leads/${ownLeadId}/interviews`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: {
          ...dueInput,
          title: 'Interview that has already started',
          startsAt: new Date(now - 60 * 60_000).toISOString(),
          reminderAt: new Date(now - 2 * 60 * 60_000).toISOString(),
        },
      });
      assert.equal(expiredRoundResponse.statusCode, 200, expiredRoundResponse.body);
      const expiredRound = expiredRoundResponse.json() as { id: string };
      const publishCounts = await Promise.all([
        publishDueInterviewReminders(database),
        publishDueInterviewReminders(database),
      ]);
      assert.equal(
        publishCounts.reduce((sum, count) => sum + count, 0),
        2,
      );
      assert.equal(await publishDueInterviewReminders(database), 0);
      const notificationRepository = new InAppNotificationRepository(database);
      const ownerNotifications = await notificationRepository.list(ownerId);
      assert.equal(ownerNotifications.items.length, 2);
      assert.equal(ownerNotifications.unreadCount, 2);
      assert.ok(ownerNotifications.items.every((item) => item.leadId === ownLeadId));
      assert.equal(Object.hasOwn(ownerNotifications.items[0]!, 'title'), false);
      assert.equal(Object.hasOwn(ownerNotifications.items[0]!, 'notes'), false);

      const notificationRead = await app.inject({
        url: '/api/notifications',
        headers: { cookie },
      });
      assert.equal(notificationRead.statusCode, 200);
      assert.equal(notificationRead.json().items.length, 2);
      assert.equal(notificationRead.json().unreadCount, 2);
      const foreignNotifications = await app.inject({
        url: '/api/notifications',
        headers: { cookie: otherCookie },
      });
      assert.equal(foreignNotifications.statusCode, 200);
      assert.equal(foreignNotifications.json().items.length, 0);
      assert.equal(foreignNotifications.json().unreadCount, 0);
      const unauthenticatedNotifications = await app.inject({ url: '/api/notifications' });
      assert.equal(unauthenticatedNotifications.statusCode, 401);

      const notificationToRead = ownerNotifications.items[0]!;
      const foreignNotificationRead = await app.inject({
        method: 'PUT',
        url: `/api/notifications/${notificationToRead.id}/read`,
        headers: { origin, cookie: otherCookie, 'x-csrf-token': otherSession.csrf },
      });
      assert.equal(foreignNotificationRead.statusCode, 404);
      const read = await app.inject({
        method: 'PUT',
        url: `/api/notifications/${notificationToRead.id}/read`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
      });
      assert.equal(read.statusCode, 204);
      const readAgain = await app.inject({
        method: 'PUT',
        url: `/api/notifications/${notificationToRead.id}/read`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
      });
      assert.equal(readAgain.statusCode, 204);

      const movedReminderRound = dueRounds[1]!;
      const movedReminder = {
        ...dueInput,
        startsAt: new Date(now + 4 * 60 * 60_000).toISOString(),
        reminderAt: new Date(now + 3 * 60 * 60_000).toISOString(),
        revision: 1,
      };
      const reschedule = await app.inject({
        method: 'PUT',
        url: `/api/interviews/${movedReminderRound.id}`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: movedReminder,
      });
      assert.equal(reschedule.statusCode, 200, reschedule.body);
      assert.equal(
        (await notificationRepository.list(ownerId)).items.length,
        1,
        'a changed reminder schedule retires the obsolete notification',
      );
      assert.equal(
        await database.pool
          .query('SELECT retired_at FROM in_app_notifications WHERE round_id = $1', [
            movedReminderRound.id,
          ])
          .then((result) => result.rows.length === 1 && result.rows[0]?.retired_at !== null),
        true,
      );
      const staleNotificationRead = await app.inject({
        method: 'PUT',
        url: `/api/notifications/${ownerNotifications.items.find((item) => item.roundId === movedReminderRound.id)!.id}/read`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
      });
      assert.equal(staleNotificationRead.statusCode, 404);

      const startedRoundUpdate = await app.inject({
        method: 'PUT',
        url: `/api/interviews/${dueRounds[0]!.id}`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: {
          ...dueInput,
          startsAt: new Date(now - 30_000).toISOString(),
          revision: 1,
        },
      });
      assert.equal(startedRoundUpdate.statusCode, 200, startedRoundUpdate.body);
      assert.equal(
        (await notificationRepository.list(ownerId)).items.length,
        0,
        'an interview that has started retires its stale reminder',
      );
      const startedRoundNotification = ownerNotifications.items.find(
        (item) => item.roundId === dueRounds[0]!.id,
      )!;
      assert.equal(
        await notificationRepository.markRead(ownerId, startedRoundNotification.id),
        false,
      );
      assert.equal(
        await database.pool
          .query('SELECT id FROM in_app_notifications WHERE round_id = $1', [expiredRound.id])
          .then((result) => result.rowCount),
        0,
        'a scheduled round whose start time has passed does not create a late reminder',
      );

      const elapsedRoundResponse = await app.inject({
        method: 'POST',
        url: `/api/leads/${ownLeadId}/interviews`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: { ...dueInput, title: 'Naturally elapsed interview' },
      });
      assert.equal(elapsedRoundResponse.statusCode, 200, elapsedRoundResponse.body);
      const elapsedRound = elapsedRoundResponse.json() as { id: string };
      assert.equal(await publishDueInterviewReminders(database), 1);
      await database.pool.query(
        `UPDATE interview_rounds SET starts_at = now() - interval '1 minute'
         WHERE owner_id = $1 AND id = $2`,
        [ownerId, elapsedRound.id],
      );
      await publishDueInterviewReminders(database);
      const retiredElapsedReminder = await database.pool.query(
        'SELECT retired_at FROM in_app_notifications WHERE owner_id = $1 AND round_id = $2',
        [ownerId, elapsedRound.id],
      );
      assert.equal(retiredElapsedReminder.rows.length, 1);
      assert.ok(retiredElapsedReminder.rows[0]?.retired_at);
      await database.pool.query(
        `UPDATE interview_rounds SET starts_at = now() + interval '1 hour'
         WHERE owner_id = $1 AND id = $2`,
        [ownerId, elapsedRound.id],
      );
      assert.equal(await publishDueInterviewReminders(database), 0);
      assert.equal(
        (await notificationRepository.list(ownerId)).items.some(
          (item) => item.roundId === elapsedRound.id,
        ),
        false,
        'a retired reminder does not resurface when its round is moved back into the future',
      );

      const precisionRoundResponse = await app.inject({
        method: 'POST',
        url: `/api/leads/${ownLeadId}/interviews`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: {
          ...dueInput,
          title: 'Timestamp precision interview',
          startsAt: '2030-05-10T15:00:00.000Z',
          reminderAt: '2030-05-10T14:00:00.123456Z',
        },
      });
      assert.equal(precisionRoundResponse.statusCode, 200, precisionRoundResponse.body);
      const precisionRound = precisionRoundResponse.json() as { id: string; revision: number };
      await database.pool.query(
        `INSERT INTO in_app_notifications (id, owner_id, round_id, reminder_at)
         SELECT $1, owner_id, id, reminder_at FROM interview_rounds
         WHERE owner_id = $2 AND id = $3`,
        [randomUUID(), ownerId, precisionRound.id],
      );
      const preciseReminderUpdate = await app.inject({
        method: 'PUT',
        url: `/api/interviews/${precisionRound.id}`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: {
          ...dueInput,
          title: 'Timestamp precision interview',
          startsAt: '2030-05-10T15:00:00.000Z',
          reminderAt: '2030-05-10T14:00:00.123Z',
          revision: precisionRound.revision,
        },
      });
      assert.equal(preciseReminderUpdate.statusCode, 200, preciseReminderUpdate.body);
      const precisionRetirement = await database.pool.query(
        'SELECT retired_at FROM in_app_notifications WHERE owner_id = $1 AND round_id = $2',
        [ownerId, precisionRound.id],
      );
      assert.ok(
        precisionRetirement.rows[0]?.retired_at,
        'the database detects a microsecond-level reminder change even when JavaScript Dates compare equal',
      );

      const overflowRoundIds = Array.from({ length: 51 }, () => randomUUID());
      await database.pool.query(
        `INSERT INTO interview_rounds
          (id, owner_id, lead_id, title, starts_at, time_zone, format, status,
           contacts, checklist, notes, reminder_at)
         SELECT id, $2, $3, 'Upcoming interview', now() + interval '1 hour', 'UTC',
                'video', 'scheduled', '[]'::jsonb, '[]'::jsonb, '', now() - interval '1 minute'
         FROM unnest($1::uuid[]) AS id`,
        [overflowRoundIds, ownerId, ownLeadId],
      );
      assert.equal(await publishDueInterviewReminders(database), 51);
      const persistedNotificationCounts = await database.pool.query<{
        total: string;
        scheduledRounds: string;
        visiblePairs: string;
      }>(
        `SELECT
           (SELECT count(*) FROM in_app_notifications
            WHERE owner_id = $1 AND retired_at IS NULL) AS total,
           count(*) FILTER (
             WHERE notification.retired_at IS NULL
               AND round.status = 'scheduled' AND round.starts_at > now()
           ) AS "scheduledRounds",
           count(*) FILTER (
             WHERE notification.retired_at IS NULL
               AND round.status = 'scheduled' AND round.starts_at > now()
               AND round.reminder_at = notification.reminder_at
           ) AS "visiblePairs"
         FROM in_app_notifications notification
         JOIN interview_rounds round
           ON round.owner_id = notification.owner_id AND round.id = notification.round_id
         WHERE notification.owner_id = $1`,
        [ownerId],
      );
      assert.equal(Number(persistedNotificationCounts.rows[0]?.total), 51);
      assert.equal(Number(persistedNotificationCounts.rows[0]?.scheduledRounds), 51);
      assert.equal(Number(persistedNotificationCounts.rows[0]?.visiblePairs), 51);
      const overflowOwnerList = await notificationRepository.list(ownerId);
      assert.equal(overflowOwnerList.items.length, 50);
      assert.equal(overflowOwnerList.unreadCount, 51);
      const overflowNotifications = await app.inject({
        url: '/api/notifications',
        headers: { cookie },
      });
      assert.equal(overflowNotifications.statusCode, 200);
      assert.equal(overflowNotifications.json().items.length, 50);
      assert.equal(overflowNotifications.json().unreadCount, 51);

      const completedReminderUpdate = await app.inject({
        method: 'PUT',
        url: `/api/interviews/${overflowRoundIds[0]}`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: { ...dueInput, status: 'completed', revision: 1 },
      });
      assert.equal(completedReminderUpdate.statusCode, 200, completedReminderUpdate.body);
      assert.equal(
        await database.pool
          .query('SELECT retired_at FROM in_app_notifications WHERE round_id = $1', [
            overflowRoundIds[0],
          ])
          .then((result) => result.rows.length === 1 && result.rows[0]?.retired_at !== null),
        true,
        'changing a round out of scheduled status retires its reminder notification',
      );
      const afterCompletion = await notificationRepository.list(ownerId);
      assert.equal(afterCompletion.unreadCount, 50);

      const defaultPreference = await app.inject({
        url: '/api/notifications/preferences',
        headers: { cookie },
      });
      assert.equal(defaultPreference.statusCode, 200);
      assert.deepEqual(defaultPreference.json(), { interviewRemindersInAppEnabled: true });
      const foreignDefaultPreference = await app.inject({
        url: '/api/notifications/preferences',
        headers: { cookie: otherCookie },
      });
      assert.equal(foreignDefaultPreference.statusCode, 200);
      assert.deepEqual(foreignDefaultPreference.json(), {
        interviewRemindersInAppEnabled: true,
      });
      assert.equal((await app.inject({ url: '/api/notifications/preferences' })).statusCode, 401);
      const missingCsrf = await app.inject({
        method: 'PUT',
        url: '/api/notifications/preferences',
        headers: { origin, cookie },
        payload: { interviewRemindersInAppEnabled: false },
      });
      assert.equal(missingCsrf.statusCode, 403);
      const malformedPreference = await app.inject({
        method: 'PUT',
        url: '/api/notifications/preferences',
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: { interviewRemindersInAppEnabled: 'false', ownerId: otherOwnerId },
      });
      assert.equal(malformedPreference.statusCode, 400);
      const otherOwnerUpdate = await app.inject({
        method: 'PUT',
        url: '/api/notifications/preferences',
        headers: { origin, cookie: otherCookie, 'x-csrf-token': otherSession.csrf },
        payload: { interviewRemindersInAppEnabled: false },
      });
      assert.equal(otherOwnerUpdate.statusCode, 200);
      assert.deepEqual(
        (await app.inject({ url: '/api/notifications/preferences', headers: { cookie } })).json(),
        { interviewRemindersInAppEnabled: true },
        "one owner cannot change another owner's preference",
      );

      const reminderCountBeforePreferenceChange = await database.pool
        .query<{ count: string }>('SELECT count(*) FROM in_app_notifications WHERE owner_id = $1', [
          ownerId,
        ])
        .then((result) => Number(result.rows[0]?.count));
      const disabledPreference = await app.inject({
        method: 'PUT',
        url: '/api/notifications/preferences',
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: { interviewRemindersInAppEnabled: false },
      });
      assert.equal(disabledPreference.statusCode, 200);
      assert.deepEqual(disabledPreference.json(), { interviewRemindersInAppEnabled: false });
      assert.equal(
        await database.pool
          .query<{ count: string }>(
            'SELECT count(*) FROM in_app_notifications WHERE owner_id = $1',
            [ownerId],
          )
          .then((result) => Number(result.rows[0]?.count)),
        reminderCountBeforePreferenceChange,
        'disabling the preference preserves already materialized notification history',
      );
      const preferenceControlledRound = await app.inject({
        method: 'POST',
        url: `/api/leads/${ownLeadId}/interviews`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: { ...dueInput, title: 'Preference-controlled upcoming interview' },
      });
      assert.equal(preferenceControlledRound.statusCode, 200, preferenceControlledRound.body);
      const preferenceControlledRoundId = (preferenceControlledRound.json() as { id: string }).id;
      assert.equal(await publishDueInterviewReminders(database), 0);
      assert.equal(
        await database.pool
          .query('SELECT id FROM in_app_notifications WHERE owner_id = $1 AND round_id = $2', [
            ownerId,
            preferenceControlledRoundId,
          ])
          .then((result) => result.rowCount),
        0,
        'disabled preferences prevent new reminder rows for upcoming rounds',
      );
      const enabledPreference = await app.inject({
        method: 'PUT',
        url: '/api/notifications/preferences',
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: { interviewRemindersInAppEnabled: true },
      });
      assert.equal(enabledPreference.statusCode, 200);
      assert.equal(await publishDueInterviewReminders(database), 1);
      assert.equal(
        await database.pool
          .query('SELECT id FROM in_app_notifications WHERE owner_id = $1 AND round_id = $2', [
            ownerId,
            preferenceControlledRoundId,
          ])
          .then((result) => result.rowCount),
        1,
        're-enabling materializes one reminder only while its interview remains upcoming',
      );

      const racingPreferenceRound = await app.inject({
        method: 'POST',
        url: `/api/leads/${ownLeadId}/interviews`,
        headers: { origin, cookie, 'x-csrf-token': session.csrf },
        payload: { ...dueInput, title: 'Preference disable serialization regression' },
      });
      assert.equal(racingPreferenceRound.statusCode, 200, racingPreferenceRound.body);
      const racingRoundId = (racingPreferenceRound.json() as { id: string }).id;
      const disablingTransaction = await database.pool.connect();
      await disablingTransaction.query('BEGIN');
      await disablingTransaction.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        ownerId,
      ]);
      let completionSequence = 0;
      let disableCompletionOrder = 0;
      let publisherCompletionOrder = 0;
      const disableRequest = app
        .inject({
          method: 'PUT',
          url: '/api/notifications/preferences',
          headers: { origin, cookie, 'x-csrf-token': session.csrf },
          payload: { interviewRemindersInAppEnabled: false },
        })
        .then((response) => {
          disableCompletionOrder = ++completionSequence;
          return response;
        });
      let publisher: Promise<number> | undefined;
      try {
        let disableWaitingForOwnerLock = false;
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline) {
          const waiting = await database.pool.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
             WHERE datname = current_database()
               AND wait_event_type = 'Lock' AND wait_event = 'advisory'
               AND query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended(%'`,
          );
          if (waiting.rowCount === 1) {
            disableWaitingForOwnerLock = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(
          disableWaitingForOwnerLock,
          true,
          'the authenticated preference update must use the owner serialization lock',
        );
        publisher = publishDueInterviewReminders(database).then((created) => {
          publisherCompletionOrder = ++completionSequence;
          return created;
        });
        const publisherDeadline = Date.now() + 5000;
        let bothOperationsWaitingForOwnerLock = false;
        while (Date.now() < publisherDeadline) {
          const waiting = await database.pool.query<{ pid: number }>(
            `SELECT pid FROM pg_stat_activity
             WHERE datname = current_database()
               AND wait_event_type = 'Lock' AND wait_event = 'advisory'
               AND query LIKE 'SELECT pg_advisory_xact_lock(hashtextextended(%'`,
          );
          if (waiting.rowCount === 2) {
            bothOperationsWaitingForOwnerLock = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.equal(
          bothOperationsWaitingForOwnerLock,
          true,
          'the publisher must serialize on the same owner lock as the authenticated preference update',
        );
      } catch (error) {
        await disablingTransaction.query('ROLLBACK');
        disablingTransaction.release();
        await disableRequest.catch(() => undefined);
        if (publisher) await publisher.catch(() => undefined);
        throw error;
      }
      try {
        await disablingTransaction.query('COMMIT');
      } finally {
        disablingTransaction.release();
      }
      assert.ok(publisher, 'the publisher race must be started before releasing the lock');
      const [disableResult, publisherResult] = await Promise.allSettled([
        disableRequest,
        publisher,
      ]);
      if (disableResult.status === 'rejected') throw disableResult.reason;
      if (publisherResult.status === 'rejected') throw publisherResult.reason;
      const disableResponse = disableResult.value;
      const publishedCount = publisherResult.value;
      assert.equal(disableResponse.statusCode, 200, disableResponse.body);
      assert.deepEqual(disableResponse.json(), { interviewRemindersInAppEnabled: false });
      const racingNotificationCount = await database.pool
        .query<{ count: string }>(
          'SELECT count(*) FROM in_app_notifications WHERE owner_id = $1 AND round_id = $2',
          [ownerId, racingRoundId],
        )
        .then((result) => Number(result.rows[0]?.count));
      assert.ok(racingNotificationCount === 0 || racingNotificationCount === 1);
      if (racingNotificationCount === 1)
        assert.ok(
          publisherCompletionOrder < disableCompletionOrder,
          'any reminder materialized by a race must commit before the preference-disable response succeeds',
        );
      assert.equal(
        await notificationRepository.interviewReminderPreference(ownerId),
        false,
        'the actual owner-scoped API writer must persist the disabled setting',
      );
      assert.ok(Number.isInteger(publishedCount));
      /*
       * The publisher may win the shared lock and create the reminder first,
       * or the preference update may win and suppress it. The contract is that
       * disable never returns ahead of an insert that is still in flight.
       */
      const docs = await app.inject({ url: '/api/docs/json', headers: { cookie } });
      assert.equal(docs.statusCode, 200);
      assert.ok(docs.json().paths['/api/profile/accessibility']?.get);
      assert.ok(docs.json().paths['/api/leads/{id}/interviews']?.get);
      assert.ok(docs.json().paths['/api/leads/{id}/interviews']?.post);
      assert.ok(docs.json().paths['/api/interviews/{id}']?.put);
      assert.ok(docs.json().paths['/api/notifications']?.get);
      assert.ok(docs.json().paths['/api/notifications/preferences']?.get);
      assert.ok(docs.json().paths['/api/notifications/preferences']?.put);
      assert.ok(docs.json().paths['/api/notifications/{id}/read']?.put);
      const listResponses = docs.json().paths['/api/leads/{id}/interviews']?.get.responses;
      assert.ok(listResponses?.['401']);
      assert.ok(listResponses?.['403']);
      const createResponses = docs.json().paths['/api/leads/{id}/interviews']?.post.responses;
      assert.ok(createResponses?.['401']);
      assert.ok(createResponses?.['403']);
      const updateResponses = docs.json().paths['/api/interviews/{id}']?.put.responses;
      assert.ok(updateResponses?.['401']);
      assert.ok(updateResponses?.['403']);

      let objectDeleted = false;
      assert.equal(
        await new ResumeUploadRepository(database).deleteSettled(ownerId, uploadId, async () => {
          objectDeleted = true;
        }),
        true,
      );
      assert.equal(objectDeleted, true);
      const afterResumeDelete = await app.inject({
        url: `/api/leads/${ownLeadId}/interviews`,
        headers: { cookie },
      });
      assert.deepEqual(afterResumeDelete.json().items[0].resumeUploadIds, []);
    } finally {
      await app?.close();
      await database.close();
      await admin.pool.query(`DROP DATABASE "${name}"`);
      await admin.close();
    }
  },
);
