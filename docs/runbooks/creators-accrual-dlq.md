# Runbook: creators accrual or attribution dead-lettered

Applies when creators is composed (it is blocked and dark today, ADR-0037 / VR-P3-03). While it is blocked
the worker acknowledges these events unrouted and nothing here can fire.

## Why events dead-letter
`CreatorEventConsumer` throws `CreatorEventDeferredError` so the outbox relay retries with backoff:

- `order_line.closed` whose accrual is `deferred` (the producer stated `open_returns: null` or
  `return_window_ends_at_ms: null`, or the window or an open return is still pending).
- `order_group.paid` / `order_group.cod_confirmed` whose attribution is `held` (identity or referral
  check unavailable).

After `maxAttempts` (8, backoff 500 ms to 60 s) the relay dead-letters the event. A dead-lettered line is
NOT accrued: the creator is under-paid until it is replayed. Nothing is lost; the outbox row keeps the payload.

## Signal
- Gauge `outlet.outbox.dead_lettered{event_type}` (first 500 dead letters per run; set to 0 for the
  creators-relevant types once cleared). Alert: `outlet_outbox_dead_lettered{event_type=~"order_line.closed|order_group.paid|order_group.cod_confirmed|order_line.refunded"} > 0` for 15 minutes.
- Worker log `outbox.relay` summary with `deadLettered > 0`.

## Triage
1. List the dead letters for the type (outbox admin tooling, same as `webhook-dlq-replay.md`). Read `last_error`.
2. `CreatorEventDeferredError`:
   - `order_line.closed`: check the orders producer. `open_returns: null` means orders runs without a
     `LineReturnsPort` (a bindings regression: `assertCreatorsOrdersPrerequisites`). Fix the binding first.
     Otherwise a return is still open: wait for it to reach a terminal state.
   - `order_group.paid`: check identity and referral availability.
3. Do not replay while the cause persists: it only dead-letters again.

## Replay
1. Fix the cause.
2. Replay the dead-lettered rows (oldest first) with the relay replay operation (`OutboxRelay.replayAllDeadLettered`).
   Replay is safe: the inbox dedupes by message id, accrual is unique per order line, attribution is
   unique per order group, and the ledger posts are idempotent (`creator_commission:{id}:{seq}`).
3. Confirm the gauge returns to 0 and that `commission.accrued` events follow for the replayed lines.
4. Order matters for `order_line.refunded` after `order_line.closed`: replay `closed` first (refunds
   raise the refunded base monotonically, so a late refund is still correct).

## Escalate
Finance if any replayed accrual lands after a payout already ran for the creator (a negative
payable is possible; `creator.balance_negative` is emitted once per clawback posting).
