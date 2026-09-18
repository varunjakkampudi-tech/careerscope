import { setTimeout as delay } from 'node:timers/promises';
import {
  Database,
  BullSearchQueue,
  LocalQueue,
  configuration,
  consumeMessage,
  logger,
  shutdownSignal,
} from '@careerscope/core';
import { searchHandler } from './collect.js';

const env = configuration();
const database = new Database(env.DATABASE_URL);
const shutdown = shutdownSignal();
try {
  if (env.SEARCH_QUEUE_TRANSPORT === 'bullmq') {
    const queue = new BullSearchQueue(database, env.SEARCH_QUEUE_REDIS_URL!);
    let worker: ReturnType<BullSearchQueue['worker']> | undefined;
    try {
      await queue.initialize();
      worker = queue.worker(searchHandler(database), shutdown.signal);
      await worker.waitUntilReady();
      logger.info('v2 BullMQ search worker ready');
      while (!shutdown.signal.aborted) {
        await delay(1000, undefined, { signal: shutdown.signal }).catch(() => {});
      }
    } finally {
      worker?.cancelAllJobs('Worker stopping');
      await worker?.close();
      await queue.close();
    }
  } else {
    const queue = new LocalQueue(env.LOCAL_AWS_ENDPOINT);
    try {
      await queue.initialize('careerscope-v2-search');
      logger.info('v2 search worker ready');
      while (!shutdown.signal.aborted) {
        try {
          const message = await queue.receive(shutdown.signal);
          if (message)
            await consumeMessage(
              database,
              queue,
              message,
              'search.collect',
              searchHandler(database),
              shutdown.signal,
            );
        } catch {
          if (shutdown.signal.aborted) break;
          logger.error(
            'Search delivery failed; message retained for retry or dead-letter handling',
          );
          await delay(1000, undefined, { signal: shutdown.signal }).catch(() => {});
        }
      }
    } finally {
      queue.close();
    }
  }
} finally {
  await database.close();
  shutdown.close();
}
