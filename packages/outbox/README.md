# @outlet/outbox

Transactional outbox, idempotent inbox, relay with retry and DLQ, and pure saga orchestration (spec A2.7, A2.8). Everything is dependency-free TypeScript; persistence and brokers are ports with in-memory development adapters.

## Delivery guarantee

**At-least-once. This package never provides exactly-once delivery and nothing here should be described that way.**
- The relay may publish a record more than once (crash after publish, before `markPublished`).
- The broker may redeliver (crash after the side effect, before ack).
- Consumers are made idempotent with the inbox: the `(consumer, message_id)` row and the side effect commit in one transaction, so database effects happen once per message id ("effectively once").
- Effects outside the database transaction (HTTP calls, push, email) are not covered and need their own idempotency key.

## Pieces

| Module | Role |
|---|---|
| `record.ts` | `OutboxRecord`, `createOutboxRecord` (validation, injected id and clock) |
| `relay.ts` | `OutboxRelay.runOnce` poll, publish, mark; backoff; DLQ; `replay`, `replayAll` |
| `backoff.ts` | exponential backoff with equal jitter, injected `random` |
| `inbox.ts` | `InboxConsumer.consume` dedupe inside a `UnitOfWork` |
| `saga.ts` | step model, pure reducer, checkout, checkout COD, refund, payout, cancellation definitions |
| `memory.ts` | `MemoryDatabase`, `MemoryBroker`: development and test fixtures only |

## Column contract (for the db agent)

Migration `packages/db/migrations/0004_idempotency_outbox_inbox.sql` already defines most of this. Fields marked NEW are required by the relay and are missing from 0004 (expand migration needed).

### `outbox_events`

| Column | Type | Record field | Notes |
|---|---|---|---|
| `id` | uuid PK | `id` | uuidv7 from the application; becomes the broker `messageId` and the inbox key |
| `occurred_at` | timestamptz | `occurredAt` | set from the injected clock |
| `aggregate_type` | text | `aggregateType` | non-empty |
| `aggregate_id` | uuid | `aggregateId` | |
| `event_type` | text | `eventType` | `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$` |
| `event_version` | int >= 1 | `eventVersion` | |
| `ordering_key` | text null | `orderingKey` | defaults to `aggregate_type:aggregate_id`; null means unordered |
| `payload` | jsonb | `payload` | P0 to P2 only; money as string minor units, never a number |
| `headers` | jsonb | `headers` | |
| `published_at` | timestamptz null | `publishedAt` | set by `markPublished` |
| `publish_attempts` | int | `publishAttempts` | total attempts made |
| `last_error` | text null | `lastError` | error class and truncated message (500 chars), no payload |
| `next_attempt_at` | timestamptz null | `nextAttemptAt` | **NEW**: backoff schedule; null means due now |
| `dead_lettered_at` | timestamptz null | `deadLetteredAt` | **NEW**: non-null means in the DLQ |

Required index (NEW): partial on `(occurred_at, id) WHERE published_at IS NULL AND dead_lettered_at IS NULL`. The immutability trigger in 0004 must also allow `next_attempt_at` and `dead_lettered_at` updates (they are bookkeeping, not content).

### `inbox_processed`

`(consumer text, message_id uuid, processed_at timestamptz)`, `PRIMARY KEY (consumer, message_id)`. `tryRecord` is `INSERT ... ON CONFLICT DO NOTHING` and returns whether a row was inserted (`rowCount = 1`), executed inside the consumer's own transaction.

### Claim query semantics (`OutboxStore.claimDue`)

1. Rows with `published_at IS NULL`, ordered by `occurred_at, id`, `FOR UPDATE SKIP LOCKED`, limited to the batch size.
2. Exclude a row if an earlier unpublished row with the same non-null `ordering_key` is dead-lettered or has `next_attempt_at > now` (this keeps per-aggregate order; a `NOT EXISTS` subquery).
3. Exclude rows with `dead_lettered_at IS NOT NULL` or `next_attempt_at > now`.

`markPublished`, `recordFailure`, `deadLetter` and `replay` are single-row updates. `replay` sets `dead_lettered_at = NULL, publish_attempts = 0, next_attempt_at = NULL` and must refuse rows that are not dead-lettered.

### Saga state (NEW table, not in 0004)

`saga_instances(saga_id uuid PK, definition text, status text, completed_steps text[], compensated_steps text[], failed_step text, failure_reason text, stuck_reason text, updated_at)`, updated in the same transaction as the event or command it reacts to. Mirrors `SagaState`.

## Behaviour to know

- **Ordering** is per `ordering_key`, by `occurred_at, id`. A failing or dead-lettered head blocks later events of that key until it succeeds or is replayed. Ordering is chosen over availability (see decisions).
- **Known ordering caveat**: `occurred_at` defaults to transaction start, not commit time. Two concurrent transactions touching the same aggregate could commit out of `occurred_at` order. Row-locking the aggregate in the writing transaction, or a per-aggregate sequence number, closes this. Not verified here.
- **Retry**: attempt `n` waits a random delay in `[ceiling/2, ceiling]`, `ceiling = min(cap, base * 2^(n-1))`. `PermanentPublishError` goes straight to the DLQ.
- **Sagas** are pure: `nextCommand` says what to run, `applyEvent` folds results back. Duplicate events are no-ops; a late success of a step already given up on is compensated (or escalated to `stuck` if it was the pivot). After the pivot a permanent failure is `stuck`, never compensated.
- **In-memory adapters** emulate commit and rollback with snapshots. They do not model concurrent writers or SKIP LOCKED; that needs tests against Postgres.

## VERIFY BEFORE LAUNCH

- PSP void versus refund semantics, timing and idempotency per provider (checkout compensation `payments.void_intent`, refund pivot `payments.refund`).
- Payout rail and settlement behaviour (`payouts.initiate_transfer`) and the licensing that governs it.
- Retry and DLQ numbers (`maxAttempts`, base, cap) are placeholders, not tuned values.
