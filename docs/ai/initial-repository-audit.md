# Initial Repository Audit

Initial audit date: 2026-09-20. Recorded local revision:
`5239b0a87796bd26792c525408342970894759cb`, branch `main`.
The worktree contains pre-existing API, branding, dashboard and release edits.
They are preserved. This is a source audit, not production certification.
The inventory/findings below preserve the initial inspection; the expanded-OS
reconciliation at the end distinguishes subsequent evidence and remaining gaps.

## Evidence And Scope

Actual read-only delegations: CareerScope Research (native configuration),
CareerScope Product Architect (architecture, commands and automation).
The parent inspected the Orchestrator, configuration validator, project state,
testing policy, architecture, environment example and known limitations.
`node scripts/check-agents.mjs` passed before changes, including its 24-agent check.
Live provenance remains unverified: `infra/v3/check-provenance.sh` is host-local
and requires the deployed filesystem and Docker images. No production access,
credentials, user data or real environment files were read.

## Inventory

| Surface                | Actual ownership                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Root workspace         | npm workspaces, TypeScript references, V1 job-radar 1.3.4                                                        |
| Frontend               | V1 React/Vite in apps/web; deployed V2 Next.js/React in v2/apps/web                                              |
| Backend                | Fastify; V1 SQLite; V2 PostgreSQL 17/Drizzle                                                                     |
| Domain libraries       | packages/shared, providers, matching, resume; reused by V2                                                       |
| Asynchronous work      | PostgreSQL transactional outbox, publisher, SQS/LocalStack; optional BullMQ search transport                     |
| Storage                | API-owned encrypted private filesystem; files worker reads                                                       |
| Public static artifact | mobile-site and Pages scripts; _site is generated                                                                |
| Infrastructure         | infra/v3, Caddy, single-host Compose, nine services; only proxy publishes                                        |
| Tests                  | Root Vitest, Pages node:test, V2 node:test, Playwright browser scripts                                           |
| CI                     | .github/workflows/ci.yml and deploy.yml; push to main is a deployment candidate                                  |
| Native customization   | Initial snapshot: 24 agents, 20 skills, scoped instructions, two prompts; hook/prompt additions reconciled below |
| MCP                    | .vscode/mcp.json declares job-radar stdio; metadata inspected only                                               |
| Engineering state      | .ai backlog, findings, progress, release and loop records; review.txt; agile and gate scripts                    |
| Documentation          | docs/ARCHITECTURE.md, v2/ARCHITECTURE.md, testing, operations and existing Mermaid diagrams                      |

## Commands

Use Node >=24 and npm. Commands are manifest inventory unless marked executed.

| Purpose        | Root                                                                | Inside v2                                                                      |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Install        | npm ci                                                              | npm ci                                                                         |
| Development    | npm run dev                                                         | npm start; npm run dev -w @careerscope/web                                     |
| Build          | npm run build                                                       | npm run build:domain; npm run build                                            |
| Static checks  | npm run lint; npm run typecheck; npm run format:check               | same script names                                                              |
| Tests          | npm test; npm run pages:test                                        | npm test; npm run test:unit; npm run test:integration                          |
| Browser        | npm run test:ui; npm run pages:visual; npm run pages:workspace:test | npm run test:ui                                                                |
| Database       | npm run db:migrate; npm run seed:companies                          | npm run services; npm run db:generate; npm run db:migrate; npm run setup:owner |
| Agent baseline | npm run agents:check; npm run skills:check                          | not applicable                                                                 |

Database and owner commands are documented, not authorized for production by
this audit. Runtime/browser tests require isolated synthetic services and browsers.
The Windows workspace provides a pinned Node executable under
data/windows-toolchain and a private-configuration launcher under data/windows-v2.
Neither is a cross-platform prerequisite for the new engineering workflow.

## Prioritized Findings

| ID    | Severity | Evidence and disposition                                                                                                                                                                       |
| ----- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI-01 | P1       | Orchestrator lists delegates but omits the native agent tool. Fix configuration and add a check.                                                                                               |
| AI-02 | P1       | agile.mjs does not enforce an execution DAG or file claims. Add bounded task validation; keep backlog as product authority.                                                                    |
| AI-03 | P1       | release-gate.mjs treats absent findings as an empty list; deploy.yml does not enforce the actual recorded release gate. Record for separately authorized release hardening.                    |
| AI-04 | P1       | agile.mjs released() trusts caller commit and closes every ready ticket after a version check. Not proof of exact deployed revision or scoped release. Do not use this as completion evidence. |
| AI-05 | P1       | Legacy mutation gate tests overwrite canonical .ai records with fixed backups. Do not parallelize these; new tests must use isolated temporary fixtures.                                       |
| AI-06 | P2       | check-agents.mjs rejects every COMPLETE state, lacks delegation-tool validation, and parses YAML with regex. Extend checks without pretending syntax proves runtime discovery.                 |
| AI-07 | P2       | AI-ENGINEERING-WORKFLOW.md describes removed three-agent roles; instruction globs omit V2. Reconcile native workflow and scope.                                                                |
| AI-08 | P2       | V2 profile imports root compiled outputs; clean-build ordering is significant. Preserve both stacks; no evidence supports deleting V1.                                                         |
| AI-09 | P2       | Version-file lists duplicated across publication/sync scripts; proxy build uses floating dependencies. Record debt; no unrelated cleanup.                                                      |
| AI-10 | P1       | CI lacks full deployed V2 integration/E2E coverage. Configuration validation cannot establish product or production readiness.                                                                 |

No application symbol has been proven unused by this audit; no dead code is
deleted. Dependency vulnerability scanning is still required before a security
clearance; floating build inputs are a reproducibility risk, not proof of a CVE.
Known limitations include proxy namespace restart behavior, no off-host backup,
missing transactional email and human screen-reader validation. Do not turn
intentional product boundaries into invented defects.

## Implementation Decision

Reuse the 24-agent team. Extend the existing Orchestrator as CTO, map database,
accessibility, SEO and test-authoring responsibilities explicitly, and add native
prompts. Add a small local Node state validator with isolated negative tests,
dependency and file-ownership checks, revision-scoped evidence, and twelve
quality areas. Keep product backlog and historical progress authoritative for
their existing consumers; new task state must not rewrite them or invent agent
activity. Hooks are optional assistance, never a security sandbox. No additional
MCP, paid model API, extension, application dependency or deployment is required.

## Expanded OS Reconciliation

The authoritative pre-change QA evidence is [baseline.json](baseline.json) and
[baseline.md](baseline.md), not the historical totals in product docs. Actual
CareerScope QA recorded 131 engineering/hook tests and 1,047 root tests in 67
files passing, with isolated Vitest envDir/cacheDir; typecheck/lint/build passed
and lint had one warning. The baseline also preserves audit-format failure,
missing latest-review metadata, and the correct incomplete-objective refusal.
V2 integration, browser, live provenance, dependency advisories and security
clearance were not established. Preserve its measured clock discrepancy.

The operator reports real native `functions.runSubagent` invocations for QA and
Independent Reviewer this turn. This documentation delegate does not fabricate
their verdicts or claim that their earlier review accepts these new documents.
Available parent tools include Browser/Playwright, file tools and terminal;
Agent Sessions/worktrees UI activation and actual SessionStart firing remain
unverified. Handoffs are user actions; no autonomous background scheduler exists.

### Source-Proved Updates

- AI-01's missing tool configuration is resolved in the inspected
  [Orchestrator](../../.github/agents/careerscope-orchestrator.agent.md): `agent`
  and an explicit roster allowlist exist. This does not prove the entire UI loop.
- AI-02 is addressed for the new execution projection by
  [engineering.mjs](../../scripts/engineering.mjs): cycle checks, prerequisite
  completion, literal claims and active overlap checks exist. This is not a
  claim that legacy agile consumers gained these guarantees.
- AI-06's customization scope has a dedicated
  [YAML parser/grant validator](../../scripts/check-customizations.mjs); 24
  agents, eight total prompts, seven instructions and 20 skills were observed
  in its actual run. It still failed latest-review metadata, matching baseline.
  Legacy check-agents behavior was not re-audited here, so AI-06 is only partial.
- A [SessionStart hook](../../.github/hooks/engineering.json) and bounded
  [handler](../../scripts/engineering-hook.mjs) now exist. The initial "no hooks"
  inventory is historical. Tests do not prove VS Code fired the hook.
- Later source/help reconciliation found schema-2 contract enforcement and the
  fixed-ID runner implemented. See [quality gates](quality-gates.md),
  [risk roles](risk-model.md) and [evidence](evidence-model.md). The current
  execution record remains schema 1; no migration history was created. This
  inspection does not rerun or extend the historical QA totals above.

### Remaining Observed Gaps

| ID    | Observation and disposition                                                                                                                                                                                                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OS-01 | Schema-2 contracts and the fixed-ID runner now exist. Original schema-1 state remains legacy; schema 2 limits retained remediation failures per task, not aggregate rounds. Historical baseline JSON is incompatible with the strict contract baseline shape; preserve it        |
| OS-02 | Records/reviews are attributed, not signed or tamperproof. Digests cannot prove command execution or reviewer identity; actual native results and independent inspection remain required                                                                                         |
| OS-03 | Claims/tool grants are not OS isolation. One existing dirty worktree; use literal disjoint claims, isolated QA resources and serialized integration, never blind merges                                                                                                          |
| OS-04 | Actual Windows workspace differs from supplied Mac paths. Default Node 22 is unsupported; pinned Node 26 worked. Hook config uses bare node, so its actual runtime is unverified                                                                                                 |
| OS-05 | SessionStart firing and Agent Sessions/worktrees UI activation remain unverified; browser tool visibility and MCP metadata do not prove service health                                                                                                                           |
| OS-06 | True tokens, provider latency and live agent liveness are unavailable; supported record-derived metrics must not invent those values                                                                                                                                             |
| OS-07 | Parent-owned latest review metadata still fails customization validation; engineering completion remains intentionally incomplete                                                                                                                                                |
| OS-08 | Current gate policy's production-readiness check says "no hook ... wiring", but a SessionStart hook exists. Parent must reconcile the approved scope without weakening the original local-only/no-deployment condition                                                           |
| OS-09 | Visual Designer forbids concurrent Frontend work while Orchestrator permits disjoint builders. Honor the stricter role rule pending parent reconciliation. Backend scope lists only V2 although responsibility prose includes V1; route explicit V1 work through Senior Engineer |
| OS-10 | Repository agent says main is the V1 line, contrary to project-state's integration/deploy branch for both stacks. Parent owns the agent correction; no Git actions authorized here                                                                                               |

Except for the explicit source updates above, OS findings describe the earlier
inspection; their metadata and policy observations need fresh owner validation.
AI-03/04/05/07/08/09/10 and historical product drift are **unverified current**
unless explicitly source-proved above: this task does not repeat a deep audit of
unchanged release/product code. Preserve their useful findings, not implied
closure. [Limitations](limitations.md) is the engineering-OS limitation authority;
[troubleshooting](troubleshooting.md) retains out-of-scope product-doc drift.
No application, configuration, baseline, package or canonical state was edited
by this documentation assignment. Completion evidence belongs to the parent.
