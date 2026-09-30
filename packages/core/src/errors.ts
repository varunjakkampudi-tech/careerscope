// CS-35: every Conflict now carries a stable, machine-readable `code` so the
// client can offer the right recovery action instead of one generic
// "something conflicted" message for every 409. `code` defaults to the
// generic 'CONFLICT' for internal/worker-only invariants that never reach a
// route response (see database.ts/resumes.ts's command-pipeline checks) -
// only conflicts actually reachable through a real API route are given a
// distinct code, per this ticket's own bounded scope (revision conflict,
// idempotency-key reuse, missing-target-role paths), not a blanket rewrite
// of every internal throw site.
export class Conflict extends Error {
  readonly code: string;
  constructor(message: string, code = 'CONFLICT') {
    super(message);
    this.code = code;
  }
}
