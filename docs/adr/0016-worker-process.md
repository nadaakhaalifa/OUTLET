# ADR-0016: Worker process (outbox dispatch, inbox consumers, rollup scheduler)

- Status: **Proposed**. Two-key area (it composes the finance.refunds and checkout.settle consumers): needs a fresh-context review and owner approval before merge (`needs-human`).
- Date: 2026-11-10
- Relates to: ADR-0011 (roles, worker jobs, relay per market), ADR-0014 (API vs worker pools), ADR-0015 (rollup cadence), ADR-0029 (unconfigured adapters fail closed).
- Code: `apps/api/src/worker.ts`, `apps/api/src/worker/{config,jobs,runner,scheduler,leader,health,main}.ts`, `packages/outbox/src/dispatch.ts`, migration `0036_outbox_dispatch_lease.sql`.

## Context
The consumers exist (`apps/api/src/worker-consumers.ts`: finance.refunds, checkout.settle, shipping.tracking, ops.attention, reporting.rollup) but nothing runs them: no process polls the outbox, no scheduler emits `reporting.rollup_requested`, so the admin rollups never refresh and parked events never reach ops. There is no message broker (Redis is optional and never a source of truth).

## Decision 1: where the worker lives
| Option | Complexity | Fit |
|---|---|---|
| **A. Second entry point in apps/api (`node dist/worker.js`) (chosen)** | Low: reuses the dispatch tables and composition helpers in apps/api (`productionPromotionsPort`, the returns adapters) | One image, two commands; the worker never listens on the API port |
| B. New `apps/worker` | Medium: it would import from apps/api (app-to-app import, forbidden by dependency-cruiser) or the tables and helpers must move into a package first | Cleaner split once the worker grows its own dependencies |

A wins today because B needs a refactor with no behaviour change first. Revisit when the worker needs a dependency the API must not ship (or vice versa).

## Decision 2: how an event reaches its consumer
| Option | Complexity | Correctness | Cost | Scalability |
|---|---|---|---|---|
| A. Existing `OutboxRelay`, publisher = in-process handler call inside the claim transaction | None new | Holds row locks while the handler runs on a second connection; a kill-switched consumer burns attempts into the DLQ; untestable on PGlite (nested transactions deadlock) | 2 connections per market loop | Long lock hold under slow ports |
| **B. Leased dispatch: claim (lease) → handler → ack, three short transactions (chosen)** | One nullable column (`outbox_events.lease_until`) + `OutboxDispatchRelay` | Disjoint claims across replicas (SKIP LOCKED + lease); crash before ack = lease expiry = redelivery (inbox dedup); per-row exponential backoff; killed types are not claimed at all | 1 connection at a time | Replicas scale out on disjoint rows |
| C. Broker (BullMQ/SQS) between relay and consumers | New dependency and ops surface | Good | Redis HA or cloud queue | Best at high volume |

B is chosen: correct at-least-once with no new infrastructure, and the lease gives backoff and kill-switch parking for free. C stays the path when volume needs it (the `Publisher` port of `OutboxRelay` remains for that).

### Dispatch rules
- One relay loop per market (relay policies pin `app.current_market_id()`), as `outlet_worker` job `outbox.relay`.
- Claim: `UPDATE ... SET lease_until = now + lease FROM (SELECT ... WHERE published_at IS NULL AND dead_lettered_at IS NULL AND (lease_until IS NULL OR lease_until <= now) AND NOT event_type = ANY(killed types) ORDER BY id LIMIT batch FOR UPDATE SKIP LOCKED)`. Lease = batch × handler timeout + 60 s, so a slow batch is never claimed twice.
- Each event type has exactly one in-process consumer (`assertDisjoint` refuses a type registered by two jobs). A type with no consumer (for example `ops.attention_opened`) is acked as published, like a bus with no subscriber.
- Handler: runs its own inbox transaction under its own job (finance.refunds, checkout.settle, shipping.tracking, ops.attention, reporting.rollup), with a span, a timeout (default 20 s) and metrics.
- Ack: `published_at`, lease cleared. Failure: `attempts + 1`, `last_error` = error name and code only (never the message: it may echo payload fields), lease pushed by `2^attempt` s (max 5 min). At `WORKER_MAX_ATTEMPTS` (default 8: seven backoffs of 2 to 128 s, about 4 minutes of retries) the row is dead-lettered with a payload-free `dlq_messages` row (`consumer = 'outbox-dispatch'`, `{event_type}` only; the event is read back by id for a replay).
- Ordering: id order per poll; a failing event backs off while later events proceed. No consumer relies on cross-event order (all are idempotent per entity).
- Poll loop: a full batch polls again at once; otherwise sleep `WORKER_POLL_MS`, doubling while idle up to `WORKER_POLL_MAX_MS`; a failed poll sleeps the maximum.

## Decision 3: kill switches
`workers.<job>.enabled` in the `@outlet/flags` registry, checked every loop turn (FlagService, 5 s cache): `workers.outbox.relay.enabled` (off = nothing is claimed), `workers.finance.refunds.enabled` and `workers.checkout.settle.enabled` (class money: an unreachable flag store means killed), `workers.shipping.tracking.enabled`, `workers.ops.attention.enabled`, `workers.reporting.rollup.enabled` (fail open). A killed job's event types are excluded from the claim: they stay unpublished with no attempt spent, keep their place, and show in health as pending with growing lag. A killed rollup job also stops the scheduler from emitting ticks for that market.

## Decision 4: scheduler and leader election
| Option | Fit |
|---|---|
| Session advisory lock held by the leader | Not usable: PgBouncer runs in transaction mode, the session is not ours |
| **Per-tick transaction advisory lock + deterministic tick id (chosen)** | `pg_try_advisory_xact_lock(hashtextextended('worker.scheduler|market|scope'))` elects one emitter per attempt; the tick id is a UUIDv7 whose timestamp is the window start and whose random bits are SHA-256 of (market, window), inserted `ON CONFLICT (id) DO NOTHING`. Even if two replicas both pass the lock one after the other, the database keeps one tick per window |

Cadence (ADR-0015): `snapshots` every 60 s window, `sales` every 5 min window, `nightly` once per market-local date (Africa/Cairo for EG) and only while the local time is 00:00 to 06:00, so a daytime restart never starts a 90-day re-run. The tick is written as job `outbox.relay` (already allowed to INSERT `outbox_events` by 0007), payload `{scope, window}`.

## Decision 5: operations
- **Env** (`parseWorkerEnv`, Zod; errors name variables, never values): `DATABASE_URL_WORKER` and `DATABASE_URL_APP` both required, else the process exits. The app pool is needed for two reads `outlet_worker` has no grant for by design: `feature_flags` (kill switches) and the voucher confirm in the shopper's user context (finding 11). **Deviation from ADR-0011** ("the worker process never holds outlet_app credentials"): accepted until a migration grants `outlet_worker` a column-limited SELECT on `feature_flags` and promotions confirm moves to a worker job; recorded here for the chief reviewer.
- **Graceful shutdown**: SIGTERM/SIGINT stop claiming; the handler in flight finishes; the rest of the claimed batch is released (lease cleared); bounded by `WORKER_DRAIN_MS` (max 30 s). A handler still running at the deadline is abandoned: its lease expires and the event is redelivered (inbox dedup). Exit code 1 when not drained.
- **Health** on its own port (`WORKER_HEALTH_PORT`, default 9464): `GET /livez` (200/503: every market loop and the scheduler beat within 3 × max(poll max, scheduler interval) + 30 s); `GET /healthz` with relay and per-consumer `killed`, `pending`, `lag_seconds` (age of the oldest unpublished event of the job's types, refreshed every `WORKER_LAG_MS`). Job names, counts, timestamps and error codes only.
- **Telemetry**: span `worker.handle` per event (job, event type, event id, market); metrics `worker_handler_seconds`, `worker_relay_{claimed,failed,dead_lettered}_total`, `worker_scheduler_ticks_total`, `worker_consumer_lag_seconds`, `worker_consumer_pending` (`createWorkerMetrics` in `@outlet/observability`). Logs are structured (`@outlet/logger`, redacted) and carry ids, types and codes, never payloads.
- **Unconfigured adapters** (ADR-0029): the refunds consumer gets a `RefundService` whose PSP port rejects (`provider_unconfigured`); `createForCancellation` only records REQUESTED refunds and execution checks `refunds.enabled` (fail closed). The courier port answers `not_cancellable`, so `ShipmentCancelConsumer` parks the event as `shipment.cancel_attention` for ops instead of looping into the DLQ.

## Consequences
- Migration 0036 (one nullable column, P1, tagged in `data_inventory.yaml`); no policy or grant change.
- `OutboxRelay` (publish inside the claim transaction) is unchanged and ignores leases; do not run it against the same table as the worker.
- The rollup tiles refresh at most one window late; parked events reach the ops queue within one poll.
- Deployment: run `pnpm --filter api worker` (`node dist/worker.js`) as its own service from the API image; no Dockerfile or Procfile exists yet (infra/local has only backing services). Scale replicas freely: claims are disjoint and ticks are deduplicated.

## Not done / open
- DLQ replay tool (re-arm `dead_lettered_at = NULL, attempts = 0` with audit) and an admin view of `dlq_messages`.
- Retention purge of published outbox rows (60 days per `data_inventory.yaml`) is not a scheduled job yet.
- Other worker jobs in `WORKER_JOBS` (privacy.deletion, privacy.retention, auth.purge, checkout.expiry, orders.close, finance.payouts, finance.reconcile, search.sync, notifications.dispatch, pricing.channels) are not composed here: they are cron-style jobs, not inbox consumers, and get their own scheduler entries when their adapters exist.
- Real-Postgres proof of disjoint claims across two connections (PGlite serialises transactions): add to `packages/db/test-pg`.
