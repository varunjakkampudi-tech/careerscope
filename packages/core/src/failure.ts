/**
 * Failure logging for queue and worker code. Logs carry only the error class name, a stable code when
 * one exists, and the identifiers of the work that failed. The message text is never logged: free-text
 * scrubbing cannot be made reliable, so the text is not written at all.
 */

import { logger } from './runtime.js';

/** Identifies the work that failed. All fields are optional because not every catch site knows them. */
export type FailureContext = {
  commandId?: string;
  executionId?: string;
  fence?: number;
  attempt?: number;
};

const safeToken = /^[A-Za-z0-9_.-]{1,64}$/;

/** A stable error code (for example a Postgres SQLSTATE or `ECONNRESET`); anything else is dropped. */
function safeCode(error: unknown) {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && safeToken.test(code) ? code : undefined;
}

/**
 * A startup rejection of an unsafe or missing setting. Its message names the variable and the rule
 * that failed, never a value, so it is the one error class whose message is logged. Every throw in
 * configuration code must use this class and must not interpolate a secret or a setting's value.
 */
export class ConfigurationError extends Error {
  override name = 'ConfigurationError';
}

/**
 * Returns the error class name and, when it has a stable string code, the code. The message, stack,
 * cause and any other field are never included, except the message of a `ConfigurationError`.
 * Non-Error values are reported by type only.
 */
export function describeError(error: unknown) {
  if (error instanceof Error) {
    const code = safeCode(error);
    return {
      errorName: safeToken.test(error.name) ? error.name : 'Error',
      ...(code ? { errorCode: code } : {}),
      ...(error instanceof ConfigurationError ? { errorMessage: error.message } : {}),
    };
  }
  return { errorName: typeof error };
}

/**
 * The pino `err` and `error` serialiser: name and code only, so a logged error never carries its
 * message. A `ConfigurationError` also carries its message, which is the operator's only clue.
 */
export function serializeError(error: unknown) {
  const { errorName, errorCode, errorMessage } = describeError(error) as {
    errorName: string;
    errorCode?: string;
    errorMessage?: string;
  };
  return {
    name: errorName,
    ...(errorCode ? { code: errorCode } : {}),
    ...(errorMessage ? { message: errorMessage } : {}),
  };
}

/** Serialisers for pino loggers: apply to both the `err` and `error` keys. */
export const errorSerializers = { err: serializeError, error: serializeError };

/**
 * Logs a caught error with its name, code and the command, execution, fence and attempt when known. Call it in a catch block before rethrowing or translating the error. Never pass request
 * bodies or personal data in `note`.
 */
export function logFailure(
  error: unknown,
  context: FailureContext = {},
  note = 'Operation failed',
  level: 'error' | 'warn' = 'error',
) {
  logger[level]({ ...describeError(error), ...context }, note);
}

let processHandlersInstalled = false;

/**
 * Routes uncaught exceptions and unhandled rejections through `logFailure` so Node never prints the
 * raw error text (which can carry a connection URL with its password) to stderr. Registers once.
 */
export function installProcessFailureHandlers() {
  if (processHandlersInstalled) return;
  processHandlersInstalled = true;
  const crash = (error: unknown) => {
    try {
      logFailure(error, {}, 'Process crashed');
    } finally {
      process.exitCode = 1;
      process.exit(1);
    }
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
}
