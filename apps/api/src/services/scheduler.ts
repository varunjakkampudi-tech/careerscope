import { searchRequestSchema } from '@job-radar/shared';
import type { JobProvider } from '@job-radar/providers';
import { SETTING, type Repos } from '../db/repo/index.js';
import type { Logger } from '../logger.js';
import type { RunQueue } from './queue.js';
import { z } from 'zod';

export const dailySearchTimeSchema = z
  .object({
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    timeZone: z
      .string()
      .min(1)
      .max(100)
      .refine((timeZone) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone });
          return true;
        } catch {
          return false;
        }
      }, 'Use a valid IANA timezone'),
  })
  .strict();

export type DailySearchTime = z.infer<typeof dailySearchTimeSchema>;

function localScheduleTime(at: string, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(at));
  const value = (type: string) => parts.find((part) => part.type === type)!.value;
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
  };
}

interface SchedulerOptions {
  repos: Repos;
  queue: Pick<RunQueue, 'enqueue' | 'status'>;
  providers: readonly JobProvider[];
  logger: Logger;
  intervalMinutes: number;
  enableLlmRerank: boolean;
  clock: () => string;
}

export interface ScheduledAttempt {
  at: string;
  status: 'paused' | 'queued';
  message: string;
  runId: string | null;
}

export function scheduledSearch(options: SchedulerOptions): void {
  const { repos, queue, providers, clock, logger } = options;
  const intervalMinutes = repos.settings.getJson(
    SETTING.searchIntervalMinutes,
    options.intervalMinutes,
  );
  if (
    !Number.isInteger(intervalMinutes) ||
    intervalMinutes < 360 ||
    intervalMinutes > 10080 ||
    !repos.profiles.exists() ||
    repos.runs.active()
  )
    return;
  const queueState = queue.status();
  if (!queueState.accepting || queueState.running || queueState.queued.length) return;
  const at = clock();
  const previous = repos.settings.get(SETTING.lastScheduledAt);
  const dailyAt = dailySearchTimeSchema
    .nullable()
    .safeParse(repos.settings.getJson(SETTING.searchDailyAt, null));
  if (!dailyAt.success) return;
  if (intervalMinutes === 1440 && dailyAt.data) {
    const local = localScheduleTime(at, dailyAt.data.timeZone);
    if (local.time < dailyAt.data.time) return;
    if (previous && localScheduleTime(previous, dailyAt.data.timeZone).date >= local.date) return;
  } else if (previous && Date.parse(at) - Date.parse(previous) < intervalMinutes * 60_000) return;

  const available = providers.filter((provider) => provider.unavailableReason === null);
  const parsed = searchRequestSchema.safeParse(
    repos.settings.getJson(SETTING.lastSearchRequest, {
      sources: available.map((provider) => provider.id),
    }),
  );
  repos.settings.set(SETTING.lastScheduledAt, at, at);
  const paused = (message: string) => {
    repos.settings.setJson(
      SETTING.lastScheduledAttempt,
      { at, status: 'paused', message, runId: null } satisfies ScheduledAttempt,
      at,
    );
    logger.warn(message);
  };
  if (!parsed.success) {
    paused(
      'Scheduled search paused: saved search settings are invalid. Save a valid search to resume.',
    );
    return;
  }
  const request = parsed.data;
  if (
    !available.length ||
    request.sources.some((id) => !available.some((provider) => provider.id === id))
  ) {
    paused(
      'Scheduled search paused: a selected source is unavailable. Review sources in Search and save an available selection.',
    );
    return;
  }
  if (request.useLlmRerank && !options.enableLlmRerank) {
    paused(
      'Scheduled search paused: semantic reranking is no longer configured. Disable it in Search or restore its configuration.',
    );
    return;
  }
  const run = repos.runs.create(request, at);
  queue.enqueue(run.id);
  repos.settings.setJson(
    SETTING.lastScheduledAttempt,
    {
      at,
      status: 'queued',
      message: 'Scheduled search queued. Check the run for results and source failures.',
      runId: run.id,
    } satisfies ScheduledAttempt,
    at,
  );
  logger.info({ runId: run.id }, 'Scheduled search started');
}

export function startSearchScheduler(options: SchedulerOptions): () => void {
  const tick = () => {
    try {
      scheduledSearch(options);
    } catch {
      options.logger.error('Scheduled search could not start');
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
