---
name: careerscope-verification
description: 'Which command proves which claim, and the evidence standard for saying something works. Use before reporting a change as done, and whenever choosing what to run after an edit.'
---

# CareerScope Verification

## Purpose

The recurring failure mode on this project is declaring victory on a green
build. Compilation is not readiness. This skill maps each claim to the command
that actually supports it, so a report can cite evidence instead of confidence.

## When to use

- Before stating that a change works
- When choosing what to re-run after an edit
- When writing a completion report

## Command to claim

| Command                                   | What it actually proves                                         |
| ----------------------------------------- | --------------------------------------------------------------- |
| `npm run typecheck`                       | Types resolve. Nothing about behaviour.                         |
| `npm run lint`                            | Style and a few correctness rules.                              |
| `npm run format:check`                    | Formatting only.                                                |
| `npm run build`                           | It compiles and bundles.                                        |
| `npm test`                                | Root V1 behaviour. Expect 1046 passed / 1 skipped.              |
| `npm --prefix v2 test`                    | V2 behaviour. Expect 47 passed.                                 |
| `npm run pages:test`                      | Static Pages pipeline. Expect 21 passed.                        |
| `npm run test:ui`                         | Three-browser UI, axe, 320 px reflow, keyboard.                 |
| `npm run test:full-disk`                  | Real 2 MB tmpfs exhaustion, typed 507, no stranded temporaries. |
| `npm --prefix v2 run test:crash-recovery` | Four real `SIGKILL` phases.                                     |
| `npm --prefix v2 run test:performance`    | Sustained concurrent load with asserted thresholds.             |
| `npm audit --omit=dev`                    | Known advisories in shipped dependencies.                       |
| `infra/v3/check-live-origin.sh`           | Cookie attributes and CSRF on the real origin.                  |
| `infra/v3/check-live-flow.mjs`            | End-to-end workspace flow on the real origin.                   |

## Scope your run

Start with the narrowest test that covers the change, then widen. A full sweep
belongs before a release or after a broad change, not after every edit.

Do **not** report a previously passing result for a suite your change could have
affected. Re-run it.

## Evidence standard

State what was run and what it returned. Prefer numbers to adjectives:

- Good: "V2 47/47; full-disk reports `strandedTemporaries=0`,
  `reservedBytesAfterFailure=0`."
- Bad: "Everything passes and the storage layer is solid."

Report what was **not** verified with equal prominence. If a gate needs a human,
external credentials or a destination that does not exist, say so and name the
exact evidence that would close it.

## Prohibited

- Deleting or skipping a failing test to get a green run
- Editing a test to match broken behaviour instead of fixing the behaviour
- Loosening a threshold, a security parameter or a timeout budget to pass
- Simulating an external condition and reporting it as real verification
- Claiming a production deployment works without touching the deployed origin
- The phrase "production ready" used in place of evidence

Raising a _test timeout_ is acceptable when the assertion is about correctness
rather than latency — this was done deliberately for three Argon2id auth tests.
Lowering the Argon2 cost instead would not have been.

## Known anomaly

One root suite run reported a single failure out of 1047 while heavy concurrent
Docker work was running; it did not reproduce across three subsequent runs and
the failing test was not captured. Treat this as an open validation anomaly, not
a resolved issue, until it is identified.

## Synthetic data only

Never run destructive verification against the owner's real data. The live flow
script creates throwaway `verify-*` accounts and must be followed by
`purge-verification-accounts.sh`.
