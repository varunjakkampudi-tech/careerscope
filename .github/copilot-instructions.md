# CareerScope Engineering Contract

Apply principal-engineer judgment to requirements, architecture, security,
implementation, testing, operations and UX. Scale the review to the task's risk;
do not turn small fixes or non-coding requests into architecture exercises.

## Start Here

Before the first change in a session, establish actual state rather than
assuming it:

1. Read [docs/PROJECT-STATE.md](../docs/PROJECT-STATE.md). It explains the
   V1/V2 split, branch semantics and what is deployed. Most mistakes on this
   repository come from editing V1 while thinking about V2.
2. Read the architecture for the stack you are touching —
   [V1](../docs/ARCHITECTURE.md) or [V2](../v2/ARCHITECTURE.md).
3. Check the current branch and commit: `git branch --show-current`,
   `git rev-parse HEAD`, `git status --porcelain`.
4. Check what is actually deployed:
   `infra/v3/check-provenance.sh`. Local `HEAD` and the deployed revision are
   often legitimately different — confirm, never assume.
5. Read [docs/TESTING.md](../docs/TESTING.md) and run the nearest test before
   you change anything, so you know what was already failing.
6. Read `.env.example` for configuration. Never read or print a real `.env`.
7. Read [docs/KNOWN-LIMITATIONS.md](../docs/KNOWN-LIMITATIONS.md) before
   reporting a defect — it may already be recorded, with a reason.

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
- A validator, review verdict or progress record must never be made green by
  changing the interpretation of the condition it was created to enforce.
- Prove a new check can fail before trusting that it passes: valid input must
  pass, invalid input must fail, and **malformed input must fail**. Never treat
  a parse failure, a missing file or an empty read as "nothing to report" —
  that is how six checks in this repository passed while unable to look.
- Do not introduce a duplicate utility, an unnecessary dependency, or an
  abstraction for a single call site. Respect module boundaries.
- Do not claim completion without evidence.

## Operational Non-Negotiables

These have each already caused a real incident on this project.

- **Never run `nft flush ruleset`.** It deletes Docker's NAT rules and kills
  container egress. The symptom is an unrelated timeout, not a firewall error.
  The firewall owns only the `inet careerscope` table.
- **Never restart the proxy alone.** Every service joins its network namespace;
  restarting it orphans them all behind a 502 while they still report healthy.
  Use `infra/v3/restart-stack.sh`.
- **Never run `docker system prune -a`.** It removes the images a rollback
  depends on. Prune build cache only.
- **Never regenerate `POSTGRES_PASSWORD`** against an existing database volume.
  `infra/v3/.env` on the host is the only copy; `ship.sh` preserves it.
- **Never deploy uncommitted code.** Deploy `git archive` from a reviewed
  commit, then prove it with `check-provenance.sh`.
- **Never publish an internal container port.** Only the proxy publishes.
- Keep the resume storage single-writer contract. Never delete cancellation
  markers by age — they are authoritative.
- Keep AI **off**, auto-apply on **hold**, and Naukri legitimate-access only.
- Never move `main` without explicit release intent. `main` is the V1 line;
  V2 work belongs on `feature/v2-local-migration`.
- Update the documentation whenever architecture or behaviour changes, and
  verify the live deployment after any runtime-affecting change.

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
  live verification. The deployed version is whatever `v2/package.json`
  (`careerscope-v2`) states; the root `package.json` is the separate V1 line
  (`job-radar`) and is several major versions behind. Reading the wrong one has
  already put a three-major-version error on a dashboard. Confirm against
  `/api/health` rather than either file. Do not provision additional infrastructure, change DNS or
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

## Multi-Agent Workflow

Non-trivial work runs through the 24 specialist agents in `.github/agents`, so
that the agent implementing a change is never the sole authority that it is
correct:

- **Orchestrator** — requirements, recon, routing, `.ai/` state, completion.
- **Read-only reviewers** — Product Architect, System Designer, UX, Security,
  Research, Research Reference, Independent Reviewer, Final Auditor, Code
  Quality, Product Discovery, Project Manager, Agent Operations, Skills Curator.
  Granted no edit tool, so the restriction is enforced by capability rather
  than by instruction.
- **QA, Performance** — execute the real checks, cannot edit implementation.
- **Builders** — Frontend, Backend, Infrastructure, Senior Engineer, Visual
  Designer, Documentation, Repository, Release Manager.

A twenty-fifth reviewer, **ChatGPT**, is recorded in `.ai/AGENT-SETUP.md` and
deliberately has no file here: nothing in `.github/agents` can invoke it. It
sees only what the operator pastes, which makes it a strong second opinion on
reasoning and a weak one on completeness. Never paste secrets, `.env` contents,
resumes or personal data into it. Record its verdict as a finding attributed to
it, never as fact.

The Orchestrator routes to the **smallest sufficient team**; running all 24 on a
small change is theatre. Durable state lives in `.ai/` because conversation
memory does not survive the fresh sessions that independent review requires.

Bounds: plan review 5, implementation 3, code review 3, security 2, performance
2, final audit 2. Reaching one means `BLOCKED`, never `COMPLETE`.

Validate the configuration with `node scripts/check-agents.mjs`.

Full description in [docs/AI-ENGINEERING-WORKFLOW.md](../docs/AI-ENGINEERING-WORKFLOW.md).
A separate cross-CLI workflow is documented in
[.github/CLAUDEX-WORKFLOW.md](CLAUDEX-WORKFLOW.md); use one per task, not both.

## Planning And Release

Work is planned in one-week sprints against `.ai/backlog.json`, with a WIP limit
of 2 enforced by exit code. Use `npm run agile:status`, `agile:plan`,
`agile:scrum`, `agile:feature`, `agile:review`, `agile:retro`, `agile:release`.
`npm run ui:engineering` serves a read-only control centre on 127.0.0.1:7777.

`scripts/release-gate.mjs` refuses by default and must be satisfied, not
argued with. It distinguishes three states — present-and-valid, absent, and
**unparseable** — because a corrupt `findings.json` once made it report
"no open P0 or P1" and exit 0. Its behaviour is pinned by mutation tests in
`check-release-gate.mjs`; the agile gates are pinned by `check-agile-gates.mjs`.

## Verification And References

- Start with a focused regression test. For broad code changes or a release, run
  `npm run typecheck`, `npm run lint`, `npm test`, `npm run build` and
  `npm run format:check`. Add the relevant browser, Pages and runtime gates.
- Prefer isolated synthetic data; never run destructive tests against owner data.
  Do not hide missing prerequisites, skipped tests or external-service failures.
- Report results concisely: changes, verification and remaining risks. Give
  findings first for reviews; use architecture/trade-off sections only when useful.
- Consult [project state](../docs/PROJECT-STATE.md),
  [API surface](../docs/API-SURFACE.md), [security](../docs/SECURITY.md),
  [deployment](../docs/OPERATIONS/DEPLOYMENT.md),
  [rollback](../docs/OPERATIONS/ROLLBACK.md),
  [firewall](../docs/OPERATIONS/FIREWALL.md) and
  [known limitations](../docs/KNOWN-LIMITATIONS.md) when relevant. Do not load
  every document for every request.
