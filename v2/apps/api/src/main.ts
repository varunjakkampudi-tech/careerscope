import { Database, configuration, logger, rateLimiter, shutdownSignal } from '@careerscope/core';
import { createApp } from './app.js';

const env = configuration();
const database = new Database(env.DATABASE_URL);
const limiter = await rateLimiter(env.REDIS_URL);
const app = await createApp(database, env.APP_ORIGIN, limiter.consume);
const shutdown = shutdownSignal();
try {
  await app.listen({ host: '127.0.0.1', port: 5390 });
  logger.info({ port: 5390 }, 'v2 API listening');
  if (!shutdown.signal.aborted)
    await new Promise<void>((resolve) =>
      shutdown.signal.addEventListener('abort', () => resolve(), { once: true }),
    );
} finally {
  await app.close();
  await limiter.close();
  await database.close();
  shutdown.close();
}
