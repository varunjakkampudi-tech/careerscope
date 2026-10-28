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
/** Input is capped before any pattern runs so a huge message cannot make scrubbing expensive. */
const maxScrubInputLength = 2000;

/** A secret value: a quoted string (escapes honoured, spaces kept) or a bare run up to a delimiter. */
const secretValue = String.raw`(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;&]+)`;

/**
 * The same, also accepting JSON that was serialised into a string (backslash-escaped quotes). An escaped
 * quote opened with N backslashes closes only on a quote preceded by exactly N backslashes (groups 2 and 3
 * hold the opener) and followed by a delimiter or the end. Fail closed: when that close is missing or
 * ambiguous, and for a backslash-escaped quote inside a bare value, redaction runs from the value start to
 * the end of the line (a newline or the end of the input).
 */
const namedSecretValue = String.raw`(?:(\\+)"(?:(?!(?<!\\)\2")[^\r\n])*(?:(?<!\\)\2"(?=[\s,;}\])&]|$)|[^\r\n]*)|(\\+)'(?:(?!(?<!\\)\3')[^\r\n])*(?:(?<!\\)\3'(?=[\s,;}\])&]|$)|[^\r\n]*)|"(?:[^"\\]|\\.)*"(?=[\s,;}\])&]|$)|'(?:[^'\\]|\\.)*'(?=[\s,;}\])&]|$)|"[\s\S]*$|'[\s\S]*$|\\+["'][^\r\n]*|(?:[^\s,;&\\]|\\(?!["']))+(?:\\+["'][^\r\n]*)?)`;

/**
 * An email address. Every repetition is bounded (domain 253, final label 63, local part by the input cap),
 * and the match may only start at the start of a token (the lookbehind), so start positions never overlap
 * and the pattern stays linear on adversarial input. An overlong local part is still redacted whole.
 */
export const emailAddressPattern =
  /(?<![^\s@<>"'])[^\s@<>"']{1,2000}@[^\s@<>"']{1,253}\.[^\s@<>"']{2,63}/g;

const namedSecret = new RegExp(
  String.raw`\b([a-z0-9_-]*(?:token|secret|password|passwd|pwd|pass|passphrase|key|apikey|authorization|cookie|otp|code|sid|session|sessionid|sig|signature|auth|credential|csrf|xsrf|jwt|ticket|private)[a-z0-9_-]*)(?:\\*["'])?\s*[=:]\s*${namedSecretValue}`,
  'gi',
);
const proseSecret = new RegExp(
  String.raw`\b(password|passwd|passphrase|secret|token|credential)s?\b\s+(?:is|was)\s+${secretValue}`,
  'gi',
);

/** Removes emails, credentials, tokens and long opaque strings from an error message and bounds its length. */
export function scrubMessage(message: string) {
  return (
    message
      .slice(0, maxScrubInputLength)
      // Any scheme with credentials in the authority; the password may itself contain a slash.
      .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s@]*@[^\s]+/gi, '[url]')
      // The whole query string of an http(s) URL: signatures and tokens travel there.
      .replace(/(https?:\/\/[^\s?#]+)\?[^\s]*/gi, '$1?[redacted]')
      .replace(emailAddressPattern, '[email]')
      // Authorization and Proxy-Authorization lines, any scheme word ("Token abc"), through end of line.
      .replace(/\b(proxy-)?authorization["']?\s*[:=][^\r\n]*/gi, '$1authorization: [redacted]')
      // A Cookie or Set-Cookie header (or its JSON form) is redacted through the end of its line.
      .replace(/\b(set-cookie|cookie)["']?\s*[:=][^\r\n]*/gi, '$1: [redacted]')
      // Well-known token prefixes: AWS access key ids, GitHub, Slack and Stripe-style keys.
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted]')
      .replace(/\bgh[pousr]_[A-Za-z0-9]+/g, '[redacted]')
      .replace(/\bxox[a-z]-[A-Za-z0-9-]+/g, '[redacted]')
      .replace(/\bsk_(?:live|test)_[A-Za-z0-9]+/g, '[redacted]')
      .replace(/\bbearer\s+[^\s]+/gi, 'Bearer [token]')
      .replace(/\bbasic\s+[^\s]+/gi, 'Basic [token]')
      .replace(namedSecret, '$1=[redacted]')
      // A secret written after its name in prose ("password is hunter2").
      .replace(proseSecret, '$1 [redacted]')
      // JWT-shaped values: the dots split them into segments shorter than the opaque-string rule below.
      .replace(/\beyJ[\w-]*\.[\w-]+\.[\w-]*/g, '[jwt]')
      // A one-time code written after its name ("otp 123456", "code is 123456").
      .replace(/\b(otp|passcode|code|pin)\b(\s+(?:is|was))?\s+\d{4,10}\b/gi, '$1 [redacted]')
      // Mixed letter-and-digit strings of 20+ characters look like tokens.
      .replace(
        /\b(?=[A-Za-z0-9_+/=-]*[A-Za-z])(?=[A-Za-z0-9_+/=-]*\d)[A-Za-z0-9_+/=-]{20,}\b/g,
        '[redacted]',
      )
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
