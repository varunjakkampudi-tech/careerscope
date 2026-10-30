/**
 * Resume-parsing worker process. Consumes `resume.parse` commands from the files queue and runs the
 * isolated parser through `resumeParseHandler`. Does nothing if private resume storage is not configured.
 */

import { setTimeout as delay } from 'node:timers/promises';
import {
  Database,
  LocalQueue,
  ResumeUploadRepository,
  configuration,
  configuredFileResumeStorage,
  consumeMessage,
  installProcessFailureHandlers,
  logFailure,
  logger,
  resumeParseHandler,
  shutdownSignal,
} from '@careerscope/core';

installProcessFailureHandlers();

let database: Database | undefined;
let queue: LocalQueue | undefined;
let cleaned = false;

try {
  const storage = await configuredFileResumeStorage();
  const shutdown = shutdownSignal();
  if (!storage) {
    logger.info('files worker disabled; private storage is not configured');
    if (!shutdown.signal.aborted)
      await new Promise<void>((resolve) =>
        shutdown.signal.addEventListener('abort', () => resolve(), { once: true }),
      );
    shutdown.close();
  } else {
    const env = configuration();
    database = new Database(env.DATABASE_URL);
    // Resume parsing queue backed by Redis BullMQ.
    const filesQueue = new LocalQueue(env.QUEUE_REDIS_URL);
    queue = filesQueue;
    logger.info({ transport: 'bullmq', queue: 'files' }, 'files worker transport');
    const uploads = new ResumeUploadRepository(database);
    const db = database;
    // Storage capacity is reported every five minutes, and a warning is logged when headroom or the marker quota is exhausted.
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
              : 'resume storage capacity',
        );
      } catch {
        if (!shutdown.signal.aborted) logger.error('Resume storage capacity could not be measured');
      }
    };
    try {
      await filesQueue.initialize(process.env.FILES_QUEUE_NAME ?? 'careerscope-files');
      await reportCapacity();
      logger.info('isolated files worker ready');
      while (!shutdown.signal.aborted) {
        if (Date.now() - lastCapacityReport >= capacityIntervalMs) await reportCapacity();
        try {
          const message = await filesQueue.receive(shutdown.signal);
          if (message)
            await consumeMessage(
              db,
              filesQueue,
              message,
              'resume.parse',
              resumeParseHandler(db, storage),
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
      cleaned = true;
      await filesQueue.close();
      storage.close();
      await db.close();
      shutdown.close();
    }
  }
} catch (error) {
  // Bounds cleanup: a hung close must not keep the process alive.
  setTimeout(() => process.exit(1), 5000).unref();
  logFailure(error, {}, 'Startup failed');
  // An open Redis client or pool would keep the event loop alive, so release them and exit explicitly.
  if (!cleaned) {
    await queue?.close().catch(() => {});
    await database?.close().catch(() => {});
  }
  process.exit(1);
}
