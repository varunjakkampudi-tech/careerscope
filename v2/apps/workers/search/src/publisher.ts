import { setTimeout as delay } from 'node:timers/promises';
import {
  Database,
  BullSearchQueue,
  LocalQueue,
  configuration,
  logger,
  publishPending,
  reconcileDeadLetter,
  shutdownSignal,
  ResumeUploadRepository,
} from '@careerscope/core';

const env = configuration();
const database = new Database(env.DATABASE_URL);
const queue =
  env.SEARCH_QUEUE_TRANSPORT === 'bullmq'
    ? new BullSearchQueue(database, env.SEARCH_QUEUE_REDIS_URL!)
    : new LocalQueue(env.LOCAL_AWS_ENDPOINT);
const shutdown = shutdownSignal();
// The files queue has no alternative transport regardless of the search setting.
const filesQueue =
  process.env.RESUME_STORAGE_DIRECTORY && process.env.RESUME_STORAGE_KEY_FILE
    ? new LocalQueue(env.LOCAL_AWS_ENDPOINT)
    : undefined;
const uploads = new ResumeUploadRepository(database);
const backlogIntervalMs = 60000;
const backlogWarnSeconds = 300;
let lastBacklogReport = 0;
try {
  await filesQueue?.initialize(process.env.FILES_QUEUE_NAME ?? 'careerscope-v2-files');
  if (queue instanceof LocalQueue) await queue.initialize('careerscope-v2-search');
  else await queue.initialize();
  logger.info('v2 outbox publisher ready');
  while (!shutdown.signal.aborted) {
    try {
      await publishPending(database, { 'search.collect': queue, 'resume.parse': filesQueue });
      if (filesQueue) {
        const failedResume = await filesQueue.receiveDeadLetter();
        if (failedResume)
          await reconcileDeadLetter(database, failedResume, 'resume.parse', (command, fence) =>
            uploads.settleParse(command, fence, {
              status: 'rejected',
              errorCode: 'processing_failed',
            }),
          );
      }
      if (queue instanceof LocalQueue) {
        const deadLetter = await queue.receiveDeadLetter();
        if (deadLetter) await reconcileDeadLetter(database, deadLetter);
      }
      if (Date.now() - lastBacklogReport >= backlogIntervalMs) {
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
            : 'v2 durable work backlog',
        );
      }
    } catch {
      logger.error('Outbox publish failed; records remain available for retry');
    }
    await delay(1000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
} finally {
  await queue.close();
  filesQueue?.close();
  await database.close();
  shutdown.close();
}
