# Redis and background workers review

Review date: 2026-11-06

Scope: owner roadmap Stage 01 item 1.05, “Review Redis and workers”

Repository baseline: `dev` merge `593dfb5cb70b677fe42fc01f89844ad1a93ef49f`

## Result

The reviewed Redis and worker design is consistent with the durable PostgreSQL outbox model. Redis is a loopback-only transport; the database remains the command source of truth, and workers use database leases/fences before acknowledging effects. The review found no structural change needed for the registered item. Existing service tests exercise the important delivery, failure, and recovery paths.

## Verified design

- `infra/docker/compose.canonical.yml` pins Redis 7.4.5 by digest. The general-purpose cache service is separate from `redis-queue`; queue Redis has a persistent volume, authentication, append-only persistence with `appendfsync everysec`, a bounded memory limit, and `noeviction`.
- `packages/core/src/queue.ts` and `bull-queue.ts` reject non-loopback Redis URLs, nonzero database paths, query strings, and fragments. Queue connections carry optional ACL credentials and bounded connection/command timeouts. Queue startup checks require AOF and `noeviction`.
- `publisher.ts` publishes committed outbox commands and only marks them published after queue acceptance. It retries failed publication, reconciles failed LocalQueue deliveries, and reports durable backlog and dead-letter state. `main.ts` and `files.ts` consume commands through the database settlement/fencing paths and close worker, queue, and database resources during shutdown.
- `OUTBOX.md` documents at-least-once transport delivery, database-fenced effects, Redis outage recovery, and the two-minute republish window. Queue retention and retry limits are explicit in the transport implementations.

## Verification

- `npm run test:integration` passed on 2026-11-06. It covered the service-backed outbox, Redis LocalQueue, recovery, database, and application integration suites; the appended BullMQ suite also passed (2 tests, 0 failures). The Windows run skipped the POSIX SIGTERM/SIGINT child-process checks.
- `npm run test:queue-runtime` passed on rerun (1 test, 0 failures). It created isolated Redis containers and volumes, restarted Redis with AOF data, restored a copied volume, ran publisher and worker processes, and checked bounded startup failure when Redis was unavailable. Its first attempt reported an aggregate fixture failure without an underlying cause; an immediate rerun completed successfully without source changes.
- Local Node was v22.23.2, while the repository requires Node 24 or newer. These local results are useful service evidence but do not replace the exact-commit hosted CI gates, which must run after this review commit is pushed.

## Limits and follow-up

- The periodic publisher status includes Redis depth only for `LocalQueue`; in BullMQ mode it reports PostgreSQL backlog but not queue wait/active/failed counts. Database recovery remains durable, but operators have less direct queue-depth visibility in that mode. This is retained as an observability follow-up for the owning checklist item, not a finding that invalidates the existing transport or recovery behavior.
- `main.shutdown.integration.test.ts` covers the search worker's signal shutdown on POSIX; it skips on Windows. The publisher and files-worker entry points do not have equivalent signal integration tests. Hosted Linux CI is required for the search-worker signal assertions.
- This review verifies local architecture and automated behavior. It does not claim production telemetry, production load, deployment, Hostinger configuration, or server-backup validation. Hostinger, backups, and deployment are outside the current owner-approved scope.

## Disposition

Checklist item 1.05 is verified for the registered Redis and worker architecture and automated behavior. Preserve PostgreSQL as the durable command source, retain the loopback/AOF/`noeviction` safeguards, and keep the noted observability and signal-test limits visible in later checklist work.
