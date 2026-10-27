/**
 * The one error envelope every failed API response uses:
 * `{ code, message, requestId, details? }`.
 *
 * `code` is a stable machine-readable string. For a 409 it is the `Conflict.code` the web client
 * maps to a recovery action; every other status has a fixed default below. `message` is client-safe
 * text. `requestId` correlates the response with the server log. `details` is optional and holds
 * structured, non-private context (for a validation failure: the offending field paths and issue
 * codes, never the submitted values).
 */

export type ErrorDetails = Record<string, unknown>;

export type ErrorEnvelope = {
  code: string;
  message: string;
  requestId: string;
  details?: ErrorDetails;
};

/** Default machine code per HTTP status. Statuses not listed use `REQUEST_FAILED`. */
export const defaultErrorCodes: Readonly<Record<number, string>> = {
  400: 'INVALID_REQUEST',
  401: 'AUTHENTICATION_REQUIRED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  408: 'REQUEST_TIMEOUT',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
  507: 'STORAGE_LIMIT_REACHED',
};

/** Default client-safe message per HTTP status. */
export const defaultErrorMessages: Readonly<Record<number, string>> = {
  400: 'Invalid request',
  401: 'Authentication required',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  408: 'Request timeout',
  409: 'Idempotency conflict',
  413: 'Request too large',
  415: 'Unsupported media type',
  429: 'Too many requests',
  500: 'Service unavailable',
  503: 'Service temporarily unavailable',
  507: 'Resume storage capacity reached',
};

export const defaultErrorCode = (status: number) => defaultErrorCodes[status] ?? 'REQUEST_FAILED';
export const defaultErrorMessage = (status: number) =>
  defaultErrorMessages[status] ?? 'Request failed';

export const errorEnvelope = (
  status: number,
  requestId: string,
  options: { code?: string; message?: string; details?: ErrorDetails } = {},
): ErrorEnvelope => ({
  code: options.code ?? defaultErrorCode(status),
  message: options.message ?? defaultErrorMessage(status),
  requestId,
  ...(options.details ? { details: options.details } : {}),
});
