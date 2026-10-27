/**
 * Domain error for state conflicts (revision mismatch, idempotency-key reuse, missing target).
 * Thrown by `core` services and mapped to HTTP 409 by the API.
 */

/**
 * A request conflicts with current state. `code` is a stable, machine-readable value the client
 * uses to offer the right recovery action. It defaults to `'CONFLICT'` for internal invariants
 * that never reach a route response; only conflicts reachable through an API route carry a
 * distinct code.
 */
export class Conflict extends Error {
  readonly code: string;
  constructor(message: string, code = 'CONFLICT') {
    super(message);
    this.code = code;
  }
}
