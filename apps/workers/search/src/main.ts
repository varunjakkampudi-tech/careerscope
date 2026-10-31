/**
 * Search worker process. Consumes `search.collect` commands from the configured queue transport
 * (BullMQ or the Redis `LocalQueue`) and runs `searchHandler` under database fencing.
 */

import { setTimeout as delay } from 'node:timers/promises';
import {
  Database,
  BullSearchQueue,
  LocalQueue,
  configuration,
  consumeMessage,
  installProcessFailureHandlers,
  logFailure,
  logger,
  shutdownSignal,
} from '@careerscope/core';
import { searchHandler } from './collect.js';

installProcessFailureHandlers();

let database: Database | undefined;
let cleaned = false;

try {
  const env = configuration(process.env, { emailOtpSecrets: false });
  const db = new Database(env.DATABASE_URL);
  database = db;
  const shutdown = shutdownSignal();
  try {
    if (env.SEARCH_QUEUE_TRANSPORT === 'bullmq') {
      const queue = new BullSearchQueue(db, env.SEARCH_QUEUE_REDIS_URL!);
      let worker: ReturnType<BullSearchQueue['worker']> | undefined;
      try {
        await queue.initialize();
        worker = queue.worker(searchHandler(db), shutdown.signal);
        await worker.waitUntilReady();
        logger.info('BullMQ search worker ready');
        while (!shutdown.signal.aborted) {
          await delay(1000, undefined, { signal: shutdown.signal }).catch(() => {});
        }
      } finally {
        worker?.cancelAllJobs('Worker stopping');
        await worker?.close();
        await queue.close();
      }
    } else {
      const queue = new LocalQueue(env.QUEUE_REDIS_URL);
      try {
        await queue.initialize('careerscope-search');
        logger.info('search worker ready');
        while (!shutdown.signal.aborted) {
          try {
            const message = await queue.receive(shutdown.signal);
            if (message)
              await consumeMessage(
                db,
                queue,
                message,
                'search.collect',
                searchHandler(db),
                shutdown.signal,
              );
          } catch (error) {
            if (shutdown.signal.aborted) break;
            logFailure(
              error,
              {},
              'Search delivery failed; message retained for retry or dead-letter handling',
            );
            await delay(1000, undefined, { signal: shutdown.signal }).catch(() => {});
          }
        }
      } finally {
        await queue.close();
      }
    }
  } finally {
    cleaned = true;
    await db.close();
    shutdown.close();
  }
} catch (error) {
  // Bounds cleanup: a hung close must not keep the process alive.
  setTimeout(() => process.exit(1), 5000).unref();
  logFailure(error, {}, 'Startup failed');
  // An open pool would keep the event loop alive, so release it and exit explicitly.
  if (!cleaned) await database?.close().catch(() => {});
  process.exit(1);
}
