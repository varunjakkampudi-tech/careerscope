# Transactional outbox and queue guarantees

Code: `packages/core/src/database.ts` (outbox, claim, settle), `dispatch.ts`
(publisher and consumer), `queue.ts` (Redis transport through BullMQ).
Tests: `packages/core/src/outbox.integration.test.ts` (failure injection),
`packages/core/src/queue.integration.test.ts`, and the outbox section of
`tests/integration/database.integration.test.ts`.

## Model

1. The API writes the run and its command (`outbox_events`) in one PostgreSQL
   transaction. A command exists if and only if its run exists.
2. The publisher (`publishPending`) reads unpublished rows, sends them to Redis,
   then sets `published_at`. Redis is only a transport, never the source of truth.
3. A worker (`consumeMessage`) checks the message against the stored command,
   takes a fenced lease (`command_executions`: `claim`, `renew`, `release`),
   runs the handler, and settles in a single transaction that re-checks the
   fence. Only then does it acknowledge the Redis message.

## Guarantees

| Failure                                                  | Behaviour                                                                                                                                                                                                 | Test                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Worker claims a message and dies before acknowledging    | BullMQ stalled-job check returns the job to waiting (lock 60 s, check every 15 s, two passes); receive count increases                                                                                    | claimed but never acknowledged is redelivered |
| Worker dies mid-command                                  | The outbox row is untouched. After the lease lapses, `unpublished()` returns it, the publisher re-sends it, the next claim gets a higher fence. The dead worker cannot renew or settle with its old fence | worker crash mid-command                      |
| Same command delivered twice                             | Effects apply once: the second delivery is `duplicate` (already completed) or `busy` (still running). Job inserts are idempotent per run and fingerprint                                                  | duplicate deliveries / refused as busy        |
| Publisher dies between send and `published_at`           | The row stays pending and is sent again; consumers de-duplicate through fences                                                                                                                            | duplicate deliveries                          |
| Redis is down while work is accepted                     | The command is committed with the run. `publishPending` throws and does not mark rows published, so nothing is lost. The next run after Redis returns drains them                                         | Redis outage never loses committed rows       |
| Redis loses data after a row was published               | A row published more than two minutes ago with no completed or live-leased execution is re-sent                                                                                                           | message lost from Redis is re-sent            |
| Retry budget spent (more than five claims or deliveries) | The command is failed in PostgreSQL and the run becomes `failed`; the message is dead-lettered and observable                                                                                             | database.integration.test.ts, queue test      |
| Cancellation races with completion                       | Cancellation bumps the fence; whichever transaction commits first wins and the other is refused                                                                                                           | database.integration.test.ts                  |

Delivery is at-least-once; effects are exactly-once per command because the
database fence, not the queue, decides which attempt may apply them.

## Limits and operating notes

- A message that is refused as `busy` is not acknowledged. If the first
  holder finishes, the message later arrives as `duplicate` and is
  acknowledged; if the holder dies, it is redelivered. This can delay but not
  lose work.
- Recovery of a lapsed lease for a message that Redis still holds depends on
  the stalled-job check, so worst-case redelivery latency after a worker crash
  is about 60 s plus up to 30 s. Rows missing from Redis are recovered by the
  publisher after the two-minute republish window.
- Queue Redis must run with AOF and `noeviction` (`LocalQueue.initialize`
  refuses to start otherwise). If Redis is lost entirely, the outbox republish
  window restores in-flight commands; completed work is unaffected.
- The queue connection must carry the Redis password from `QUEUE_REDIS_URL`.
  A defect that dropped it (every queue call failed with NOAUTH against the
  authenticated local Redis) was found by these tests and fixed in `queue.ts`.
