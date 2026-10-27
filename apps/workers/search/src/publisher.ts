/**
 * Outbox publisher process. Loops once a second: sends unpublished commands to their queues,
 * materialises due interview reminders, settles dead letters, and reports backlog health.
 * Depends on `@careerscope/core` for all state.
 */

import { setTimeout as delay } from 'node:timers/promises';
import {
  Database,
  BullSearchQueue,
  LocalQueue,
  configuration,
  logFailure,
  logger,
  publishPending,
  reconcileDeadLetter,
  shutdownSignal,
  ResumeUploadRepository,
  publishDueInterviewReminders,
} from '@careerscope/core';

const env = configuration();
const database = new Database(env.DATABASE_URL);
const queue =
  env.SEARCH_QUEUE_TRANSPORT === 'bullmq'
    ? new BullSearchQueue(database, env.SEARCH_QUEUE_REDIS_URL!)
    : new LocalQueue(env.QUEUE_REDIS_URL);
const shutdown = shutdownSignal();
// The files queue has no alternative transport regardless of the search setting.
const filesQueue =
  process.env.RESUME_STORAGE_DIRECTORY && process.env.RESUME_STORAGE_KEY_FILE
    ? new LocalQueue(env.QUEUE_REDIS_URL)
    : undefined;
const uploads = new ResumeUploadRepository(database);
// Backlog is reported once a minute; it warns when a lease expired, work is older than five minutes, or a dead letter exists.
const backlogIntervalMs = 60000;
const backlogWarnSeconds = 300;
let lastBacklogReport = 0;
const reportBacklog = async () => {
  if (Date.now() - lastBacklogReport < backlogIntervalMs) return;
  const backlog = await database.backlog();
  lastBacklogReport = Date.now();
  // Durable counters cannot see published work stuck in or dropped by the queue.
  const depth = queue instanceof LocalQueue ? await queue.depth() : undefined;
  const files = await filesQueue?.depth();
  const stalled =
    backlog.expiredLeases > 0 ||
    (backlog.oldestUnpublishedSeconds ?? 0) > backlogWarnSeconds ||
    (backlog.oldestRunningSeconds ?? 0) > backlogWarnSeconds ||
    (depth?.deadLetter ?? 0) > 0 ||
    (files?.deadLetter ?? 0) > 0;
  logger[stalled ? 'warn' : 'info'](
    { ...backlog, searchQueue: depth, filesQueue: files },
    stalled
      ? 'Durable work is not settling; expired leases, aged outbox records or dead letters remain'
      : 'durable work backlog',
  );
};
try {
  await filesQueue?.initialize(process.env.FILES_QUEUE_NAME ?? 'careerscope-files');
  if (queue instanceof LocalQueue) await queue.initialize('careerscope-search');
  else await queue.initialize();
  logger.info('outbox publisher ready');
  while (!shutdown.signal.aborted) {
    try {
      await publishPending(database, { 'search.collect': queue, 'resume.parse': filesQueue });
      try {
        const created = await publishDueInterviewReminders(database);
        if (created > 0) logger.info({ created }, 'due interview reminders made available in-app');
      } catch (error) {
        // The durable interview schedule is the retry source. Never log the
        // user, round title, contacts, or notes when a reminder scan fails.
        logFailure(
          error,
          {},
          'Due interview reminders could not be materialized; they remain retryable',
        );
      }
      // A dead letter that does not match a stored command must not stop the other reconciliations or the backlog report.
      if (filesQueue) {
        try {
          const failedResume = await filesQueue.receiveDeadLetter();
          if (failedResume)
            await reconcileDeadLetter(database, failedResume, 'resume.parse', (command, fence) =>
              uploads.settleParse(command, fence, {
                status: 'rejected',
                errorCode: 'processing_failed',
              }),
            );
        } catch (error) {
          logFailure(error, {}, 'Resume dead letter could not be reconciled');
        }
      }
      if (queue instanceof LocalQueue) {
        try {
          const deadLetter = await queue.receiveDeadLetter();
          if (deadLetter) await reconcileDeadLetter(database, deadLetter);
        } catch (error) {
          logFailure(error, {}, 'Search dead letter could not be reconciled');
        }
      }
    } catch (error) {
      logFailure(error, {}, 'Outbox publish failed; records remain available for retry');
    } finally {
      try {
        await reportBacklog();
      } catch (error) {
        logFailure(error, {}, 'Backlog report failed');
      }
    }
    await delay(1000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
} finally {
  await queue.close();
  await filesQueue?.close();
  await database.close();
  shutdown.close();
}
