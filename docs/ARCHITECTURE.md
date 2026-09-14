# Architecture

Why the code is shaped the way it is. [README](../README.md) covers what the app
does and how to run it; [RUNBOOK](RUNBOOK.md) covers operating it. This file is
for the person about to change it.

**Contents** — [The shape](#the-shape) · [Module graph](#module-graph)
· [A search run](#a-search-run-end-to-end) · [Data model](#data-model)
· [Invariants](#invariants) · [Extending it](#extending-it)
· [Testing strategy](#testing-strategy) · [Rejected alternatives](#rejected-alternatives)

---

## The shape

One npm-workspaces monorepo and one TypeScript build graph (`tsc -b`). The
full application runs as an API process serving the React bundle. GitHub Pages
is a separate static artifact built from `mobile-site/`, not the full application.

Four ideas do most of the work:

1. **Types are declared once, in Zod, in `packages/shared`.** The API validates
   with the schema and the UI infers its types from the same object, so a field
   renamed on the server is a compile error in the browser rather than an
   `undefined` at runtime.
2. **Deterministic scoring stays separate from I/O.** Heuristic scoring receives
   its context explicitly. Optional LLM reranking is a separate network-backed
   operation; it must not be confused with deterministic scoring.
3. **Dependencies are passed, never imported ambiently.** `container.ts` builds
   the graph once. Nothing below `env.ts` reads `process.env`; no service
   reaches for a database handle it was not given.
4. **The durable half of every mechanism is a table.** Runs, run events, and the
   queue's notion of "in flight" all live in SQLite. A restart loses in-flight
   work but never loses track of it.

---

### Local inference boundary

The optional local stack uses the existing API/UI and SQLite persistence plus a
private Ollama service. `container.ts` selects the explicitly configured provider;
`matching` owns prompt construction, eligibility, schema validation and score
blending; the API's Ollama adapter owns bounded HTTP transport. Model failures do
not fail collection, and local inference never silently falls back to a paid API.

Local requests are serial, limited to five eligible leads, and use a conservative
UTF-8 byte upper bound plus generation/template reserve to select a 4K-16K context.
Oversized input is rejected rather than silently dropped by the inference server.
Wrong posting IDs and scores outside 0-1 are rejected in code as well as constrained
in the local output schema. A structurally valid answer can still be inaccurate;
the deterministic score retains majority weight and model quality is unproven.

SQLite remains the database and durable queue for this single-owner, single-writer
deployment. No Redis or separate database server is introduced: neither resolves
the observed CPU inference latency, and both add backup, security and consistency
work. Reconsider only after measuring contention, concurrent workers or a concrete
shared-cache requirement. See [local runtime evidence](RUNBOOK.md#local-containers).

## Module graph

Package dependencies are declared in workspace manifests and TypeScript project
references. `providers` uses `matching` for demand extraction; the API composes
the packages. `tsc -b` checks project references, not every source-level import cycle.

```
                    ┌─────────────────┐
                    │ packages/shared │   Zod schemas, inferred types,
                    │                 │   source constants, skill aliases
                    └───────┬─────────┘
            ┌───────────────┼───────────────┬──────────────┐
            ▼               ▼               ▼              ▼
    ┌──────────────┐ ┌──────────────┐              ┌──────────────┐
    │   resume     │ │   matching   │              │  apps/web    │
    │ PDF/DOCX →   │ │ pure scoring │              │ React + Vite │
    │ derived      │ │ + LLM rerank │              └──────────────┘
    └──────┬───────┘ └──────┬───────┘
           │                ▼
           │        ┌──────────────┐
           │        │  providers   │  15 sources behind one interface,
           │        │              │  shared HTTP retry/cache/rate-limit,
           │        └──────┬───────┘  + an optional Playwright tier
           └────────┬──────┘
                    ▼
            ┌──────────────┐
            │   apps/api   │  Fastify · SQLite · queue · SSE ·
            │              │  enrichment · export · MCP
            └──────────────┘
```

`providers` depends on `matching` for one thing only: the demand extractor, so a
provider can pre-rank its own page of results before handing them up.

The web app depends on `shared` and nothing else. It cannot accidentally import
a Node built-in through a transitive server package, because there is no edge to
one.

### What lives where

| Path                     | Holds                                                                                              | Rule of thumb                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/shared/src`    | `schemas.ts`, `types.ts`, `constants.ts`, `skills.ts`, `format.ts`                                 | If both the browser and the server need to agree on it, it belongs here |
| `packages/resume/src`    | `extract.ts` (PDF/DOCX → text), `sections.ts`, `derive.ts`                                         | Text in, structured profile out. No storage                             |
| `packages/matching/src`  | `demands.ts`, `dimensions.ts`, `seniority.ts`, `score.ts`, `context.ts`, `rerank.ts`               | Pure. If it needs I/O it does not belong here                           |
| `packages/providers/src` | `ats/`, `remote/`, `keyed/`, `scrape/`, plus `http.ts`, `normalize.ts`, `registry.ts`, `boards.ts` | Third-party shapes stop here; everything above sees `RawJob`            |
| `apps/api/src/db`        | `schema.ts`, `migrate.ts`, `seed.ts`, `repo/*`                                                     | SQL lives in `repo/` and nowhere else                                   |
| `apps/api/src/routes`    | one file per resource                                                                              | HTTP concerns only — parse, delegate, serialise                         |
| `apps/api/src/services`  | `queue.ts`, `searchRunner.ts`, `events.ts`, `companyResolver.ts`, `exporter.ts`                    | The behaviour. Reused verbatim by the MCP bridge                        |
| `apps/api/src/mcp`       | `index.ts` (stdio transport), `server.ts` (11 tools)                                               | Thin wrappers over `services/`. No logic of its own                     |
| `apps/web/src`           | `routes/`, `components/`, `lib/`                                                                   | `lib/` is the only place that knows the API exists                      |
| `seed/`                  | `companies.json`, `leads.json`                                                                     | Versioned source data — **not** `data/`, which is runtime state         |

---

## A search run, end to end

The interesting path. A run is minutes long, so nothing about it is
request/response.

```
POST /api/search
   │
   ├─ validate, persist a `search_runs` row as `queued`, return 202 + runId
   │
   └─ queue.enqueue() ──────────────────────────────────────────┐
                                                                 │
GET /api/runs/:id/events   (SSE, separate connection)            │
   │                                                             ▼
   └─ eventBus.stream(runId) ◄──── publish ──── SearchRunner.run()
                                                     │
             fetch ─→ normalise ─→ dedupe ─→ score ─→ cap ─→ enrich ─→ store
```

**One worker, in-process, no broker.** Two concurrent runs would double the
request rate every third-party host sees from this IP — which is how a free API
key gets suspended. Serialising costs a single-user app nothing.

**Scoring runs before enrichment, and that ordering is load-bearing.** Scoring
is pure and costs microseconds. Enrichment is network I/O against dozens of
employers' web servers and costs seconds each. So the run scores everything,
keeps the best `maxResults`, and only then spends requests on the companies
behind jobs the user will actually see. This is safe rather than merely faster
because enrichment adds website, portal and email — none of which feed the
score.

**Events are written before they are sent, never the reverse.** A client that
received event 47 and dropped its connection can ask for everything after 47 and
be certain the row exists. `stream()` subscribes _first_, buffers what arrives
live, replays from the database, then drains the buffer discarding what the
replay already covered — because an event published in the gap between "replay"
and "subscribe" would otherwise be in neither set and lost forever.

**Terminal rows have exactly one owner.** The runner writes the row for a run
that finished or failed on its own. For a run stopped from outside, the stopper
owns it: cancel writes `cancelled` _before_ aborting, timeout writes `failed`
_after_ the runner unwinds. Without that rule "cancelled" and "timed out"
collapse into the same indistinguishable abort.

**The board list grows.** Company enrichment sometimes discovers an employer
runs Greenhouse under a slug nobody would guess. That is persisted and folded
back in, so the _next_ run queries the new board (`absorbBoards` in
`container.ts`).

---

## The browser tier

LinkedIn, Naukri and Indeed publish no API. `packages/providers/src/scrape/`
covers collection from them. The API's separate `ApplicationBrowser` also starts
a browser for supervised applications. Not every collector needs one: LinkedIn's logged-out guest
endpoints answer a plain HTTP client, so `needsBrowser: false` and it never pays
for a launch. Only Naukri and Indeed need Chromium.

The tier is opt-in (`ENABLE_SCRAPERS`) and hides behind the same `JobProvider`
interface as everything else, so nothing above `providers/` knows a browser
exists. What follows is only true inside this directory.

### Six files, and why the shell is separate

| File                                  | Holds                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `browser.ts`                          | `BrowserPool` — one Chromium per process, reference-counted; a context per session; the Playwright-absent path |
| `block.ts`                            | Signature matching for walls, and the sentence a run ends on when it comes back empty                          |
| `base.ts`                             | The shell every adapter runs inside: lease, walk, filter, cap, detail-fetch, release                           |
| `linkedin.ts` `naukri.ts` `indeed.ts` | Per-site endpoints, pagination and parsing — and nothing else                                                  |

An adapter supplies `pages()`, `toRawJob()` and optionally `fetchDetail()`. Every
guarantee below lives in `createScrapeProvider`, where an adapter cannot forget
it:

1. **A refusal is a distinct outcome, not an empty one.** An adapter reports a
   wall by _setting_ `page.block`, never by throwing — a thrown error is
   indistinguishable from a network fault, and the two need different words. The
   shell then ends the run with `describeEmptyOutcome`, so the log says "Naukri
   served a captcha" rather than "0 postings matched".
2. **Partial plus blocked is stated as partial.** The sharpest case: a walk that
   read two pages and then hit a wall has leads to show, and showing them without
   comment implies the source was fully read. It gets its own warning naming the
   count.
3. **A crash is never reported as a quiet market.** `base.ts` deliberately
   swallows a throw, because a source that dies on page four should still deliver
   pages one to three — but swallowing it is what makes the lie possible. A
   `failed` flag rides through to both terminal branches so neither can describe a
   fault as health: an empty run says "this is a fault, not an empty result", and
   a truncated one takes the same partial warning as a block. This one is here
   because it was live and wrong: a run printed `[warn] linkedin: Cannot read
properties of undefined` and then, one line below, "The source answered
   normally — there was nothing to match." The user reads the second sentence.
4. **A cancelled run says nothing at all.** Both abort paths — the signal check
   at the top of the page loop and `isAbortError` in the catch — `return` before
   the terminal log, so a run you stopped never reports a finding it never
   finished looking for.
5. **The browser is always given back.** `session.dispose()` and the lease
   release sit in a `finally`, each with its own `.catch()`, so one throwing
   cannot strand the other. Cancellation is exactly when a leaked Chromium is
   most likely and least noticed.
6. **A standing limitation is said before the walk, not after.** `adapter.note`
   is logged up front, because a caveat that only appears on success is missing
   precisely when it would have explained the result.
7. **A lead capped at 80% says why it was capped.** A detail fetch can return
   HTTP 200 and still carry nothing usable — an empty payload, or a description
   too short to score against — in which case the lead is kept and honestly
   marked low-confidence. Correct, and from the outside inexplicable: a live
   Naukri run returned five leads for one query, three scoring normally and two
   held down, with nothing in the log between them. The shell counts the ones
   whose descriptions it could not read and states the total. It counts only
   where a fetch was actually attempted — a source with no `fetchDetail` is not
   failing at anything, and guarantee 6 has already explained it.

Every one of these fails _quietly_: the run still finishes and still reports a
number that looks like an answer. That is why `base.test.ts` pins them, and why
they were mutation-tested rather than trusted — and why the last two survived
both until end-to-end runs put a real error, and then a real 80% cap, in front of
a real log.

### The lines this tier does not cross

- **No stealth.** No fingerprint patching, no client-hint forgery, no captcha
  solving, no signed-token reimplementation, no signed-in session. Every page is
  one a logged-out visitor can open.
- **Headed is not a disguise.** `DEFAULTS.headless = false` because Naukri's edge
  refuses a headless Chromium — headless is the literal thing being inspected, so
  the honest answer is to genuinely run the browser rather than to edit the
  user-agent string. On a server that means an X server, which the `api-scrape`
  image supplies.
- **Naukri's detail endpoint is signed**, per job. Reimplementing that token
  would be forgery, so a detail fetch pays for a real page navigation instead —
  and only for postings that already passed the filters and fit inside the
  remaining budget.
- **Indeed's `/viewjob` is `robots.txt`-disallowed**, so it is never fetched.
  Indeed leads carry the search snippet plus Indeed's own structured skill tags,
  and are therefore capped at 0.80 — below the default 0.85 threshold. Indeed
  contributing nothing at the default is the design working, which is what
  `INDEED_CEILING_NOTE` exists to say.
- **A Cloudflare challenge ends the investigation.** Measured, not assumed:
  headed Chrome asking for Indeed's own search URL came back 403 with a
  `__cf_chl_rt_tk` token and the title "Security Check - Indeed.com", minutes
  after a near-identical URL for the same query returned 2,000 postings. Turning
  this pool's resource blocking off changed nothing, which rules out the
  self-inflicted cause found on Naukri (next bullet) — the wall is Indeed's,
  real, and at least partly stochastic. The obvious next move is to keep varying
  the request until one shape gets through, and that is evasion however ordinary
  the parameters look. So the tier stops, `detectBlock` names the challenge, and
  guarantee 1 makes the run say "Indeed challenged us" instead of "no jobs".
- **Before believing a site blocked you, check that you did not.** The one bug
  in this tier worth generalising from. `BrowserPool` drops images, fonts and
  media — bytes with no meaning in them — and stylesheets were once in that set
  too, on the reasoning that CSS is the most obviously droppable thing on a job
  board. With CSS blocked, Naukri's results page loaded, rendered, reported its
  job count in the title, and never issued the search request its own JavaScript
  makes. It looked exactly like a wall. A five-way A/B against the live site
  isolated it: blocking `image`, `font` or `media` in any combination captured
  the call in ~1.3s; blocking `stylesheet` alone never fired it in fifteen
  seconds. An unstyled document has no geometry, and something on that page waits
  for geometry. Keeping CSS costs tens of kilobytes a page; dropping it cost one
  of the three headline sources entirely, and cost it _silently_.

That last one is the tier in miniature, and the mechanism is worth being precise
about. A provider only ever asserts a **fact**: `hasFullDescription`. The
judgement is made in `score.ts`, where `hasReadableDescription()` turns that fact
plus a length floor into `confidence`, and `applyConfidenceCeiling()` clamps a
low-confidence lead to `LOW_CONFIDENCE_SCORE_CEILING`. So the cap is not a
scraper limitation leaking upward — it is the scoring engine declining to claim
confidence it has not earned, in code that has never heard of a browser.

---

## Data model

SQLite via `node:sqlite` — a built-in, which is why there is no `better-sqlite3`,
no native build step, and no compiler on the deploy host. WAL mode. Eight tables,
11 indexes, in `apps/api/src/db/schema.ts`.

| Table         | Holds                                                                    | Notable                                                                          |
| ------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `profiles`    | candidate, preferences, application JSON                                 | `user_id` column exists and is unused — multi-user is a migration, not a rewrite |
| `resumes`     | file metadata, storage path, extracted text, derived fields              | Files stored under UUID names; the original name is data, never a path           |
| `companies`   | website, careers URL, ATS type + portal, careers email                   | Every field carries **confidence and provenance**                                |
| `jobs`        | title, JD, tech stack, normalised salary, apply URL                      | `fingerprint` UNIQUE — the dedupe key across sources                             |
| `search_runs` | query, status, timings, per-source stats                                 | The queue's durable half                                                         |
| `run_events`  | monotonic sequence per run                                               | SSE replay reads this; `GET /runs/:id/logs` renders it                           |
| `leads`       | score, `breakdown` JSON, matched/missing skills, LLM score, status, note | UNIQUE(`profile_id`, `job_id`)                                                   |
| `settings`    | key/value                                                                | Schema version, seed version                                                     |

A job and a lead are different things on purpose: a job is a posting in the
world, a lead is _your_ relationship to it. The same posting scored against two
profiles is one `jobs` row and two `leads` rows.

`migrate.ts` is idempotent — it checks the stored schema version and returns
early — which is why it runs on every boot in both the container entrypoint and
the systemd unit, instead of being a deploy step someone forgets.

---

## Invariants

Things that are true everywhere, and that a change must not break. Each is
pinned by a test.

**Nothing is guessed.** Company enrichment writes `"Not yet verified"` rather
than inventing a value. A careers email comes only from a real `mailto:` on a
fetched careers or contact page, and only when the local part is in the
allowlist (`careers · jobs · hr · recruitment · talent · hiring · apply`). It is
never constructed from the domain, because a plausible-looking wrong address
costs a real application.

**Credential values never leave the process.** `GET /api/sources` reports which
_variable_ a disabled source needs, never a value. `redactedEnv()` returns
`set`/`unset`. The logger redacts credential paths and request headers.
`describeFailure` never dumps a URL, because Jooble's key is a URL path segment
by that API's design.

**The API key never travels in a query string** — SSE included. URLs land in
proxy logs, browser history, and `Referer` headers. This is why `lib/sse.ts` is
hand-rolled over `fetch` with a streaming reader rather than using
`EventSource`, which cannot set headers.

**Skills are scored against what the JD demands, not against the whole resume.**
Dividing by the candidate's own stack punishes breadth and is the bug that made
the original 85% threshold return nothing.

**A job whose full JD could not be read is capped at 0.80.** So crossing 85%
always means the description was actually fetched and parsed. Thin snippets
cannot fake a strong match.

**A source that cannot run is still listed**, with a reason. Silently omitting it
leaves the user unable to tell "we found nothing" from "we did not look".

**One slow board costs you that board, not the run.** Each source gets its own
fetch budget (`DEFAULT_SOURCE_BUDGET_MS`, three minutes); when it expires the run
keeps everything that source already yielded, marks it partial, and moves on. The
run-level timeout in `queue.ts` is a backstop for a genuinely wedged runner — it
writes `failed` and discards every posting collected. Without the per-source
deadline, one board sitting in `HttpClient`'s 429 backoff rides the whole run to
that backstop and throws away eight healthy sources' work. This happened here:
404 postings fetched, nine sources, one rate-limited, zero leads stored. A budget
expiry is **not** counted as an error — nothing failed, we stopped waiting — so
`SourceTable` reports it through `message` while `errors` stays at zero.

**An optional resource answers `200` with `null`, not `404`.** `GET /api/profile`
returns `{ profile: null }` before onboarding. A 404 there means "this route does
not exist", which is a different problem with a different fix, and conflating the
two turns a normal first run into an error the client has to special-case.

**The skill-gap panel describes; it does not predict.** `GET /api/leads/skill-gap`
counts how often a skill appears in `missingSkills` across near-miss leads. It
never claims that acquiring the skill would convert them — that is a counterfactual
which needs the scorer re-run against a different resume, and asserting it
unmeasured is the same class of guess as inventing a careers address. The
aggregate also excludes dismissed, hard-gated, and low-confidence leads, matching
`isRerankable` in `packages/matching/src/rerank.ts`: a missing-skill list read out
of a snippet measures the snippet, and low-confidence scores are capped at 0.80,
which would otherwise plant them inside the default near-miss window.

**Everything under `/api` requires a key except the two health routes.
Everything outside `/api` is public** — on the single-origin deploy this server
has to hand you the screen where you enter the key.

---

## Extending it

### A new job source

1. Add the id to `ALL_SOURCES` in `packages/shared/src/constants.ts` (and to
   `API_SOURCES` if it needs a key, or `SNIPPET_ONLY_SOURCES` if it cannot
   return a full JD — the 0.80 cap keys off that list).
2. Write the adapter in `packages/providers/src/{ats,remote,keyed}/`. Extend the
   `base.ts` in that folder; it already handles pagination and the walk.
3. Map the third-party payload to `RawJob` in your adapter. Nothing above
   `providers` may see the vendor's shape.
4. Register it in `registry.ts`, with an `unavailableReason` naming the variable
   it needs when it cannot run.
5. Add a fixture-driven test. `harness.fixtures.ts` gives you a stub HTTP client;
   no test hits the network.

### A new scoring dimension

1. Add the function to `packages/matching/src/dimensions.ts` — pure, `0..1`.
2. Add its weight in `score.ts` and rebalance; the weights must sum to 1.
3. Add the field to `matchBreakdownSchema` in `packages/shared`.
4. Render it in `apps/web/src/components/MatchMeter.tsx`. A dimension the UI
   cannot show is a dimension the user cannot audit.

### A new route

1. A file in `apps/api/src/routes/`, registered in `routes/index.ts`.
2. Validate the body with a schema from `packages/shared`. Do not define a
   second shape locally.
3. SQL goes in `db/repo/`, behaviour goes in `services/`. A route that queries
   the database directly is the thing this layout exists to prevent.
4. If Copilot should be able to do it too, add a wrapper in `mcp/server.ts` —
   over the same service, not a parallel implementation.

---

## Testing strategy

Tests are colocated with their owning source modules. Vitest runs Node tests
and browser-component tests in separate projects, without live provider calls.
API fixtures use temporary directories for file storage and clean them up.

- **`packages/matching`** carries the most tests because it carries the
  accuracy. Fixture JDs assert score _bands_: a near-exact JD ≥ 0.85, a
  Java-heavy JD < 0.6, a snippet-only job capped at 0.80. Bands rather than exact
  numbers, so a weight tweak that is still correct does not fail the suite.
- **`packages/providers`** tests against recorded payloads through a stub HTTP
  client. One test asserts the registry never echoes a credential value.
- **`apps/api`** route tests build a real container over an **in-memory**
  database with a stub HTTP client, then use `app.inject()`. Real routes, real
  repositories, real serialisation — no server, no socket.

Production builds exclude test files and helpers. `npm run typecheck` checks
production projects, then `tsconfig.test.json` and `tsconfig.test.web.json` check
their respective test suites. All passes must be green.

Vitest resolves workspace packages to source entry points, so tests do not rely
on previously generated `dist` exports. `npm run clean && npm test` is supported.
The cleanup command delegates to each workspace, including web declarations and
incremental compiler caches. Runtime data and original resumes are never removed.

`vite build` is in CI on purpose: a Rollup `manualChunks` name is a plain string
invisible to the TypeScript project graph, and a stale one has already broken a
build here after both `tsc` and ESLint passed clean.

---

## Rejected alternatives

| Instead of                                | We use                               | Why                                                                                                                                                           |
| ----------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres                                  | SQLite (`node:sqlite`)               | Single user, single box. No service to run, monitor or back up; the repo layer keeps SQL in one place, so Postgres is a later migration rather than a rewrite |
| `better-sqlite3`                          | `node:sqlite`                        | A built-in means no native build step and no compiler on the deploy host. It is the reason Node 24 is the floor                                               |
| Redis + BullMQ                            | An in-process worker + `search_runs` | Buys horizontal workers this app has no use for, in exchange for another service                                                                              |
| WebSockets                                | SSE                                  | The stream is one-directional. SSE reconnects and replays by `Last-Event-ID` for free                                                                         |
| `EventSource`                             | `fetch` + streaming reader           | `EventSource` cannot set headers, which would force the API key into the URL                                                                                  |
| Playwright scrapers for LinkedIn / Indeed | JSearch                              | Legitimate, attributed, and does not need a browser in the image                                                                                              |
| An ORM                                    | Hand-written SQL in `repo/`          | Eight tables. The ORM would be more code than the SQL, and the queries here are the interesting part                                                          |
| Auto-apply                                | Stopping at the apply link           | Needs a headful browser with a human confirming each submission, and stores portal credentials on disk. Does not translate to a server you reach over HTTP    |
