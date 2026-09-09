/**
 * The process logger.
 *
 * Two things here are deliberate rather than incidental:
 *
 *  - **Redaction is configured once, at construction.** `x-api-key` is the app's
 *    only credential and it arrives on every authenticated request, so a logger
 *    that prints request headers prints the key on every line. Fastify's request
 *    serializer includes headers by default; the redact list below is what stops
 *    that. Adding a header to the auth path means adding it here too.
 *  - **`pino-pretty` is a dev dependency and is loaded defensively.** A
 *    production image installed with `--omit=dev` does not have it, and a
 *    transport that cannot be resolved takes the process down inside a worker
 *    thread where a try/catch around `pino()` would not catch it. Resolving the
 *    specifier first turns that into a silent fall back to JSON, which is the
 *    right output for a production box anyway.
 */

import { pino, type Logger, type LoggerOptions } from 'pino';

export type { Logger };

/** Header values that must never reach a log line, in Fastify's shape and flat. */
const REDACT_PATHS = [
  'req.headers["x-api-key"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers["x-api-key"]',
  'headers.authorization',
  'headers.cookie',
  'req.body.password',
  'body.password',
  'res.headers["set-cookie"]',
  'headers["set-cookie"]',
];

export interface LoggerConfig {
  level: string;
  /** Pretty output is for a terminal; anything shipping logs wants JSON. */
  pretty: boolean;
}

export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // ISO time costs a few microseconds and saves reading epoch millis by hand
    // in a terminal at 2am.
    timestamp: pino.stdTimeFunctions.isoTime,
    base: undefined,
  };

  if (config.pretty && canResolve('pino-pretty')) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' },
      },
    });
  }

  return pino(options);
}

/**
 * Whether a bare specifier resolves from here.
 *
 * `import.meta.resolve` is synchronous and does not execute the module, which is
 * exactly what is needed to decide whether pino may spawn a transport worker for
 * it. It throws rather than returning null when resolution fails.
 */
function canResolve(specifier: string): boolean {
  try {
    import.meta.resolve(specifier);
    return true;
  } catch {
    return false;
  }
}
