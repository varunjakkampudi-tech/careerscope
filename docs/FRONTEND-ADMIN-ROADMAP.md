# Frontend & Admin Roadmap

The next engineering phase, and an honest account of what blocks each piece.

Branch: `feature/frontend-pages-admin-console`, cut from the reviewed V2
baseline. Never from `main`.

---

## The core problem

The requested product is a multi-page career intelligence workspace with an
admin console. The current frontend is **one route**. More importantly, several
requested pages have **no backing data** — not a missing endpoint, a missing
table.

Building UI for data that does not exist means inventing data. That is
forbidden. So the work splits into "buildable now" and "needs backend first".

---

## Buildable now

These need only frontend work against existing endpoints.

| Page                | Backing API                                   | Notes                                          |
| ------------------- | --------------------------------------------- | ---------------------------------------------- |
| `/` dashboard       | `/api/session`, `/api/searches`, `/api/leads` | Real counts only, no invented metrics          |
| `/login`            | `POST /api/login`                             | Extract from `account-form.tsx`                |
| `/profile`          | `GET`/`PUT /api/profile`                      | Revision conflicts need a real 409 experience  |
| `/resume`           | `/api/resumes*`                               | Must handle 507 and cancellation honestly      |
| `/search`           | `POST`/`GET /api/searches`                    |                                                |
| `/search/:id`       | `GET /api/searches/:id`, `/events`            | SSE resume via `Last-Event-ID`                 |
| `/leads`            | `GET /api/leads`                              |                                                |
| `/leads/:id`        | `/api/leads/:id`, `/history`                  | History already exists and is unused by the UI |
| `/preparation`      | `GET /api/preparation`                        |                                                |
| `/account/security` | `/api/account/*`                              | Extract from `account-security.tsx`            |

**First task is not a page.** It is introducing real routing, an auth boundary
against `GET /api/session`, and shared layout/navigation. Every page above
depends on that.

---

## Blocked on backend work

Each of these needs schema and collection work before any UI is honest.

| Requested                                        | Blocker                                                                                                  |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `/jobs` public browsing                          | No global job corpus. `search_jobs` is scoped to a run and an owner.                                     |
| `/companies`, `/companies/:id`                   | **No company entity.** Nothing to render.                                                                |
| `/market`, `/skills`                             | No aggregates. `CollectedJob` has no salary, tech stack, employment type, remote flag or required-years. |
| `/alerts`, saved searches                        | No saved-search entity.                                                                                  |
| `/verify`, `/forgot-password`, `/reset-password` | **No email sender.** OPEN — EXTERNAL.                                                                    |
| All `/admin/*`                                   | No admin role, no admin endpoints, no audit table.                                                       |

`CollectedJob` carries 11 fields. Adding salary or tech stack is not a UI task —
it is a normalization and collection change across five source adapters, plus a
migration, plus backfill semantics for jobs already stored.

---

## Admin console

Not started. It must **not** be a database UI.

### Prerequisites, in order

1. An **owner/admin role**. There is currently no role concept at all.
2. Read-only admin endpoints under `/api/admin/*`, subject to the same session,
   CSRF and origin rules as everything else.
3. An **audit table**. Every admin mutation must be recorded.

### Intended views, and what already exists to back them

| View                                                                     | Data source                                         | Exists?                    |
| ------------------------------------------------------------------------ | --------------------------------------------------- | -------------------------- |
| Overview — health, version, deployed SHA                                 | `/api/health`, OCI revision label                   | Partly                     |
| Queue — ready, in-flight, DLQ, oldest work                               | SQS + `command_executions`                          | Data yes, endpoint no      |
| Outbox — oldest unpublished                                              | `outbox_events`, indexed `(publishedAt, createdAt)` | Data yes, endpoint no      |
| Runs — searches, executions, timing, provider outcomes                   | `search_runs.sourceOutcomes`                        | Data yes, endpoint no      |
| Providers — success, failure, limited, latency                           | Per-run outcomes                                    | Aggregation does not exist |
| Storage — objects, bytes, temporaries, reserved bytes, markers, refusals | File storage counters                               | Data yes, endpoint no      |
| Security — session count, revocations                                    | `sessions`                                          | Data yes, endpoint no      |

### Hard rules

Never expose: password hashes, session tokens, cookies, the database password,
the Redis password, encryption keys, private keys, or raw resume content.

Every admin mutation requires owner authorization, CSRF, origin validation,
server-side validation, an audit record and explicit confirmation. Do not
invent destructive endpoints — "delete any row" is not an admin feature.

---

## Suggested order

1. Routing, auth boundary, shared layout. Everything else depends on it.
2. Move the seven existing components onto real routes, with proper loading,
   empty, error and unauthorized states.
3. Polish: responsive behaviour, focus management, live regions, 409 and 507
   experiences.
4. Admin role + audit table + read-only admin endpoints.
5. Admin console against those endpoints, read-only first.
6. Only then consider the schema work behind companies, market and skills — and
   treat it as a backend project, not a frontend one.

---

## Standing constraints

Unchanged by this phase:

- AI stays off. Matching stays deterministic.
- Auto-apply stays on hold.
- Naukri stays deferred, and legitimate-access only if ever built.
- Do not weaken Argon2id, CSRF, origin checking or rate limits for UI
  convenience.
- Do not break existing API contracts.
- `main` is not touched.
