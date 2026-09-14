import { createClient } from 'redis';
import pino from 'pino';
import { z } from 'zod';
import { localEndpoint } from './queue.js';

export const logger = pino({ level: 'info', base: undefined });

function localUrl(value: string, protocols: string[]) {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('v2 runtime endpoints must use local services');
  }
  return value;
}

export function configuration(source: NodeJS.ProcessEnv = process.env) {
  const env = z
    .object({
      DATABASE_URL: z.string().min(1),
      REDIS_URL: z.string().min(1),
      LOCAL_AWS_ENDPOINT: z.string().min(1),
      APP_ORIGIN: z.string().min(1),
      QUEUE_TRANSPORT: z.enum(['sqs', 'bullmq']).default('sqs'),
      QUEUE_REDIS_URL: z.string().min(1).optional(),
    })
    .parse(source);
  localUrl(env.DATABASE_URL, ['postgres:', 'postgresql:']);
  localUrl(env.REDIS_URL, ['redis:']);
  localEndpoint(env.LOCAL_AWS_ENDPOINT);
  if (env.QUEUE_TRANSPORT === 'bullmq') {
    if (!env.QUEUE_REDIS_URL || env.QUEUE_REDIS_URL === env.REDIS_URL) {
      throw new Error('BullMQ requires a separate QUEUE_REDIS_URL');
    }
    localUrl(env.QUEUE_REDIS_URL, ['redis:']);
  }
  const origin = new URL(env.APP_ORIGIN);
  localUrl(env.APP_ORIGIN, ['http:', 'https:']);
  if (origin.origin !== env.APP_ORIGIN) throw new Error('APP_ORIGIN must be an origin');
  return env;
}

export async function rateLimiter(url: string, prefix = 'careerscope:v2:rate:') {
  localUrl(url, ['redis:']);
  const client = createClient({
    url,
    socket: {
      connectTimeout: 3000,
      reconnectStrategy: (attempt) => (attempt < 3 ? Math.min(1000, attempt * 200) : false),
    },
    disableOfflineQueue: true,
  });
  client.on('error', () => logger.error('Redis connection failed'));
  await client.connect();
  return {
    client,
    async consume(key: string, limit: number, seconds: number) {
      const count = await client.eval(
        `local count = redis.call('INCR', KEYS[1])
        if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
        return count`,
        { keys: [`${prefix}${key}`], arguments: [String(seconds)] },
      );
      return Number(count) <= limit;
    },
    async close() {
      if (client.isOpen) await client.quit();
    },
  };
}

export function shutdownSignal() {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return {
    signal: controller.signal,
    close() {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
    },
  };
}
