import { setTimeout as delay } from 'node:timers/promises';
import {
  Database,
  LocalQueue,
  ResumeUploadRepository,
  configuration,
  configuredFileResumeStorage,
  consumeMessage,
  logger,
  resumeParseHandler,
  shutdownSignal,
} from '@careerscope/core';

const storage = await configuredFileResumeStorage();
const shutdown = shutdownSignal();
if (!storage) {
  logger.info('v2 files worker disabled; private storage is not configured');
  if (!shutdown.signal.aborted)
    await new Promise<void>((resolve) =>
      shutdown.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
  shutdown.close();
} else {
  const env = configuration();
  const database = new Database(env.DATABASE_URL);
  // Resume parsing has no alternative transport; SEARCH_QUEUE_TRANSPORT does not
  // apply here, so the choice is stated rather than left to be inferred.
  const queue = new LocalQueue(env.LOCAL_AWS_ENDPOINT);
  logger.info({ transport: 'sqs', queue: 'files' }, 'v2 files worker transport');
  const uploads = new ResumeUploadRepository(database);
  const capacityIntervalMs = 300000;
  let lastCapacityReport = 0;
  const reportCapacity = async () => {
    try {
      const inventory = await storage.inventory(shutdown.signal);
      lastCapacityReport = Date.now();
      logger[inventory.belowReserve || inventory.markersExceeded ? 'warn' : 'info'](
        inventory,
        inventory.belowReserve
          ? 'Resume storage volume is below reserved headroom; uploads are being refused'
          : inventory.markersExceeded
            ? 'Cancellation marker quota reached; new cancellations are being refused'
            : 'v2 resume storage capacity',
      );
    } catch {
      if (!shutdown.signal.aborted) logger.error('Resume storage capacity could not be measured');
    }
  };
  try {
    await queue.initialize(process.env.FILES_QUEUE_NAME ?? 'careerscope-v2-files');
    await reportCapacity();
    logger.info('v2 isolated files worker ready');
    while (!shutdown.signal.aborted) {
      if (Date.now() - lastCapacityReport >= capacityIntervalMs) await reportCapacity();
      try {
        const message = await queue.receive(shutdown.signal);
        if (message)
          await consumeMessage(
            database,
            queue,
            message,
            'resume.parse',
            resumeParseHandler(database, storage),
            shutdown.signal,
            (command, fence) =>
              uploads.settleParse(command, fence, {
                status: 'rejected',
                errorCode: 'processing_failed',
              }),
          );
      } catch {
        if (shutdown.signal.aborted) break;
        logger.error('Resume processing interrupted; durable work retained for retry');
        await delay(1000, undefined, { signal: shutdown.signal }).catch(() => {});
      }
    }
  } finally {
    queue.close();
    storage.close();
    await database.close();
    shutdown.close();
  }
}
