# Architecture Index

Start with [project state](../PROJECT-STATE.md). The root
[V1 architecture](../ARCHITECTURE.md) describes Fastify/SQLite and React/Vite;
[V2 architecture](../../v2/ARCHITECTURE.md) describes the PostgreSQL/Next.js
stack and also contains explicitly historical target sections. V1 domain
packages remain V2 build dependencies. Do not infer deployed revision from the
local tree or treat a target diagram as implementation.

These eight diagrams summarize inspected source, not new components or live
verification. The orchestration diagram is the approved engineering workflow;
the CI diagram describes existing automation, including its gaps. Each diagram
links its owning source so later changes can be reconciled locally.

## System

Sources: [production Compose](../../infra/v3/compose.production.yml),
[implemented V2 topology](../../v2/ARCHITECTURE.md#implemented-topology),
[publisher](../../v2/apps/workers/search/src/publisher.ts).

```mermaid
flowchart TD
    Browser[Browser] --> Proxy[Caddy proxy]
    Proxy --> Web[Next.js web]
    Proxy --> API[Fastify API]
    API --> DB[(PostgreSQL)]
    API --> Redis[(Redis rate limits)]
    API --> Store[Encrypted private filesystem]
    DB --> Publisher[Outbox publisher]
    Publisher --> SearchQueue[SQS search queue]
    Publisher --> FilesQueue[SQS files queue]
    SearchQueue --> Search[Search worker]
    FilesQueue --> Files[Files worker]
    Search --> Sources[Public job sources]
    Search --> DB
    Files --> Store
    Files --> DB
```

Only the proxy publishes host ports. Other services share its network namespace;
the proxy must not restart alone. The API writes resume objects; the files
worker mounts the store read-only. BullMQ is an optional search transport, not
the files transport. Bootstrap is a one-shot dependency, omitted from the
steady-state diagram. No inference service is shown because inference is off.

## Frontend

Sources: [V2 page](../../v2/apps/web/src/app/page.tsx),
[API client](../../v2/apps/web/src/lib/api.ts),
[V1 architecture](../ARCHITECTURE.md). This is V2's current local source, not
the older no-React-Query claim in [frontend architecture](../FRONTEND-ARCHITECTURE.md).

```mermaid
flowchart TD
    Page[Next.js page and Workspace] --> Session[Session query]
    Session --> Gate{Authenticated?}
    Gate -->|No| Account[Account form]
    Gate -->|Yes| Views[Local workspace view state]
    Views --> Profile[Profile and resume editor]
    Views --> Leads[Saved leads]
    Views --> Search[Search runs and match evidence]
    Views --> Other[Preparation and account security]
    Page --> Cache[TanStack Query cache]
    Cache --> Client[Same-origin API client]
    Account --> Client
    Profile --> Client
    Leads --> Client
    Other --> Client
    Client --> API[Fastify API]
    API --> Events[Search SSE stream]
    Events --> Page
```

Component view state is not a set of independent routes. Query state and local
interaction state coexist. The API client uses no-store requests, same-origin
credentials and bounded requests; callers supply mutation CSRF headers.

## Backend

Sources: [API routes](../../v2/apps/api/src/app.ts),
[database](../../v2/packages/core/src/database.ts),
[publisher](../../v2/apps/workers/search/src/publisher.ts),
[consumer](../../v2/apps/workers/search/src/main.ts),
[collection handler](../../v2/apps/workers/search/src/collect.ts).

```mermaid
flowchart LR
    Request[Search request] --> Guards[Origin session CSRF and validation]
    Guards --> Transaction[Search creation transaction]
    Transaction --> Snapshot[Frozen matching profile]
    Transaction --> Outbox[Durable outbox command]
    Outbox --> Publisher[Publisher with retry and reconciliation]
    Publisher --> Queue[Selected search queue transport]
    Queue --> Consumer[Fenced worker execution]
    Consumer --> Collect[Bounded collection and deterministic matching]
    Collect --> Settle[Persist jobs outcomes and run events]
    Settle --> Replay[Owner-scoped SSE and result reads]
```

Delivery is not authority to settle twice. PostgreSQL execution state, fences
and leases determine valid transitions. Provider failures can produce partial
results; a search must not be described as successful solely because it queued.

## Data

Source: [Drizzle schema](../../v2/packages/core/src/schema.ts). These are selected
declared relationships, not an exhaustive schema or a new database design.

```mermaid
erDiagram
    users ||--o{ sessions : owns
    users ||--o| candidate_profiles : owns
    users ||--o{ search_runs : owns
    users ||--o{ saved_leads : owns
    users ||--o{ resume_uploads : owns
    search_runs ||--o{ search_jobs : contains
    search_runs ||--o{ run_events : emits
    saved_leads ||--o{ lead_history : versions
    outbox_events ||--o| command_executions : fences
    outbox_events o|--o{ resume_uploads : schedules
```

Owner-scoped uniqueness, profile/lead revisions and composite lead-history
ownership are part of correctness. Resume bytes live in the private filesystem;
metadata and parse results are database state. A frozen profile on a run is not
a live link that changes when the candidate profile is edited.

## Authentication

Sources: [request guards and login](../../v2/apps/api/src/app.ts),
[Auth](../../v2/packages/core/src/auth.ts).

```mermaid
sequenceDiagram
    participant Browser
    participant API
    participant Auth
    participant DB as PostgreSQL
    Browser->>API: POST login with matching Origin
    API->>API: Validate input and rate limits
    API->>Auth: Verify credentials
    Auth->>DB: Read password hash and commit hashed session token
    Auth-->>API: Opaque session token or rejection
    API-->>Browser: HttpOnly SameSite Strict cookie on success
    Browser->>API: GET session with cookie
    API->>Auth: Validate token and expiry
    Auth->>DB: Resolve owner
    API-->>Browser: Authentication status and CSRF token
    Browser->>API: Protected mutation with cookie Origin and CSRF
    API->>API: Enforce Origin session CSRF and owner scope
    API->>DB: Validated owner-scoped operation
    API-->>Browser: Result or explicit denial
```

The cookie is scoped to `/api` and is Secure on HTTPS origins. Login and
registration require the matching Origin but are exempt from authenticated
CSRF checks; health and session inspection have their own public behavior.
Registration depends on configuration. This does not imply password-reset
email exists; see [known limitations](../KNOWN-LIMITATIONS.md).

## Orchestration

Sources: [Orchestrator configuration](../../.github/agents/careerscope-orchestrator.agent.md),
[approved execution contract](../ai/orchestration.md),
[quality gates](../ai/quality-gates.md),
[validator](../../scripts/engineering.mjs),
[task contracts](../../scripts/engineering-contract.mjs) and
[fixed-ID runner](../../scripts/engineering-runner.mjs). The validator implements
schema-1 and schema-2 record checks; the runner executes opt-in local checks.
Neither schedules agents. This diagram is the approved workflow, not evidence
that every phase or the native UI/hooks has been verified end to end.

```mermaid
flowchart TD
    Request[Approved task] --> Audit[Twelve-area audit]
    Audit --> Plan[Prioritized graph and exclusive claims]
    Plan --> Review[Plan review where required]
    Review --> Ready{Prerequisites satisfied?}
    Ready -->|No| Blocked[BLOCKED with evidence]
    Ready -->|Yes| BuilderA[Claimed builder task A]
    Ready -->|Yes and independent| BuilderB[Claimed builder task B]
    BuilderA --> Join[Integrate and freeze current content]
    BuilderB --> Join
    Join --> QA[Actual QA execution]
    QA --> Independent[Independent content-bound review]
    Independent --> Decision{Applicable evidence accepted?}
    Decision -->|Fix within bounds| Plan
    Decision -->|Missing evidence or exhausted bound| Blocked
    Decision -->|Yes| Docs[Reconcile docs and review snapshot]
    Docs --> Verify[Completion verification of final content]
    Verify --> Complete[COMPLETE or BLOCKED]
```

Only disjoint approved tasks overlap; shared files serialize. Documentation
changes, including formatting, alter the objective-wide digest when claimed:
refresh required evidence/review after the final content edit. Narrow reporting
exclusions avoid digest cycles without discarding meaningful execution/failure
history; see [evidence rules](../ai/evidence-model.md). Native agent calls and
user-triggered handoffs are different mechanisms. Completion grants no release
authority.

## CI

Sources: [CI workflow](../../.github/workflows/ci.yml),
[deployment workflow](../../.github/workflows/deploy.yml),
[initial audit](../ai/initial-repository-audit.md). This diagram describes
automation; it is not authorization to push or run deployment.

```mermaid
flowchart TD
    Change[PR main push or CI dispatch] --> CI[CI verify]
    CI --> Root[Root static checks tests build and browser checks]
    CI --> V2[V2 unit tests only]
    CI --> PagesCheck[Validate Pages assets]
    Change --> Image[Optional container job]
    PagesDispatch[Manual Pages dispatch with ref and environment] --> PagesExact[Require exact-revision CI success]
    PagesExact --> PagesBuild[Revalidate stage and publish Pages]
    Trigger[Manual deploy dispatch with ref and production environment] --> Exact[Require exact-revision CI success]
    Exact --> Gate[Deploy gate]
    Gate --> Domain[Build and test shared domain packages]
    Domain --> Checks[V2 typecheck lint format build dependency audit]
    Checks --> Ship[Ship committed archive and verify host]
```

CI runs V2 unit, integration, browser, accessibility and recovery jobs; the
unit step remains explicitly labelled so it cannot imply that coverage alone.
Deployment and Pages publication have no push, pull-request, schedule or
workflow-run trigger, and neither exposes a CI bypass. Testing release-gate
code is not the same as enforcing the current recorded release verdict; the
audit records that gap. No new engineering check is depicted as a CI dependency
until the actual workflow includes it.

## User Journey

Sources: [workspace](../../v2/apps/web/src/app/page.tsx),
[API](../../v2/apps/api/src/app.ts),
[implemented V2 flow](../../v2/ARCHITECTURE.md#implemented-topology).

```mermaid
flowchart LR
    SignIn[Sign in] --> Profile[Review candidate profile]
    Profile --> Choice{Resume import?}
    Choice -->|Optional| Upload[Upload and parse privately]
    Upload --> Proposal[Review editable proposal]
    Proposal --> Save[Explicitly save profile]
    Choice -->|No| Save
    Save --> Search[Start bounded search]
    Search --> Progress[Progress partial outcomes or cancellation]
    Progress --> Results[Inspect jobs and match evidence]
    Results --> Lead[Save and organize lead]
    Lead --> Prepare[Rules-based preparation]
    Results --> Export[Export search JSON]
    Lead --> Employer[Open employer link for manual action]
```

Resume parsing does not silently replace the profile used for matching. A saved
lead is not proof of an application; imported jobs and preparation do not
submit anything. AI remains off and auto-apply on hold. Source-level presence
of this flow is not a fresh end-to-end browser or production test.
