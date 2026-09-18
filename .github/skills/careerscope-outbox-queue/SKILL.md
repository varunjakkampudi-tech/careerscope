---
name: careerscope-outbox-queue
description: 'Transactional outbox, fenced command executions, lease handling, DLQ reconciliation and idempotency. Use when touching the publisher, workers, queue adapters, command dispatch, or anything that enqueues work.'
---

# CareerScope Outbox And Queue

## Purpose

Work is durable because it is written to PostgreSQL in the same transaction as
the state change that caused it. The queue is a delivery hint that may duplicate
or lose messages. Every rule here protects that separation.

## When to use

- Touching the publisher, the search worker or the files worker
- Changing `commands.ts`, `dispatch.ts`, `queue.ts` or `bull-queue.ts`
- Adding a new command type
- Investigating stuck, duplicated or lost work

## Where the code lives

| Concern                          | Path                                         |
| -------------------------------- | -------------------------------------------- |
| Command schemas and retry policy | `v2/packages/core/src/commands.ts`           |
| Dispatch, fencing, outcomes      | `v2/packages/core/src/dispatch.ts`           |
| SQS-compatible adapter           | `v2/packages/core/src/queue.ts`              |
| BullMQ adapter                   | `v2/packages/core/src/bull-queue.ts`         |
| Outbox reads, leases, backlog    | `v2/packages/core/src/database.ts`           |
| Publisher                        | `v2/apps/workers/search/src/publisher.ts`    |
| Workers                          | `v2/apps/workers/search/src/{main,files}.ts` |

## The rule

**Never publish to the queue from a request handler.** Write the command to
`outbox_events` inside the same transaction as the state change. The publisher
reads unpublished rows and delivers them. This is what makes a crash between
"state changed" and "work enqueued" impossible.

## Delivery semantics

At-least-once. Duplicates are expected and must collapse:

- `idempotency_key` guards creation. A replay with the same key but a different
  request hash is a `Conflict`, not a silent overwrite.
- `command_executions` is fenced. A worker that resumes with a stale fence must
  have its completion rejected.
- Leases bound how long one worker may own a command. An expired lease is
  reclaimable; the original holder must not be able to complete afterwards.

## Correlation

Every settled execution logs
`{executionId, runId, jobType, attempt, fence, outcome, durationMs}` at
completed, dead-lettered and released. Requests log
`{requestId, method, route, status, durationMs, authenticated}`, and search
creation logs `{requestId, runId, status}` so a run traces back to the request
that created it. Preserve these fields; they are the only way to debug
production.

## Backlog signals

`database.backlog()` returns `unpublished`, `running`, `expiredLeases`,
`oldestUnpublishedSeconds` and `oldestRunningSeconds`. Age matters more than
count: a small but ageing backlog means the publisher is wedged.

Note that `database.unpublished()` caps at 20 rows. To find every outbox row for
an aggregate, query directly:

```sql
SELECT id FROM outbox_events WHERE command->>'aggregateId' = $1;
```

There is no `aggregate_id` column.

## Queue transport scope

`SEARCH_QUEUE_TRANSPORT` selects the transport for the **search** queue only. Resume
parsing always uses the loopback SQS endpoint, on both the publisher and the
files worker, so `LOCAL_AWS_ENDPOINT` is required in either mode. The deployed
stack runs the SQS transport for both queues — that is the path the crash matrix
evidence was produced against. Do not describe BullMQ as a complete alternative.

The setting was previously called `QUEUE_TRANSPORT`, which implied a scope it
never had. `configuration()` now throws if the old names are present rather than
reinterpreting them, so a stale deployment fails loudly instead of quietly
running a different topology than its configuration claims.

The queue's state is ephemeral. That is acceptable **only** because the outbox is
authoritative and republishes lost work. Never describe the queue itself as
durable and never move authoritative state into it.

## Forbidden shortcuts

- Publishing inside a request handler
- Deleting an outbox row before delivery is confirmed
- Completing a command without checking the fence
- Treating a duplicate delivery as an error instead of collapsing it
- Retrying a poison message forever instead of dead-lettering it
- Swallowing a worker error so the job silently disappears

## Failure modes to test

Crash after queue send but before the database acknowledges; crash after the
exclusive hardlink but before the version record; crash while holding a live
lease; duplicate delivery of the same command; malformed message; poison message
exceeding retries; operator restarts the whole stack.

## Verification

```sh
npm --prefix v2 test
npm --prefix v2 run test:crash-recovery   # four real SIGKILL phases
```

The crash harness asserts: outbox work retained and the duplicate collapsed to
one run; stale fence rejected and the run settled once; an orphaned object
adopted with no duplicate and the alias reclaimed. Use real signals, not mocks.
