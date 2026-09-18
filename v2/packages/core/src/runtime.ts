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

// The browser-facing origin is the one value that must be public in a deployed
// installation: it is compared against the Origin header and decides whether the
// session cookie carries Secure. Anything that is not loopback must be https, so
// the cookie can never silently lose Secure behind a real hostname.
function appOrigin(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('APP_ORIGIN must be http(s)');
  if (url.origin !== value) throw new Error('APP_ORIGIN must be an origin');
  const loopback = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if (!loopback && url.protocol !== 'https:') {
    throw new Error('A public APP_ORIGIN must use https');
  }
  return value;
}

export function configuration(source: NodeJS.ProcessEnv = process.env) {
  // The alternative transport only ever covered the search queue: the adapter is
  // BullSearchQueue and the files worker dispatches resume parsing over SQS
  // unconditionally. The old QUEUE_TRANSPORT name claimed more than that, so it
  // is rejected outright rather than silently reinterpreted.
  if (source.QUEUE_TRANSPORT !== undefined || source.QUEUE_REDIS_URL !== undefined) {
    throw new Error(
      'QUEUE_TRANSPORT/QUEUE_REDIS_URL were renamed to SEARCH_QUEUE_TRANSPORT/SEARCH_QUEUE_REDIS_URL. ' +
        'They select the search queue transport only; resume parsing always uses LOCAL_AWS_ENDPOINT.',
    );
  }
  const env = z
    .object({
      DATABASE_URL: z.string().min(1),
      REDIS_URL: z.string().min(1),
      LOCAL_AWS_ENDPOINT: z.string().min(1),
      APP_ORIGIN: z.string().min(1),
      REGISTRATION_ENABLED: z.enum(['true', 'false']).default('false'),
      SEARCH_QUEUE_TRANSPORT: z.enum(['sqs', 'bullmq']).default('sqs'),
      SEARCH_QUEUE_REDIS_URL: z.string().min(1).optional(),
    })
    .parse(source);
  localUrl(env.DATABASE_URL, ['postgres:', 'postgresql:']);
  localUrl(env.REDIS_URL, ['redis:']);
  localEndpoint(env.LOCAL_AWS_ENDPOINT);
  if (env.SEARCH_QUEUE_TRANSPORT === 'bullmq') {
    if (!env.SEARCH_QUEUE_REDIS_URL || env.SEARCH_QUEUE_REDIS_URL === env.REDIS_URL) {
      throw new Error('BullMQ requires a separate SEARCH_QUEUE_REDIS_URL');
    }
    localUrl(env.SEARCH_QUEUE_REDIS_URL, ['redis:']);
  }
  appOrigin(env.APP_ORIGIN);
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
