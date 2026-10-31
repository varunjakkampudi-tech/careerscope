/**
 * Runtime configuration for the API and workers: environment validation, the Redis rate limiter and
 * the shutdown signal. Fails fast at startup on unsafe settings.
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
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
 * Heuristic screen for a generated secret. It cannot prove randomness: it only rejects values that
 * are easy to recognise as not random, and never echoes the value. A value is accepted only when
 * every rule holds:
 * - Form: hex (a string of only hex digits, at least 64 characters, even length) or base64/base64url
 *   (at least 43 characters). A hex-looking string is never reinterpreted as base64.
 * - Size: it decodes to at least 32 bytes.
 * - Character classes: the text uses at least two of lowercase letters, uppercase letters, digits and
 *   symbols (rejects, for example, a long all-lowercase passphrase that happens to be valid base64).
 * - Spread: at least 24 distinct byte values (32 random bytes average about 30; fewer than 24 is
 *   far in the tail, so a genuine secret is very unlikely to be refused).
 * - Not periodic: the bytes are not a repetition of a block of 1 to 16 bytes.
 * - Not arithmetic: consecutive bytes do not all differ by one constant step modulo 256 (rejects the
 *   counter 00 01 02 ... 1f and constant fill).
 * A value that passes can still be weak (for example a hand-picked string that avoids these
 * patterns); secrets must come from a CSPRNG, for example openssl rand -hex 32.
 */
export function isRandomSecret(value: string) {
  const text = value.trim();
  let bytes: Buffer;
  if (/^[0-9a-fA-F]+$/.test(text)) {
    if (text.length < 64 || text.length % 2 !== 0) return false;
    bytes = Buffer.from(text, 'hex');
  } else if (/^[A-Za-z0-9+/_-]{43,}={0,2}$/.test(text)) bytes = Buffer.from(text, 'base64');
  else return false;
  if (bytes.length < 32) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[+/_=-]/].filter((pattern) =>
    pattern.test(text),
  ).length;
  if (classes < 2) return false;
  if (new Set(bytes).size < 24) return false;
  for (let period = 1; period <= 16; period++) {
    if (bytes.every((byte, index) => byte === bytes[index % period])) return false;
  }
  const step = (bytes[1]! - bytes[0]! + 256) % 256;
  if (bytes.every((byte, index) => index === 0 || (byte - bytes[index - 1]! + 256) % 256 === step))
    return false;
  return true;
}

/**
 * Reads a secret from a mounted file (for example a Docker file secret) so it never sits in the
 * container environment or "docker inspect". The error names the variable, never the value or the
 * file content.
 */
function secretFromFile(name: string, path: string) {
  const content = readSecretFile(name, path).trim();
  if (!content || /\s/.test(content)) throw new Error(name + ' must contain a single token');
  return content;
}

/** The largest secret file accepted; a real secret here is a short token. */
const SECRET_FILE_MAX_BYTES = 4096;

/**
 * Reads a small secret file. It shares the resume key reader's file checks: `lstat` must show a
 * regular file (a symlink is refused), it is opened with O_NOFOLLOW where available and compared with
 * the earlier `lstat` to detect a swap, and it is at most 4096 bytes. The permission check is looser
 * than the resume key reader's: this reader refuses only group and other write (mask 0o022) on POSIX,
 * while the resume key reader refuses any group or other access (mask 0o077). It is looser because
 * Docker file secrets are mounted from host files that render-otp-secrets.sh and
 * render-redis-config.sh write as 0440 or 0444 inside a 0700 directory, so group or other read must
 * be allowed. Errors name only the variable, never the path or the content.
 */
function readSecretFile(name: string, path: string) {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.isSymbolicLink())
      throw new Error(name + ' must be a regular file');
    if (before.size > SECRET_FILE_MAX_BYTES) throw new Error(name + ' is too large');
    if (process.platform !== 'win32' && (before.mode & 0o022) !== 0)
      throw new Error(name + ' must not be writable by group or others');
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size)
      throw new Error(name + ' changed while being read');
    const buffer = Buffer.alloc(before.size);
    try {
      const read = readSync(descriptor, buffer, 0, buffer.length, 0);
      if (read !== buffer.length) throw new Error(name + ' could not be read');
      return buffer.toString('utf8');
    } finally {
      buffer.fill(0);
    }
  } catch (error) {
    // Only this function's own messages (which carry just the variable name) pass through.
    if (error instanceof Error && error.message.startsWith(name + ' ')) throw error;
    throw new Error(name + ' could not be read');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
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
export function configuration(
  source: NodeJS.ProcessEnv = process.env,
  options: { emailOtpSecrets?: boolean } = {},
) {
  if (source.QUEUE_TRANSPORT !== undefined)
    throw new Error('Use SEARCH_QUEUE_TRANSPORT to choose a supported Redis transport');
  // Only the API sends sign-in codes. Workers pass `emailOtpSecrets: false`: they still see the
  // non-secret OTP flags, but neither need nor receive the HMAC secret or the Resend key.
  const loadSecrets = options.emailOtpSecrets !== false;
  const input: NodeJS.ProcessEnv = { ...source };
  for (const name of ['EMAIL_OTP_HMAC_SECRET', 'RESEND_API_KEY'] as const) {
    const path = source[name + '_FILE'];
    if (!path || !loadSecrets) continue;
    if (source[name]) throw new Error('Set either ' + name + ' or ' + name + '_FILE, not both');
    input[name] = secretFromFile(name + '_FILE', path);
  }
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
      ...input,
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
    if (loadSecrets && (!env.EMAIL_OTP_HMAC_SECRET || !isRandomSecret(env.EMAIL_OTP_HMAC_SECRET)))
      throw new Error(
        'Email OTP requires a separate HMAC secret of at least 32 random bytes (64 hex or 43 base64 characters)',
      );
    if (loadSecrets && (!env.RESEND_API_KEY || env.RESEND_API_KEY.trim().length === 0))
      throw new Error('Email OTP requires RESEND_API_KEY');
    if (env.RESEND_FROM_EMAIL !== 'CareerScope <noreply@careerscope.tech>')
      throw new Error('Email OTP requires the approved CareerScope sender address');
  }
  // REDIS_PASSWORD_FILE keeps the password out of the environment (and `docker inspect`). The file is
  // always read and validated when set, even if the URLs already carry a password, so an unreadable,
  // empty or malformed file fails startup. Its value is used only for a URL that carries no password.
  if (source.REDIS_PASSWORD_FILE) {
    const password = readSecretFile('REDIS_PASSWORD_FILE', source.REDIS_PASSWORD_FILE).trim();
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
