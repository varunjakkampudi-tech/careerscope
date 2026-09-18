export class Conflict extends Error {}

// Stable machine-readable failure identities.
//
// These exist so an admin investigating a report can filter on a value that
// never changes, instead of grepping human sentences that get reworded. The
// user-facing message stays sanitized and separate; only the code is stable.
//
// Never remove or repurpose a value here. Add one instead — an old diagnostic
// row still carries the meaning the code had when it was written.
export const errorCodes = [
  'validation_failed',
  'authentication_required',
  'origin_denied',
  'csrf_failed',
  'forbidden',
  'not_found',
  'revision_conflict',
  'idempotency_conflict',
  'rate_limited',
  'payload_too_large',
  'resume_storage_limit',
  'invalid_resume_upload',
  'service_unavailable',
  'internal_error',
] as const;

export type ErrorCode = (typeof errorCodes)[number];

// Whether retrying the same call unchanged could plausibly succeed. A
// validation failure cannot; a rate limit or a capacity refusal can.
const retryableCodes = new Set<ErrorCode>([
  'rate_limited',
  'resume_storage_limit',
  'service_unavailable',
  'internal_error',
]);

export function isRetryable(code: ErrorCode) {
  return retryableCodes.has(code as ErrorCode);
}
