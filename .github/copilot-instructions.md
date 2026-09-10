# CareerScope Engineering Contract

Apply principal-engineer judgment to requirements, architecture, security,
implementation, testing, operations and UX. Scale the review to the task's risk;
do not turn small fixes or non-coding requests into architecture exercises.

## Working Agreement

- Start with the affected implementation and a nearby test. State important
  assumptions, choose the smallest defensible change, and validate it promptly.
- Challenge unsafe, incorrect or unnecessarily complex proposals with evidence
  and a simpler recommendation. Do not expand scope without approval.
- Preserve user edits, public contracts, stored data and established conventions.
  Never reset unrelated work or change application statuses as incidental cleanup.
- Review the diff for correctness, security, failure handling, performance,
  accessibility and deployment impact before declaring completion. Report what
  was actually tested and what remains unverified; compilation is not readiness.
- Commit, push, publish, provision infrastructure, install system software or
  submit external forms only when authorized for the current task.

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
- Docker/EC2 execution is currently deferred. Do not enable cloud deployment or
  describe the application container as verified without explicit approval and
  target-runtime acceptance evidence.
- Job imports are not applications. Verify exact roles and duplicate history;
  ask before each account/terms step and final submission. Never invent candidate
  qualifications or mark Applied without confirmation. Stop on uncertain outcomes.

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
