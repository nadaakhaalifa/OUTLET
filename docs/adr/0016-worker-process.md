# ADR-0016: Worker process (outbox dispatch, inbox consumers, rollup scheduler)

- Status: **Accepted** (2026-11-10). Two-key area (it composes the finance.refunds, checkout.settle, late-refund and inventory-release consumers and holds an outlet_app credential): fresh-context chief review done (REJECT → fixes F1–F7, F9, F10 applied → APPROVE WITH FIXES, residuals applied); owner approval given 2026-11-10 ("approve ADR-0015 and ADR-0016").
- **Owner approval (two-key):** the outlet_app uses listed in Decision 5 and migration 0037 were approved by the owner on 2026-11-10. Any new outlet_app use in the worker reopens this ADR.
- Revision 2 (2026-11-10): chief review of 922f4d9..86480d7 (REJECT on F1-F4) applied: F1-F7, F9, F10. F8 and F11 are deferred follow-ups (see "Not done / open").
- Date: 2026-11-10
- Relates to: ADR-0011 (roles, worker jobs, relay per market), ADR-0014 (API vs worker pools), ADR-0015 (rollup cadence), ADR-0029 (unconfigured adapters fail closed).
- Code: `apps/api/src/worker.ts`, `apps/api/src/worker/{config,jobs,runner,scheduler,leader,health,main,bounded}.ts`, `packages/outbox/src/dispatch.ts`, migrations `0036_outbox_dispatch_lease.sql` and `0037_worker_flag_read.sql`.

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
- Claim (positive list, F1): `UPDATE ... SET lease_until = now + lease FROM (SELECT ... WHERE published_at IS NULL AND dead_lettered_at IS NULL AND (lease_until IS NULL OR lease_until <= now) AND event_type = ANY(routable types) ORDER BY id LIMIT batch FOR UPDATE SKIP LOCKED)`. Routable = every type owned by at least one consumer whose owners are ALL enabled, plus the explicit allow-list `UNSUBSCRIBED_TYPES` (`ops.attention_opened`, `shipment.cancelled`, `inventory.committed_released`) that may be acked without a handler. Any other type is never claimed and never acked: it stays pending and appears in `/healthz` (`unrouted: {pending, lag_seconds, types}`) and the `worker_unrouted_pending` / `worker_unrouted_lag_seconds` gauges. Lease = batch x handler timeout + 60 s, capped at 15 minutes by `parseWorkerEnv` (F5).
- Owners (F2): an event type may have several consumers (`seller_order.rejected`: the cancellation refund AND the rejected-order inventory release). The runner runs all of them in registration order, each in its own inbox transaction; any failure fails the event, and on the retry the owners that already succeeded dedupe in their inbox. A type is held back if ANY owner is kill-switched.
- Consumers composed (one per row; name = status / metrics label, not always the DB job):

  | Name | Event types | DB role / job | Kill switch |
  |---|---|---|---|
  | finance.refunds | seller_order.cancelled, seller_order.rejected | worker / finance.refunds | workers.finance.refunds.enabled (money) |
  | checkout.settle | promotions.settle_requested | worker / checkout.settle (+ app, voucher confirm) | workers.checkout.settle.enabled (money) |
  | shipping.tracking | shipment.cancel_required | worker / shipping.tracking | workers.shipping.tracking.enabled |
  | inventory.rejected_release | seller_order.rejected | worker / shipping.tracking (narrowed to the owner) | workers.inventory.release.enabled |
  | inventory.release | inventory.release_required | **app**, store context | workers.inventory.release.enabled |
  | ops.attention | refund.attention, promotions.settle_attention, shipment.cancel_attention | worker / ops.attention | workers.ops.attention.enabled |
  | reporting.rollup | reporting.rollup_requested | worker / reporting.rollup | workers.reporting.rollup.enabled |
  | payments.late_refund | order_group.late_payment_refund | worker / payments.webhook | workers.finance.refunds.enabled (money); composed ONLY when a PSP RefundPort is configured |

- Deliberately unrouted today (stay pending, visible as unrouted lag; never lost): `order_group.late_payment_refund` (no PSP: retrying a rejecting port would only dead-letter a money event); the search sync types `listing.activated`, `listing.updated`, `price.changed`, `inventory.sold_out`, `inventory.restocked` (`SearchIndexSync` exists in `@outlet/search`, but apps/api has no dependency on it and the `search.sync` job's write policies are not verified: composing it is a follow-up with a lockfile change); notification triggers consumed by `@outlet/notifications` `Dispatcher` (no channel providers configured); every other type with no consumer (order_group.placed/paid/..., payout.*, return.*, privacy.*, seller.*, store.*).
- Handler: runs its own inbox transaction under its own role and job (table above), with a span, a timeout (default 20 s) and metrics. Every consumer transaction carries `SET LOCAL statement_timeout` = the handler timeout (`boundedClient`, F3), so a single statement of work abandoned after a timeout cannot run past the budget (a multi-statement handler may still overlap the retry by more than one budget; `transaction_timeout` on PostgreSQL 17+ is the follow-up).
- Ack: `published_at`, lease cleared. Failure: `attempts + 1`, `last_error` = error name and code only (never the message: it may echo payload fields), lease pushed by max(`2^attempt` s capped at 5 min, handler timeout) (F3: an event abandoned after a timeout is not claimable again before the handler budget has passed). At `WORKER_MAX_ATTEMPTS` (default 8: seven backoffs of 2 to 128 s, about 4 minutes of retries) the row is dead-lettered with a payload-free `dlq_messages` row (`consumer = 'outbox-dispatch'`, `{event_type}` only; the event is read back by id for a replay). If an ack or fail write throws, every claimed row not yet settled is released (lease cleared) on a best-effort basis before the error propagates (F5).
- Ordering: id order per poll; a failing event backs off while later events proceed. No consumer relies on cross-event order (all are idempotent per entity).
- Poll loop: a full batch polls again at once; otherwise sleep `WORKER_POLL_MS`, doubling while idle up to `WORKER_POLL_MAX_MS`; a failed poll sleeps the maximum.

## Decision 3: kill switches
`workers.<job>.enabled` in the `@outlet/flags` registry, checked every loop turn (FlagService, 5 s cache): `workers.outbox.relay.enabled` (off = nothing is claimed), `workers.finance.refunds.enabled` and `workers.checkout.settle.enabled` (class money: an unreachable flag store means killed), `workers.shipping.tracking.enabled`, `workers.ops.attention.enabled`, `workers.reporting.rollup.enabled` (fail open). A killed job's event types are excluded from the claim: they stay unpublished with no attempt spent, keep their place, and show in health as pending with growing lag. A killed rollup job also stops the scheduler from emitting ticks for that market. The switches are also re-read per event (`shouldSkip`, F6, from the FlagService cache): a switch flipped mid-batch releases the remaining events of that job with no attempt spent. `workers.inventory.release.enabled` (fail open) covers both inventory consumers. Kill switches are read on the WORKER pool (migration 0037, F4a), so the money switches never depend on the outlet_app credential.

## Decision 4: scheduler and leader election
| Option | Fit |
|---|---|
| Session advisory lock held by the leader | Not usable: PgBouncer runs in transaction mode, the session is not ours |
| **Per-tick transaction advisory lock + deterministic tick id (chosen)** | `pg_try_advisory_xact_lock(hashtextextended('worker.scheduler|market|scope'))` elects one emitter per attempt; the tick id is a UUIDv7 whose timestamp is the window start and whose random bits are SHA-256 of (market, window), inserted `ON CONFLICT (id) DO NOTHING`. Even if two replicas both pass the lock one after the other, the database keeps one tick per window |

Cadence (ADR-0015): `snapshots` every 60 s window, `sales` every 5 min window, `nightly` once per market-local date (Africa/Cairo for EG) and only while the local time is 00:00 to 06:00, so a daytime restart never starts a 90-day re-run. The tick is written as job `outbox.relay` (already allowed to INSERT `outbox_events` by 0007), payload `{scope, window}`.

## Decision 5: operations
- **Env** (`parseWorkerEnv`, Zod; errors name variables, never values): `DATABASE_URL_WORKER` and `DATABASE_URL_APP` both required, else the process exits.
- **outlet_app uses (F4b; deviation from ADR-0011 "the worker process never holds outlet_app credentials")**: the app client lives on its own pool (max 2, `application_name` `worker.app`, F4c) and is named only in `apps/api/src/worker/jobs.ts`; an eslint `no-restricted-syntax` rule (`eslint.config.mjs`) forbids the `outlet_app` literal anywhere else under `apps/api/src/worker*` (F4d). The complete list:
  1. `productionPromotionsPort` (checkout.settle): the voucher confirm runs in the shopper's user context (finding 11); its own `promotions.enabled` read goes through the worker-pool FlagService.
  2. `ReleaseRequiredConsumer` (inventory.release): lowers `inventory_levels.committed` in the event's store context, the same context ReservationService uses; no worker policy exists on inventory for it.
  3. `InventoryRestock` (RefundService restock port): only called by return restocks, never by `createForCancellation`; composed because RefundService requires the port.
  4. `createAdminAccess` (RefundService approvals): composed with an always-failing audit sink, so it can never complete an approval from the worker.
  Removing them needs worker-job policies for vouchers and inventory levels (a migration each) and a RefundService split; tracked below.
- **Graceful shutdown**: SIGTERM/SIGINT stop claiming; the handler in flight finishes; the rest of the claimed batch is released (lease cleared); bounded by `WORKER_DRAIN_MS` (max 30 s). A handler still running at the deadline is abandoned: its lease expires and the event is redelivered (inbox dedup). When not drained the process sets exit code 1 and force-exits 2 s later (`setTimeout(...).unref()`, F7) so an abandoned handler cannot keep it alive. An `unhandledRejection` logs its error code and exits 1 (F7).
- **Health** on its own port (`WORKER_HEALTH_PORT`, default 9464): `GET /livez` (200/503: every market loop and the scheduler beat within 3 × max(poll max, scheduler interval) + 30 s); `GET /healthz` with relay and per-consumer `killed`, `pending`, `lag_seconds` (age of the oldest unpublished event of the job's types, refreshed every `WORKER_LAG_MS`). Job names, counts, timestamps and error codes only.
- **Telemetry**: span `worker.handle` per event (job, event type, event id, market); metrics `worker_handler_seconds`, `worker_relay_{claimed,failed,dead_lettered}_total`, `worker_scheduler_ticks_total`, `worker_consumer_lag_seconds`, `worker_consumer_pending` (`createWorkerMetrics` in `@outlet/observability`). Logs are structured (`@outlet/logger`, redacted) and carry ids, types and codes, never payloads.
- **Unconfigured adapters** (ADR-0029): the refunds consumer gets a `RefundService` whose PSP port rejects (`provider_unconfigured`); `createForCancellation` only records REQUESTED refunds and execution checks `refunds.enabled` (fail closed). The courier port answers `not_cancellable`, so `ShipmentCancelConsumer` parks the event as `shipment.cancel_attention` for ops instead of looping into the DLQ.

## Consequences
- Migration 0036 (one nullable column, P1, tagged in `data_inventory.yaml`); migration 0037 (`GRANT SELECT ON feature_flags TO outlet_worker`, no RLS on that table by design, no other privilege).
- `outbox_events.last_error` is retagged P1: both relays store an error code (name and code), never the message (F9). The legacy `OutboxRelay` (only composed in tests) also writes `{event_type}` instead of the payload to `dlq_messages`.
- Stale rollup ticks (F10): `RollupConsumer` consumes a `snapshots` or `sales` tick whose window is more than two windows old without work (inbox row + info log), so a backlog after an outage or a released kill switch runs once, not once per missed window. **Runbook note:** `nightly` has no catch-up: if the worker is down for the whole 00:00-06:00 local window, that night's 90-day re-run is skipped (the 5-minute sales tick still recomputes the last 3 days); to force one, insert a `reporting.rollup_requested` `{scope: "nightly"}` event as job outbox.relay or wait for the next night.
- `OutboxRelay` (publish inside the claim transaction) ignores leases; do not run it against the same table as the worker.
- The rollup tiles refresh at most one window late; parked events reach the ops queue within one poll.
- Deployment: run `pnpm --filter api worker` (`node dist/worker.js`) as its own service from the API image; no Dockerfile or Procfile exists yet (infra/local has only backing services). Scale replicas freely: claims are disjoint and ticks are deduplicated.

## Not done / open
- DLQ replay tool (re-arm `dead_lettered_at = NULL, attempts = 0` with audit) and an admin view of `dlq_messages`.
- Retention purge of published outbox rows (60 days per `data_inventory.yaml`) is not a scheduled job yet.
- Other worker jobs in `WORKER_JOBS` (privacy.deletion, privacy.retention, auth.purge, checkout.expiry, orders.close, finance.payouts, finance.reconcile, search.sync, notifications.dispatch, pricing.channels) are not composed here: they are cron-style jobs, not inbox consumers, and get their own scheduler entries when their adapters exist.
- Real-Postgres proof of disjoint claims across two connections (PGlite serialises transactions): add to `packages/db/test-pg`.

- **F8 and F11 (chief review, deferred by the coordinator):** follow-ups recorded here as accepted for a later revision; see the chief review record for their text.
- Compose `SearchIndexSync` (`search.sync`) and the notifications `Dispatcher` as worker consumers (dependencies, job policies, providers); until then their types stay unrouted and visible.
- Remove the outlet_app uses 1-4 (worker-job policies for voucher confirm and inventory levels; split RefundService so the worker path needs no restock or admin port).