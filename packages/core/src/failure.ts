/**
 * Failure logging for queue and worker code. Keeps the cause of an error visible in logs without
 * recording personal data: messages are scrubbed of emails, URLs with credentials, bearer tokens,
 * key=value secrets and long opaque strings before they are written.
 */

import { logger } from './runtime.js';

/** Identifies the work that failed. All fields are optional because not every catch site knows them. */
export type FailureContext = {
  commandId?: string;
  executionId?: string;
  fence?: number;
  attempt?: number;
};

const maxMessageLength = 300;

/** Removes emails, credentials, tokens and long opaque strings from an error message and bounds its length. */
export function scrubMessage(message: string) {
  return (
    message
      .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@[^\s]+/gi, '[url]')
      .replace(/[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g, '[email]')
      // A Cookie or Set-Cookie header is redacted through the end of its line, attributes included.
      .replace(/\b(set-cookie|cookie)\s*:[^\r\n]*/gi, '$1: [redacted]')
      .replace(/\bbearer\s+[^\s]+/gi, 'Bearer [token]')
      .replace(/\bbasic\s+[^\s]+/gi, 'Basic [token]')
      .replace(
        /\b([a-z0-9_-]*(?:token|secret|password|passwd|key|authorization|cookie|otp|code|sid|session|sessionid|sig|signature|auth|credential)[a-z0-9_-]*)["']?\s*[=:]\s*[^\s,;&]+/gi,
        '$1=[redacted]',
      )
      // A secret written after its name in prose ("password is hunter2").
      .replace(
        /\b(password|passwd|passphrase|secret|token|credential)s?\b\s+(?:is|was)\s+[^\s,;&]+/gi,
        '$1 [redacted]',
      )
      // JWT-shaped values: the dots split them into segments shorter than the opaque-string rule below.
      .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]*/g, '[jwt]')
      // A one-time code written after its name ("otp 123456", "code is 123456").
      .replace(/\b(otp|passcode|code|pin)\b(\s+(?:is|was))?\s+\d{4,10}\b/gi, '$1 [redacted]')
      .replace(/\b[A-Za-z0-9_+/=-]{32,}\b/g, '[redacted]')
      .slice(0, maxMessageLength)
  );
}

/** Returns the error name and a scrubbed message. Non-Error values are reported by type only. */
export function describeError(error: unknown) {
  if (error instanceof Error) {
    return { errorName: error.name, errorMessage: scrubMessage(error.message) };
  }
  return { errorName: typeof error, errorMessage: '' };
}

/**
 * Logs a caught error with its name, a scrubbed message and the command, execution, fence and attempt
 * when known. Call it in a catch block before rethrowing or translating the error. Never pass request
 * bodies or personal data in `note`.
 */
export function logFailure(
  error: unknown,
  context: FailureContext = {},
  note = 'Operation failed',
) {
  logger.error({ ...describeError(error), ...context }, note);
}
