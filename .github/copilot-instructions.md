# CareerScope Engineering Contract

Apply principal-engineer judgment to requirements, architecture, security,
implementation, testing, operations and UX. Scale the review to the task's risk;
do not turn small fixes or non-coding requests into architecture exercises.

## Working Agreement

- Understand before modifying. Start with the affected implementation and a
  nearby test. State important assumptions, choose the smallest defensible
  change, and validate it promptly.
- Challenge unsafe, incorrect or unnecessarily complex proposals with evidence
  and a simpler recommendation. Do not expand scope without approval.
- Preserve user edits, public contracts, stored data and established conventions.
  Never reset unrelated work or change application statuses as incidental cleanup.
- Review the diff for correctness, security, failure handling, performance,
  accessibility and deployment impact before declaring completion. Report what
  was actually tested and what remains unverified; compilation is not readiness.
- Commit, push, publish, provision infrastructure, install system software or
  submit external forms only when authorized for the current task.

## Before Any Meaningful Change

Inspect the affected architecture, trace the full data flow, search for an
existing implementation before writing a new one, identify callers and tests,
and name the failure modes. Then implement, verify, review the diff, and update
documentation if behaviour or architecture changed.

## Non-Negotiables

- Preserve API contracts, database invariants, transaction boundaries,
  idempotency, crash consistency and queue/outbox semantics.
- Never weaken authentication, authorization, rate limits, Argon2 cost,
  validation, encryption or security headers to make something pass.
- Never expose secrets. Do not log credentials, tokens, resume content, full
  URLs or request bodies. Validate all external input.
- Treat retries, timeouts, cancellation and partial failure as first-class.
  Do not silently swallow errors.
- Do not use `any` to hide a type problem without an explicit justification.
- Do not disable a lint, type or test rule to get CI green. Do not delete or
  weaken a test because it fails, and never edit a test to mask a regression.
- Do not introduce a duplicate utility, an unnecessary dependency, or an
  abstraction for a single call site. Respect module boundaries.
- Do not claim completion without evidence.

## Project Boundaries

- Use Node.js >=24, npm workspaces and TypeScript project references. Keep the
  modular monolith: Fastify/SQLite API, React/Vite UI and focused shared packages.
- Preserve ownership in `apps/api`, `apps/web`, `packages/*`, `mobile-site`,
  `scripts` and `infra`. Reuse existing validators, repositories and UI primitives.
- GitHub Pages is a separate static artifact with public jobs and an encrypted
  read-only admin. It does not host the API, run searches or execute Copilot.
- Keep personal data, resumes, databases, credentials, browser state, generated
  builds and Repomix output out of Git and public artifacts. Preserve snapshot
  allowlists and the clean-worktree publication guard.
- The v2 stack is deployed on a single Hostinger VPS behind Caddy and served at
  `https://careerscope.tech`. Use `infra/v3` for host provisioning, deployment and
  live verification. Do not provision additional infrastructure, change DNS or
  widen public exposure without explicit approval.
- Job imports are not applications. Verify exact roles and duplicate history;
  ask before each account/terms step and final submission. Never invent candidate
  qualifications or mark Applied without confirmation. Stop on uncertain outcomes.

## Skills

Project-local skills live in `.github/skills`. Domain skills — architecture,
discovery, matching, resume storage, outbox/queue, security, deployment and
verification — carry the invariants that are easiest to break; consult the
relevant one before changing that area.

When a task needs a capability the installed skills do not cover, find the
smallest relevant skill, read it and its resources in full, check for scripts,
remote execution and destructive commands, reject anything conflicting with the
rules above, install it project-scoped and pinned, and record why. Never install
a catalog wholesale or trust a skill because its name sounds relevant. See
`.github/skills/README.md`.

## Verification And References

- Start with a focused regression test. For broad code changes or a release, run
  `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and
  `npm run format:check`. Add the relevant browser, Pages and runtime gates.
- Prefer isolated synthetic data; never run destructive tests against owner data.
  Do not hide missing prerequisites, skipped tests or external-service failures.
- Report results concisely: changes, verification and remaining risks. Give
  findings first for reviews; use architecture/trade-off sections only when useful.
- Consult [architecture](../docs/ARCHITECTURE.md),
  [operations](../docs/RUNBOOK.md), [applications](../docs/APPLICATIONS.md),
  [browser imports](../docs/BROWSER-IMPORT.md) and
  [release scope](../docs/RELEASE-REVIEW.md) when relevant. Do not load every
  document for every request.
