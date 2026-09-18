import { createHash } from 'node:crypto';

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

// Groups recurrences of the same failure so an admin can ask "how often does
// this happen and to whom" rather than eyeballing near-identical rows.
//
// Only stable characteristics go in. Timestamps, ids, owners and durations are
// deliberately excluded: include any of them and every occurrence fingerprints
// uniquely, which is the same as having no fingerprint at all.
export function errorFingerprint(input: {
  errorCode: string;
  service: string;
  route?: string | null;
  method?: string | null;
  errorClass?: string | null;
}) {
  const parts = [
    input.service,
    input.errorCode,
    input.method ?? '',
    // Route templates, never URLs -- '/api/leads/:id' groups, '/api/leads/abc' does not.
    input.route ?? '',
    input.errorClass ?? '',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

// Security-relevant events, kept distinct from operational activity. An
// investigation into "who tried to reach this account" must not have to be
// filtered out of ordinary request noise.
export const securityActions = [
  'security.login.success',
  'security.login.failure',
  'security.logout',
  'security.session.revoked',
  'security.password.changed',
  'security.csrf.rejected',
  'security.origin.rejected',
  'security.rate_limited',
  'security.admin.denied',
] as const;

export type SecurityAction = (typeof securityActions)[number];
