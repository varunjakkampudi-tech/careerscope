/**
 * Notification outbox: channel selection, fixed multilingual templates, quiet hours and at-least-once
 * delivery with retries and a dead-letter table. Transports are injected; the publisher worker drives it.
 */

import { rollback } from './rollback.js';
import { randomUUID } from 'node:crypto';
import type { Database } from './database.js';

/** Where a notification can be delivered. */
export type NotificationChannel = 'in_app' | 'email' | 'web_push';
/** Event categories. Sign-in codes are not a kind: they never use this outbox, and `enqueue` and `notificationChannels` refuse them. */
export type NotificationKind = 'security' | 'application' | 'interview' | 'marketing';
/** Locales with fixed templates: English, Telugu and Hindi. */
export type NotificationLocale = 'en' | 'te' | 'hi';
/** An event to notify about. `payload` values are not rendered into messages; templates are fixed. */
export type NotificationEvent = {
  id: string;
  ownerId: string;
  kind: NotificationKind;
  template: string;
  locale: NotificationLocale;
  payload: Record<string, string>;
};
/** Subject and plain-text body ready to send. */
export type RenderedMessage = { subject: string; text: string };
/** A channel sender. It must throw on failure so the outbox retries. */
export type NotificationTransport = {
  send(event: NotificationEvent, message: RenderedMessage): Promise<void>;
};

/** Fixed copy per locale and template, so message text can never contain user-supplied data. */
const templates: Record<NotificationLocale, Record<string, RenderedMessage>> = {
  en: {
    interview_reminder: { subject: 'Interview reminder', text: 'You have an upcoming interview.' },
    account_security: {
      subject: 'Account security update',
      text: 'There is an update to your account security.',
    },
    application_update: {
      subject: 'Application update',
      text: 'There is an update to an application you are tracking.',
    },
    digest: {
      subject: 'Your CareerScope updates',
      text: 'You have updates waiting in CareerScope.',
    },
  },
  te: {
    interview_reminder: { subject: 'ఇంటర్వ్యూ రిమైండర్', text: 'మీకు త్వరలో ఇంటర్వ్యూ ఉంది.' },
    account_security: {
      subject: 'ఖాతా భద్రత నవీకరణ',
      text: 'మీ ఖాతా భద్రతకు సంబంధించిన నవీకరణ ఉంది.',
    },
    application_update: {
      subject: 'దరఖాస్తు నవీకరణ',
      text: 'మీరు గమనిస్తున్న దరఖాస్తుకు నవీకరణ ఉంది.',
    },
    digest: { subject: 'మీ CareerScope నవీకరణలు', text: 'CareerScopeలో మీకు నవీకరణలు ఉన్నాయి.' },
  },
  hi: {
    interview_reminder: {
      subject: 'साक्षात्कार रिमाइंडर',
      text: 'आपका एक साक्षात्कार आने वाला है।',
    },
    account_security: {
      subject: 'खाता सुरक्षा अपडेट',
      text: 'आपकी खाता सुरक्षा के बारे में एक अपडेट है।',
    },
    application_update: {
      subject: 'आवेदन अपडेट',
      text: 'आपके ट्रैक किए गए आवेदन में एक अपडेट है।',
    },
    digest: { subject: 'आपके CareerScope अपडेट', text: 'CareerScope में आपके लिए अपडेट हैं।' },
  },
};

/** Notification copy is deliberately fixed and cannot interpolate PII-bearing payload fields. */
export function renderNotification(locale: NotificationLocale, template: string): RenderedMessage {
  const message = templates[locale][template];
  if (!message) throw new Error('Unsupported notification template');
  return message;
}

/**
 * Channels for an event given the user's preferences. Marketing needs opt-in, disabled kinds are
 * dropped except `security`, `security` always includes email and never web push, and in-app is
 * always included otherwise.
 */
export function notificationChannels(
  event: NotificationEvent,
  preferences: {
    email: boolean;
    webPush: boolean;
    marketingOptIn: boolean;
    disabledTypes: NotificationKind[];
  },
): NotificationChannel[] {
  if (event.kind === ('sign_in_otp' as NotificationKind))
    throw new Error('Sign-in OTP cannot use notification outbox');
  if (event.kind === 'marketing' && !preferences.marketingOptIn) return [];
  if (preferences.disabledTypes.includes(event.kind) && event.kind !== 'security') return [];
  const channels: NotificationChannel[] = ['in_app'];
  if (event.kind === 'security' || preferences.email) channels.push('email');
  if (preferences.webPush && event.kind !== 'security') channels.push('web_push');
  return channels;
}

/**
 * Returns when to send, or null if `now` is outside the quiet window. The window is interpreted in
 * `timeZone` and may cross midnight. The end is found by stepping minute by minute through the
 * zone's local time, which stays correct across daylight saving changes.
 */
export function quietHoursDefer(
  now: Date,
  timeZone: string,
  start: string,
  end: string,
): Date | null {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(end))
    throw new Error('Invalid quiet hours');
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const minute =
    Number(parts.find((part) => part.type === 'hour')?.value) * 60 +
    Number(parts.find((part) => part.type === 'minute')?.value);
  const from = Number(start.slice(0, 2)) * 60 + Number(start.slice(3));
  const to = Number(end.slice(0, 2)) * 60 + Number(end.slice(3));
  const quiet = from <= to ? minute >= from && minute < to : minute >= from || minute < to;
  if (!quiet) return null;
  // Re-evaluate in the user's zone after the quiet window; DST-safe by stepping to next minute.
  const candidate = new Date(now.getTime() + 60_000);
  for (let i = 0; i < 26 * 60; i++) {
    const p = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(candidate);
    const m =
      Number(p.find((part) => part.type === 'hour')?.value) * 60 +
      Number(p.find((part) => part.type === 'minute')?.value);
    const active = from <= to ? m >= from && m < to : m >= from || m < to;
    if (!active) return candidate;
    candidate.setTime(candidate.getTime() + 60_000);
  }
  throw new Error('Quiet-hours window could not be resolved');
}

/** Postgres outbox for notification events and per-channel deliveries. */
export class NotificationOutbox {
  constructor(private readonly database: Database) {}

  /** Stores the event and one pending delivery per distinct channel in one transaction. Sign-in codes are refused. */
  async enqueue(
    event: Omit<NotificationEvent, 'id'>,
    channels: NotificationChannel[],
  ): Promise<string> {
    const id = randomUUID();
    if ((event.kind as string) === 'sign_in_otp')
      throw new Error('Sign-in OTP cannot use notification outbox');
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'INSERT INTO notification_events (id, owner_id, kind, template, locale, payload) VALUES ($1,$2,$3,$4,$5,$6::jsonb)',
        [
          id,
          event.ownerId,
          event.kind,
          event.template,
          event.locale,
          JSON.stringify(event.payload),
        ],
      );
      for (const channel of new Set(channels)) {
        await client.query(
          'INSERT INTO notification_deliveries (event_id, channel) VALUES ($1,$2) ON CONFLICT (event_id,channel) DO NOTHING',
          [id, channel],
        );
      }
      await client.query('COMMIT');
      return id;
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Claims and sends one due delivery, returning false when none is due. Claiming uses SKIP LOCKED
   * and a two minute lease, so concurrent workers never send the same delivery and a crashed worker's
   * claim is retried. Failures retry with exponential backoff (at most five attempts), then the
   * delivery is dead-lettered. Error details are not stored, only a fixed message. `killEmailAndSync`
   * skips email deliveries.
   */
  async deliverNext(
    transports: Partial<Record<NotificationChannel, NotificationTransport>>,
    options: { maxAttempts?: number; baseDelayMs?: number; killEmailAndSync?: boolean } = {},
  ): Promise<boolean> {
    // The claim transaction ends before sending, so the database is not held open during a network call.
    const maxAttempts = Math.min(5, Math.max(1, options.maxAttempts ?? 5));
    const client = await this.database.pool.connect();
    let row:
      | {
          event_id: string;
          channel: NotificationChannel;
          attempts: number;
          owner_id: string;
          kind: NotificationKind;
          template: string;
          locale: NotificationLocale;
          payload: Record<string, string>;
        }
      | undefined;
    try {
      await client.query('BEGIN');
      await client.query(
        "UPDATE notification_deliveries SET status='dead_letter', claimed_at=NULL, last_error='delivery failed' WHERE status='sending' AND claimed_at < now()-interval '2 minutes' AND attempts>=5",
      );
      await client.query(
        "INSERT INTO notification_dead_letters (event_id,channel,attempts) SELECT event_id,channel,attempts FROM notification_deliveries WHERE status='dead_letter' ON CONFLICT (event_id,channel) DO NOTHING",
      );
      const selected = await client.query<
        typeof row extends infer T ? Exclude<T, undefined> : never
      >(
        `SELECT d.event_id, d.channel, d.attempts, e.owner_id, e.kind, e.template, e.locale, e.payload
         FROM notification_deliveries d JOIN notification_events e ON e.id=d.event_id
         WHERE (d.status='pending' OR (d.status='sending' AND d.claimed_at < now()-interval '2 minutes' AND d.attempts<5))
           AND d.available_at<=now() AND ($1::boolean=false OR d.channel<>'email')
         ORDER BY d.available_at,d.event_id FOR UPDATE OF d SKIP LOCKED LIMIT 1`,
        [options.killEmailAndSync ?? false],
      );
      row = selected.rows[0];
      if (!row) {
        await client.query('COMMIT');
        return false;
      }
      await client.query(
        "UPDATE notification_deliveries SET status='sending', claimed_at=now(), attempts=attempts+1 WHERE event_id=$1 AND channel=$2",
        [row.event_id, row.channel],
      );
      await client.query('COMMIT');
    } catch (error) {
      await rollback(client);
      throw error;
    } finally {
      client.release();
    }
    const event: NotificationEvent = {
      id: row.event_id,
      ownerId: row.owner_id,
      kind: row.kind,
      template: row.template,
      locale: row.locale,
      payload: row.payload,
    };
    try {
      const transport = transports[row.channel];
      if (!transport) throw new Error('Notification transport unavailable');
      await transport.send(event, renderNotification(event.locale, event.template));
      await this.database.pool.query(
        "UPDATE notification_deliveries SET status='delivered', delivered_at=now(), claimed_at=NULL, last_error=NULL WHERE event_id=$1 AND channel=$2",
        [row.event_id, row.channel],
      );
    } catch {
      const attempts = row.attempts + 1;
      const exhausted = attempts >= maxAttempts;
      // Backoff doubles from one minute and is capped at six hours; `baseDelayMs` sets a lower bound.
      const wait = Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 6 * 60 * 60_000);
      await this.database.pool.query(
        "UPDATE notification_deliveries SET status=$3, claimed_at=NULL, available_at=now()+($4::int * interval '1 millisecond'), last_error='delivery failed' WHERE event_id=$1 AND channel=$2",
        [
          row.event_id,
          row.channel,
          exhausted ? 'dead_letter' : 'pending',
          Math.max(options.baseDelayMs ?? 1000, wait),
        ],
      );
      if (exhausted)
        await this.database.pool.query(
          'INSERT INTO notification_dead_letters (event_id,channel,attempts) VALUES ($1,$2,$3) ON CONFLICT (event_id,channel) DO NOTHING',
          [row.event_id, row.channel, attempts],
        );
    }
    return true;
  }
}

/** In-memory transport that records messages, for tests. */
export class RecordingNotificationTransport implements NotificationTransport {
  readonly messages: Array<{ event: NotificationEvent; message: RenderedMessage }> = [];
  async send(event: NotificationEvent, message: RenderedMessage) {
    this.messages.push({ event, message });
  }
}
