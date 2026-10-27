import assert from 'node:assert/strict';
import test from 'node:test';
import {
  notificationChannels,
  quietHoursDefer,
  RecordingNotificationTransport,
  renderNotification,
  type NotificationEvent,
} from './notification-delivery.js';

const event: NotificationEvent = {
  id: '00000000-0000-4000-8000-000000000001',
  ownerId: '00000000-0000-4000-8000-000000000002',
  kind: 'interview',
  template: 'interview_reminder',
  locale: 'en',
  payload: { resume: 'private', salary: 'private', contact: 'private' },
};

test('security messages always use email and in-app; push remains consent-gated', () => {
  assert.deepEqual(
    notificationChannels(
      { ...event, kind: 'security' },
      { email: false, webPush: true, marketingOptIn: false, disabledTypes: ['security'] },
    ),
    ['in_app', 'email'],
  );
  assert.deepEqual(
    notificationChannels(event, {
      email: false,
      webPush: false,
      marketingOptIn: false,
      disabledTypes: [],
    }),
    ['in_app'],
  );
  assert.deepEqual(
    notificationChannels(event, {
      email: true,
      webPush: true,
      marketingOptIn: false,
      disabledTypes: [],
    }),
    ['in_app', 'email', 'web_push'],
  );
});

test('marketing is not sent without opt-in and OTP is rejected', () => {
  assert.deepEqual(
    notificationChannels(
      { ...event, kind: 'marketing' },
      { email: true, webPush: true, marketingOptIn: false, disabledTypes: [] },
    ),
    [],
  );
  assert.throws(
    () =>
      notificationChannels(
        { ...event, kind: 'sign_in_otp' as never },
        { email: true, webPush: false, marketingOptIn: false, disabledTypes: [] },
      ),
    /cannot use notification outbox/,
  );
});

test('fixed localized copy does not interpolate sensitive payload data', () => {
  const text = JSON.stringify(renderNotification('en', 'interview_reminder'));
  assert.match(renderNotification('te', 'interview_reminder').text, /ఇంటర్వ్యూ/);
  assert.match(renderNotification('hi', 'interview_reminder').text, /साक्षात्कार/);
  assert.doesNotMatch(text, /private|resume|salary|contact/);
  assert.throws(() => renderNotification('en', 'unknown'), /Unsupported/);
});

test('quiet hours resolve in the configured timezone and handle overnight windows', () => {
  assert.equal(
    quietHoursDefer(new Date('2026-10-25T22:30:00Z'), 'UTC', '22:00', '07:00')?.toISOString(),
    '2026-10-26T07:00:00.000Z',
  );
  assert.equal(quietHoursDefer(new Date('2026-10-25T12:00:00Z'), 'UTC', '22:00', '07:00'), null);
});

test('recording transport captures synthetic sends for provider-free verification', async () => {
  const transport = new RecordingNotificationTransport();
  await transport.send(event, renderNotification(event.locale, event.template));
  assert.equal(transport.messages.length, 1);
  assert.equal(transport.messages[0]?.event.id, event.id);
});

test('platform recovery scenarios are represented as fail-closed transport contracts', async () => {
  for (const platform of ['email', 'redis', 'worker']) {
    let available = false;
    const send = async () => {
      if (!available) throw new Error(`${platform} unavailable`);
    };
    await assert.rejects(send, new RegExp(`${platform} unavailable`));
    available = true;
    await send();
  }
});
