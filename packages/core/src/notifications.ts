/**
 * In-app notifications for interview reminders: publishing due reminders and the per-user
 * list, read state and preference. Reads rounds from `interviews.ts`; called by the publisher worker and API.
 */

import { rollback } from './rollback.js';
import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';

/** A reminder notification. It holds ids only; no interview title, contact or note text is copied in. */
export type InAppNotification = {
  id: string;
  roundId: string;
  leadId: string;
  createdAt: Date;
  readAt: Date | null;
};

/** Up to 50 current notifications and the unread count among them. */
export type InAppNotificationList = {
  items: InAppNotification[];
  unreadCount: number;
};

/**
 * Materialize due interview reminders as owner-scoped in-app notifications.
 * The unique (owner, round, scheduled time) key makes repeated and concurrent
 * publisher passes idempotent; row locking prevents duplicate work where
 * multiple publisher instances are running. No message or contact data is
 * copied into the notification.
 */
export async function publishDueInterviewReminders(database: Database): Promise<number> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    // First retire notifications whose round was rescheduled, cancelled or has started, so they stop appearing.
    const stale = await client.query<{ ownerId: string; roundId: string }>(
      `SELECT round.owner_id AS "ownerId", round.id AS "roundId"
       FROM interview_rounds round
       WHERE EXISTS (
         SELECT 1 FROM in_app_notifications notification
         WHERE notification.owner_id = round.owner_id
           AND notification.round_id = round.id
           AND notification.retired_at IS NULL
           AND NOT (
             round.status = 'scheduled' AND round.starts_at > now()
             AND round.reminder_at = notification.reminder_at
           )
       )
       ORDER BY round.id
       LIMIT 100
       FOR UPDATE OF round SKIP LOCKED`,
    );
    for (const round of stale.rows) {
      await client.query(
        `UPDATE in_app_notifications notification
         SET retired_at = now()
         WHERE notification.owner_id = $1 AND notification.round_id = $2
           AND notification.retired_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM interview_rounds current_round
             WHERE current_round.owner_id = notification.owner_id
               AND current_round.id = notification.round_id
               AND current_round.status = 'scheduled'
               AND current_round.starts_at > now()
               AND current_round.reminder_at = notification.reminder_at
           )`,
        [round.ownerId, round.roundId],
      );
    }
    // Then find rounds with a due reminder that has no notification yet. SKIP LOCKED lets several publishers split the work.
    const due = await client.query<{
      ownerId: string;
      roundId: string;
    }>(
      `SELECT round.owner_id AS "ownerId", round.id AS "roundId"
       FROM interview_rounds round
       WHERE round.status = 'scheduled' AND round.reminder_at <= now()
         AND round.starts_at > now()
         AND NOT EXISTS (
           SELECT 1 FROM in_app_notifications notification
           WHERE notification.owner_id = round.owner_id
             AND notification.round_id = round.id
             AND notification.reminder_at = round.reminder_at
         )
         AND COALESCE((
           SELECT preference.interview_reminders_in_app_enabled
           FROM notification_preferences preference
           WHERE preference.owner_id = round.owner_id
         ), true)
       ORDER BY round.reminder_at, round.id
       LIMIT 100
       FOR UPDATE OF round SKIP LOCKED`,
    );
    // Preference writes take this same transaction-scoped owner lock. Acquire
    // locks in stable order so concurrent publisher batches cannot deadlock.
    // The insert below rechecks the preference in a new READ COMMITTED
    // statement after any waiting writer commits.
    const owners = [...new Set(due.rows.map((reminder) => reminder.ownerId))].sort();
    for (const ownerId of owners) {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ownerId]);
    }
    let created = 0;
    for (const reminder of due.rows) {
      const inserted = await client.query(
        `INSERT INTO in_app_notifications (id, owner_id, round_id, reminder_at)
         SELECT $1, round.owner_id, round.id, round.reminder_at
         FROM interview_rounds round
         WHERE round.owner_id = $2 AND round.id = $3
           AND round.status = 'scheduled' AND round.reminder_at <= now()
           AND round.starts_at > now()
           AND COALESCE((
             SELECT preference.interview_reminders_in_app_enabled
             FROM notification_preferences preference
             WHERE preference.owner_id = round.owner_id
           ), true)
         ON CONFLICT (owner_id, round_id, reminder_at) DO NOTHING
         RETURNING id`,
        [randomUUID(), reminder.ownerId, reminder.roundId],
      );
      created += inserted.rowCount ?? 0;
    }
    await client.query('COMMIT');
    return created;
  } catch (error) {
    await rollback(client);
    throw error;
  } finally {
    client.release();
  }
}

/** Postgres access for a user's in-app notifications and their reminder preference. */
export class InAppNotificationRepository {
  constructor(private readonly database: Database) {}

  /** Current notifications, newest first. Retired ones and those whose round changed or passed are excluded. */
  async list(ownerId: string): Promise<InAppNotificationList> {
    const result = await this.database.pool.query<InAppNotification & { unreadCount: string }>(
      `SELECT notification.id, notification.round_id AS "roundId",
              round.lead_id AS "leadId", notification.created_at AS "createdAt",
              notification.read_at AS "readAt",
              COUNT(*) FILTER (WHERE notification.read_at IS NULL) OVER () AS "unreadCount"
       FROM in_app_notifications notification
       JOIN interview_rounds round
         ON round.owner_id = notification.owner_id AND round.id = notification.round_id
       WHERE notification.owner_id = $1
         AND notification.retired_at IS NULL
         AND round.status = 'scheduled'
         AND round.starts_at > now()
         AND round.reminder_at = notification.reminder_at
       ORDER BY notification.created_at DESC, notification.id DESC
       LIMIT 50`,
      [ownerId],
    );
    const unreadCount = Number(result.rows[0]?.unreadCount ?? 0);
    const items = result.rows.map(({ unreadCount: _unreadCount, ...item }) => item);
    return { items, unreadCount };
  }

  /** Marks a current notification read. False if it is not the user's, is retired, or its round no longer matches. */
  async markRead(ownerId: string, id: string): Promise<boolean> {
    const result = await this.database.pool.query(
      `UPDATE in_app_notifications notification
       SET read_at = COALESCE(notification.read_at, now())
       WHERE notification.owner_id = $1 AND notification.id = $2
         AND notification.retired_at IS NULL
         AND EXISTS (
           SELECT 1 FROM interview_rounds round
           WHERE round.owner_id = notification.owner_id
             AND round.id = notification.round_id
             AND round.status = 'scheduled'
             AND round.starts_at > now()
             AND round.reminder_at = notification.reminder_at
         )
       RETURNING notification.id`,
      [ownerId, id],
    );
    return result.rowCount === 1;
  }

  /** Whether in-app reminders are enabled; the default is true when the user never set a preference. */
  async interviewReminderPreference(ownerId: string): Promise<boolean> {
    const result = await this.database.pool.query<{ enabled: boolean }>(
      `SELECT interview_reminders_in_app_enabled AS enabled
       FROM notification_preferences WHERE owner_id = $1`,
      [ownerId],
    );
    return result.rows[0]?.enabled ?? true;
  }

  /** Stores the preference under the same per-user advisory lock the publisher takes, so a change cannot race a publish pass. */
  async setInterviewReminderPreference(ownerId: string, enabled: boolean): Promise<void> {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      // This lock also covers the absent-row/default-enabled case, which a
      // row-level lock cannot protect.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [ownerId]);
      await client.query(
        `INSERT INTO notification_preferences
          (owner_id, interview_reminders_in_app_enabled, updated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (owner_id) DO UPDATE SET
           interview_reminders_in_app_enabled = EXCLUDED.interview_reminders_in_app_enabled,
           updated_at = now()`,
        [ownerId, enabled],
      );
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
