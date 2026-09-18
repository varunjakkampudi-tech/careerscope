import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviders } from '@job-radar/providers';
import { searchRequestSchema } from '@job-radar/shared';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContainer } from '../container.js';
import { parseEnv } from '../env.js';
import { createTestRepos, makeProfile, NOW } from '../db/repo/repo.fixtures.js';
import { SETTING } from '../db/repo/index.js';
import { createLogger } from '../logger.js';
import { scheduledSearch, startSearchScheduler } from './scheduler.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.useRealTimers();
});

function fixture() {
  const repos = createTestRepos();
  cleanups.push(() => repos.cleanup());
  repos.profiles.save(makeProfile(), NOW);
  return {
    repos,
    providers: createProviders(),
    queue: { enqueue: vi.fn(), status: () => ({ accepting: true, running: null, queued: [] }) },
    logger: createLogger({ level: 'fatal', pretty: false }),
    intervalMinutes: 360,
    enableLlmRerank: false,
    clock: () => NOW,
  };
}

describe('automatic search', () => {
  it.each([false, true])('respects startup recovery ownership: %s', async (recoverOrphans) => {
    const directory = mkdtempSync(join(tmpdir(), 'job-radar-recovery-'));
    const env = parseEnv({ NODE_ENV: 'test', DATA_DIR: directory, LOG_LEVEL: 'fatal' });
    const owner = createContainer(env, { startScheduler: false });
    let observer: ReturnType<typeof createContainer> | undefined;
    try {
      owner.repos.profiles.save(makeProfile(), NOW);
      const run = owner.repos.runs.create(
        searchRequestSchema.parse({ sources: ['greenhouse'] }),
        NOW,
      );
      observer = createContainer(env, { startScheduler: false, recoverOrphans });
      expect(owner.repos.runs.get(run.id)?.status).toBe(recoverOrphans ? 'failed' : 'queued');
      expect(observer.queue.status().queued).toEqual([]);
    } finally {
      await observer?.close();
      await owner.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps a container scheduler disabled despite enabled stored settings', async () => {
    vi.useFakeTimers();
    const directory = mkdtempSync(join(tmpdir(), 'job-radar-scheduler-'));
    const container = createContainer(
      parseEnv({ NODE_ENV: 'test', DATA_DIR: directory, LOG_LEVEL: 'fatal' }),
      { databasePath: ':memory:', startScheduler: false },
    );
    try {
      container.repos.profiles.save(makeProfile(), NOW);
      container.repos.settings.setJson(SETTING.searchIntervalMinutes, 360, NOW);
      const enqueue = vi.spyOn(container.queue, 'enqueue').mockImplementation(() => {});
      vi.advanceTimersByTime(120_000);
      expect(enqueue).not.toHaveBeenCalled();
      expect(container.repos.settings.get(SETTING.lastScheduledAt)).toBeNull();
      expect(container.repos.runs.active()).toBeNull();
    } finally {
      await container.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs once after 7 AM in India, including wake-up catchup and restart deduplication', () => {
    const options = { ...fixture(), intervalMinutes: 1440 };
    options.repos.settings.setJson(
      SETTING.searchDailyAt,
      { time: '07:00', timeZone: 'Asia/Kolkata' },
      NOW,
    );
    scheduledSearch({ ...options, clock: () => '2026-09-09T01:29:00.000Z' });
    expect(options.queue.enqueue).not.toHaveBeenCalled();
    scheduledSearch({ ...options, clock: () => '2026-09-09T01:30:00.000Z' });
    expect(options.queue.enqueue).toHaveBeenCalledOnce();
    options.repos.runs.active = () => null;
    scheduledSearch({ ...options, clock: () => '2026-09-09T06:00:00.000Z' });
    expect(options.queue.enqueue).toHaveBeenCalledOnce();
    scheduledSearch({ ...options, clock: () => '2026-09-10T04:00:00.000Z' });
    expect(options.queue.enqueue).toHaveBeenCalledTimes(2);
  });

  it('enables a daily schedule without restarting and honors a persisted disable', () => {
    vi.useFakeTimers();
    const options = { ...fixture(), intervalMinutes: 0 };
    const stop = startSearchScheduler(options);
    cleanups.push(stop);
    options.repos.settings.setJson(SETTING.searchIntervalMinutes, 1440, NOW);
    vi.advanceTimersByTime(60_000);
    expect(options.queue.enqueue).toHaveBeenCalledOnce();
    options.repos.settings.setJson(SETTING.searchIntervalMinutes, 0, NOW);
    const other = fixture();
    other.repos.settings.setJson(SETTING.searchIntervalMinutes, 0, NOW);
    scheduledSearch(other);
    expect(other.queue.enqueue).not.toHaveBeenCalled();
  });

  it('defaults to 85% and reuses the queue', () => {
    const options = fixture();
    scheduledSearch(options);
    expect(options.queue.enqueue).toHaveBeenCalledOnce();
    expect(options.repos.runs.active()?.request.minScore).toBe(0.85);
    expect(options.repos.settings.getJson(SETTING.lastScheduledAttempt, null)).toMatchObject({
      at: NOW,
      status: 'queued',
      runId: options.repos.runs.active()?.id,
    });
  });

  it('uses the saved threshold and source selection', () => {
    const options = fixture();
    options.repos.settings.setJson(
      SETTING.lastSearchRequest,
      { sources: ['greenhouse'], minScore: 0.92 },
      NOW,
    );
    scheduledSearch(options);
    expect(options.repos.runs.active()?.request).toMatchObject({
      sources: ['greenhouse'],
      minScore: 0.92,
    });
  });

  it('skips active searches, missing profiles and disabled schedules', () => {
    const options = fixture();
    scheduledSearch({ ...options, intervalMinutes: 0 });
    expect(options.queue.enqueue).not.toHaveBeenCalled();
    options.repos.profiles.delete();
    scheduledSearch(options);
    expect(options.queue.enqueue).not.toHaveBeenCalled();
    options.repos.profiles.save(makeProfile(), NOW);
    scheduledSearch(options);
    scheduledSearch(options);
    expect(options.queue.enqueue).toHaveBeenCalledOnce();
  });

  it('persists cadence across restarts and pauses unavailable selections', () => {
    const options = fixture();
    options.repos.settings.set(SETTING.lastScheduledAt, NOW, NOW);
    scheduledSearch(options);
    expect(options.queue.enqueue).not.toHaveBeenCalled();
    options.repos.settings.delete(SETTING.lastScheduledAt);
    options.repos.settings.setJson(SETTING.lastSearchRequest, { sources: ['gmail'] }, NOW);
    scheduledSearch(options);
    expect(options.queue.enqueue).not.toHaveBeenCalled();
    expect(options.repos.settings.getJson(SETTING.lastScheduledAttempt, null)).toMatchObject({
      status: 'paused',
      runId: null,
      message: expect.stringContaining('source is unavailable'),
    });
  });

  it.each([
    [{ sources: ['greenhouse'], minScore: 5 }, 'settings are invalid'],
    [{ sources: ['greenhouse'], useLlmRerank: true }, 'reranking is no longer configured'],
  ])('persists actionable pause reasons', (request, reason) => {
    const options = fixture();
    options.repos.settings.setJson(SETTING.lastSearchRequest, request, NOW);
    scheduledSearch(options);
    expect(options.queue.enqueue).not.toHaveBeenCalled();
    expect(options.repos.settings.getJson(SETTING.lastScheduledAttempt, null)).toMatchObject({
      status: 'paused',
      message: expect.stringContaining(reason),
      runId: null,
    });
  });

  it('stops the timer on shutdown', () => {
    vi.useFakeTimers();
    const options = fixture();
    const stop = startSearchScheduler(options);
    stop();
    vi.advanceTimersByTime(60_000);
    expect(options.queue.enqueue).not.toHaveBeenCalled();
  });
});
