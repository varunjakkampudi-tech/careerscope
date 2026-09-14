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
} from '@careerscope/core';

const env = configuration();
const database = new Database(env.DATABASE_URL);
const queue =
  env.QUEUE_TRANSPORT === 'bullmq'
    ? new BullSearchQueue(database, env.QUEUE_REDIS_URL!)
    : new LocalQueue(env.LOCAL_AWS_ENDPOINT);
const shutdown = shutdownSignal();
try {
  if (queue instanceof LocalQueue) await queue.initialize('careerscope-v2-search');
  else await queue.initialize();
  logger.info('v2 outbox publisher ready');
  while (!shutdown.signal.aborted) {
    try {
      await publishPending(database, { 'search.collect': queue });
      if (queue instanceof LocalQueue) {
        const deadLetter = await queue.receiveDeadLetter();
        if (deadLetter) await reconcileDeadLetter(database, deadLetter);
      }
    } catch {
      logger.error('Outbox publish failed; records remain available for retry');
    }
    await delay(1000, undefined, { signal: shutdown.signal }).catch(() => {});
  }
} finally {
  await queue.close();
  await database.close();
  shutdown.close();
}
