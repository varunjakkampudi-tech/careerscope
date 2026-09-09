import { describe, expect, it } from 'vitest';
import { buildTestApp } from './routes.fixtures.js';
import { SETTING } from '../db/repo/index.js';

it('exposes persisted schedule diagnostics only to authenticated callers', async () => {
  const fixture = await buildTestApp();
  try {
    const url = '/api/search/schedule';
    expect((await fixture.app.inject({ url })).statusCode).toBe(401);
    expect(
      (await fixture.app.inject({ url, headers: fixture.auth })).json().lastAttempt,
    ).toBeNull();
    const attempt = {
      at: '2026-09-09T10:00:00Z',
      status: 'paused',
      message: 'Selected source unavailable.',
      runId: null,
    };
    fixture.container.repos.settings.setJson(SETTING.lastScheduledAttempt, attempt, attempt.at);
    const result = await fixture.app.inject({ url, headers: fixture.auth });
    expect(result.statusCode).toBe(200);
    expect(result.json().lastAttempt).toEqual(attempt);
    expect(result.headers['cache-control']).toContain('no-store');
  } finally {
    await fixture.close();
  }
});

describe('search schedule', () => {
  it('validates and persists a daily time and timezone', async () => {
    const fixture = await buildTestApp();
    try {
      const { app, auth } = fixture;
      const url = '/api/search/schedule';
      for (const dailyAt of [
        { time: '25:00', timeZone: 'Asia/Kolkata' },
        { time: '07:00', timeZone: 'Not/AZone' },
      ]) {
        expect(
          (
            await app.inject({
              method: 'PUT',
              url,
              headers: auth,
              payload: { intervalMinutes: 1440, dailyAt },
            })
          ).statusCode,
        ).toBe(400);
      }
      const dailyAt = { time: '07:00', timeZone: 'Asia/Kolkata' };
      expect(
        (
          await app.inject({
            method: 'PUT',
            url,
            headers: auth,
            payload: { intervalMinutes: 1440, dailyAt },
          })
        ).statusCode,
      ).toBe(200);
      expect((await app.inject({ url, headers: auth })).json()).toMatchObject({ dailyAt });
    } finally {
      await fixture.close();
    }
  });

  it('authenticates, validates and persists daily and disabled schedules', async () => {
    const fixture = await buildTestApp();
    try {
      const { app, auth } = fixture;
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/search/schedule',
            payload: { intervalMinutes: 1440 },
          })
        ).statusCode,
      ).toBe(401);
      for (const intervalMinutes of [-1, 1, 360, 10081]) {
        expect(
          (
            await app.inject({
              method: 'PUT',
              url: '/api/search/schedule',
              headers: auth,
              payload: { intervalMinutes },
            })
          ).statusCode,
        ).toBe(400);
      }
      for (const intervalMinutes of [1440, 0]) {
        expect(
          (
            await app.inject({
              method: 'PUT',
              url: '/api/search/schedule',
              headers: auth,
              payload: { intervalMinutes },
            })
          ).statusCode,
        ).toBe(200);
        expect(
          (await app.inject({ method: 'GET', url: '/api/search/schedule', headers: auth })).json(),
        ).toMatchObject({ intervalMinutes });
      }
    } finally {
      await fixture.close();
    }
  });
});
