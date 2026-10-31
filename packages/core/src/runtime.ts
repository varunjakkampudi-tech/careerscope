/**
 * Runtime configuration for the API and workers: environment validation, the Redis rate limiter and
 * the shutdown signal. Fails fast at startup on unsafe settings.
 */

import { readFileSync } from 'node:fs';
import { createClient } from 'redis';
import pino from 'pino';
import { z } from 'zod';
import { logFailure, serializeError } from './failure.js';
import { localEndpoint } from './queue.js';

/** Shared pino logger. `base: undefined` omits pid and hostname from every line. */
export const logger = pino({
  level: 'info',
  base: undefined,
  // Error objects are logged as name and code only; the message text is never written.
  // Wrapped so the cyclic import of failure.ts is only dereferenced when a line is written.
  serializers: { err: (error) => serializeError(error), error: (error) => serializeError(error) },
});

/** Returns `value` unchanged if it uses an allowed protocol and a loopback host; otherwise throws. */
function localUrl(value: string, protocols: string[]) {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('v2 runtime endpoints must use local services');
  }
  return value;
}

/**
 * True when the value is hex (at least 64 characters) or base64/base64url (at least 43 characters)
 * that decodes to at least 32 bytes which look random: not a short repeating pattern and with a
 * wide spread of byte values. Random 32 bytes have about 28 distinct values; fewer than 16 is
 * astronomically unlikely, so this rejects repeated, dictionary-like and counter-like secrets without
 * ever echoing the value.
 */
export function isRandomSecret(value: string) {
  const text = value.trim();
  let bytes: Buffer;
  // A string made only of hex digits is hex, never reinterpreted as base64 (which would overstate its entropy).
  if (/^[0-9a-fA-F]+$/.test(text)) {
    if (text.length < 64 || text.length % 2 !== 0) return false;
    bytes = Buffer.from(text, 'hex');
  } else if (/^[A-Za-z0-9+/_-]{43,}={0,2}$/.test(text)) bytes = Buffer.from(text, 'base64');
  else return false;
  if (bytes.length < 32) return false;
  if (new Set(bytes).size < 16) return false;
  for (let period = 1; period <= 16; period++) {
    if (bytes.every((byte, index) => byte === bytes[index % period])) return false;
  }
  return true;
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

/**
 * Adds the password to a Redis URL that has none. Used with REDIS_PASSWORD_FILE so the secret is read
 * from a mounted file at startup and exists only in process memory, never in the container environment.
 */
function withRedisPassword(value: string, password: string) {
  const url = new URL(value);
  if (!url.password) url.password = password;
  return url.toString();
}

/**
 * Parses and validates the environment. Rejects unsafe combinations: non-loopback database or Redis
 * hosts, queue and rate-limit Redis sharing one URL, registration without OTP and versioned legal
 * documents, and OTP without a long HMAC secret.
 */
export function configuration(source: NodeJS.ProcessEnv = process.env) {
  if (source.QUEUE_TRANSPORT !== undefined)
    throw new Error('Use SEARCH_QUEUE_TRANSPORT to choose a supported Redis transport');
  const env = z
    .object({
      DATABASE_URL: z.string().min(1),
      REDIS_URL: z.string().min(1),
      QUEUE_REDIS_URL: z.string().min(1).default('redis://127.0.0.1:56480'),
      APP_ORIGIN: z.string().min(1),
      NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
      DEPLOYMENT_ENVIRONMENT: z
        .enum(['development', 'staging', 'production'])
        .default('development'),
      REGISTRATION_ENABLED: z.enum(['true', 'false']).default('false'),
      EMAIL_OTP_ENABLED: z.enum(['true', 'false']).default('false'),
      EMAIL_OTP_HMAC_SECRET: z.string().optional(),
      RESEND_API_KEY: z.string().optional(),
      RESEND_FROM_EMAIL: z.string().default('CareerScope <noreply@careerscope.tech>'),
      LEGAL_TERMS_VERSION: z.string().trim().max(128).optional(),
      LEGAL_TERMS_URL: z.union([z.string().url(), z.literal('')]).optional(),
      LEGAL_PRIVACY_VERSION: z.string().trim().max(128).optional(),
      LEGAL_PRIVACY_URL: z.union([z.string().url(), z.literal('')]).optional(),
      LEGAL_MARKETING_VERSION: z.string().trim().max(128).optional(),
      SEARCH_QUEUE_TRANSPORT: z.enum(['redis', 'bullmq']).default('redis'),
      SEARCH_QUEUE_REDIS_URL: z.string().min(1).optional(),
    })
    .parse({
      ...source,
      DEPLOYMENT_ENVIRONMENT:
        source.DEPLOYMENT_ENVIRONMENT ??
        (source.NODE_ENV === 'production' ? 'production' : 'development'),
    });
  localUrl(env.DATABASE_URL, ['postgres:', 'postgresql:']);
  localUrl(env.REDIS_URL, ['redis:']);
  localEndpoint(env.QUEUE_REDIS_URL);
  if (env.QUEUE_REDIS_URL === env.REDIS_URL)
    throw new Error('Queue Redis must be isolated from rate limiting');
  if (env.SEARCH_QUEUE_TRANSPORT === 'bullmq') {
    if (!env.SEARCH_QUEUE_REDIS_URL || env.SEARCH_QUEUE_REDIS_URL === env.REDIS_URL) {
      throw new Error('BullMQ requires a separate SEARCH_QUEUE_REDIS_URL');
    }
    localUrl(env.SEARCH_QUEUE_REDIS_URL, ['redis:']);
  }
  appOrigin(env.APP_ORIGIN);
  if (env.REGISTRATION_ENABLED === 'true') {
    if (env.EMAIL_OTP_ENABLED !== 'true') throw new Error('Registration requires email OTP');
    if (
      !env.LEGAL_TERMS_VERSION ||
      !env.LEGAL_TERMS_URL ||
      !env.LEGAL_PRIVACY_VERSION ||
      !env.LEGAL_PRIVACY_URL ||
      !env.LEGAL_MARKETING_VERSION
    )
      throw new Error('Registration requires versioned legal documents');
    for (const [name, value] of [
      ['LEGAL_TERMS_URL', env.LEGAL_TERMS_URL],
      ['LEGAL_PRIVACY_URL', env.LEGAL_PRIVACY_URL],
    ] as const) {
      if (new URL(value).protocol !== 'https:') throw new Error(`${name} must use HTTPS`);
    }
  }
  if (env.DEPLOYMENT_ENVIRONMENT === 'production' && env.EMAIL_OTP_ENABLED !== 'true')
    throw new Error('Production requires email OTP sign-in to be enabled');
  if (env.EMAIL_OTP_ENABLED === 'true') {
    if (!env.EMAIL_OTP_HMAC_SECRET || !isRandomSecret(env.EMAIL_OTP_HMAC_SECRET))
      throw new Error(
        'Email OTP requires a separate HMAC secret of at least 32 random bytes (64 hex or 43 base64 characters)',
      );
    if (!env.RESEND_API_KEY || env.RESEND_API_KEY.trim().length === 0)
      throw new Error('Email OTP requires RESEND_API_KEY');
    if (env.RESEND_FROM_EMAIL !== 'CareerScope <noreply@careerscope.tech>')
      throw new Error('Email OTP requires the approved CareerScope sender address');
  }
  // REDIS_PASSWORD_FILE keeps the password out of the environment (and `docker inspect`). A password
  // already present in a URL is left alone; an unreadable or empty file fails startup.
  if (source.REDIS_PASSWORD_FILE) {
    const password = readFileSync(source.REDIS_PASSWORD_FILE, 'utf8').trim();
    if (!/^[A-Za-z0-9._~-]{16,}$/.test(password))
      throw new Error(
        'REDIS_PASSWORD_FILE must contain a plain password of at least 16 characters',
      );
    env.REDIS_URL = withRedisPassword(env.REDIS_URL, password);
    env.QUEUE_REDIS_URL = withRedisPassword(env.QUEUE_REDIS_URL, password);
    if (env.SEARCH_QUEUE_REDIS_URL)
      env.SEARCH_QUEUE_REDIS_URL = withRedisPassword(env.SEARCH_QUEUE_REDIS_URL, password);
  }
  return env;
}

/**
 * Redis-backed fixed-window rate limiter. The client fails fast (no offline queue, short reconnect)
 * so a Redis outage surfaces as an error to the caller instead of hanging requests.
 */
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
  client.on('error', (error) => logFailure(error, {}, 'Redis connection failed'));
  await client.connect();
  return {
    client,
    /**
     * Fixed-window counter. With `peek`, the counter is not incremented and the
     * result is true while fewer than `limit` events have been recorded.
     */
    async consume(key: string, limit: number, seconds: number, peek = false) {
      const count = await client.eval(
        `if ARGV[2] == '1' then return tonumber(redis.call('GET', KEYS[1]) or '0') end
        local count = redis.call('INCR', KEYS[1])
        if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
        return count`,
        { keys: [`${prefix}${key}`], arguments: [String(seconds), peek ? '1' : '0'] },
      );
      return peek ? Number(count) < limit : Number(count) <= limit;
    },
    async close() {
      if (client.isOpen) await client.quit();
    },
  };
}

/** AbortSignal that fires on SIGINT or SIGTERM. Call `close()` to remove the handlers. */
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
