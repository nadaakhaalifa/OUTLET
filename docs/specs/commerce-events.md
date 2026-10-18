# Commerce events: producers and consumers (Phase 3 wiring)

Scope: the outbox events that connect orders, refunds, checkout, payments and price integrity to creators and
price-drop auto-buy. Transactional outbox plus inbox, at-least-once, every consumer idempotent (A2.7). Amounts are
decimal strings of integer piastres. Source of truth for wiring: `apps/api/src/production/relay.ts`.

| Event | Producer (same transaction as) | Key payload | Consumers (inbox consumer name) |
|---|---|---|---|
| `price.changed` | price-integrity `price_events` insert | `event_id`, `sku_id`, `price{amount,currency}`, `verified`, `anomaly`, `occurred_at` | auto-buy evaluator (`auto-buy.relay`) |
| `order_group.paid`, `order_group.cod_confirmed` | checkout saga `mark_placed` CAS | `user_id`, `method`, `total`, `order_group_id`, `sku_ids` (comma-joined), `paid_at_ms` | creators `AttributeOrder` (`creators.relay`), auto-buy `CloseOnPurchase` (`auto-buy.relay`) |
| `order_line.closed` | orders CLOSE transition (one per line) | `order_line_id`, `seller_order_id`, `order_group_id`, `store_id`, `user_id`, `sku_id`, `product_id`, `category_id` (null), `merchandise_gross`, `voucher_allocated`, `refunded_merchandise_gross`, `closed_at_ms`, `return_window_ends_at_ms` (end of the line's own window; creators defer while later than now), `open_returns` (non-terminal returns on the line; creators defer while > 0), `currency`. Both A-9 fields are required for creators to accrue: absent means unknown and the accrual is retried (fail closed). Orders producer now emits both (window end = courier `delivered_at` + max(seller window, 30) days + 3 days margin, integer ms; `open_returns` per line, null when no returns port is wired; a line with a non-terminal return is never closed) | creators `AccrueClosedLine` (`creators.relay`) |
| `order_line.refunded` | refunds leg transition that completes the refund (one per line) | `refund_id`, `seller_order_id`, `order_line_id`, `user_id`, `line_merchandise_gross`, `refunded_merchandise_gross` (cumulative), `delta`, `currency` | creators `ApplyLineRefund` (`creators.relay`) |
| `payment_method.removed` | payments saved-card soft delete | `card_id`, `user_id`, `provider` | auto-buy `CancelAllForUser` (`auto-buy.relay`) |
| `shipment.delivered` | fulfillment shipment transition (existing) | `seller_order_id`, `delivered_at` | orders `markDelivered` (`orders.relay`) |

## Delivery rules
- The relay routes by event type. An event type with several owners is delivered to each owner under its own inbox
  consumer name, so a retry after a partial failure re-runs only the owners that did not commit.
- A consumer that cannot settle yet throws: `CreatorEventDeferredError` (attribution HELD, fraud gate could not run),
  `OrderNotYetShippedError` (delivery raced dispatch). The relay retries with backoff and dead-letters after 8 attempts.
- An event type whose owner module is not composed in production (creators is `blocked` in `bindings.ts`) is
  acknowledged and counted as unrouted; nothing is lost because the row stays in `outbox_events`.
- Payload extensions are additive. A consumer receiving an event from before an extension (for example
  `order_group.paid` without `order_group_id` or `sku_ids`) answers `invalid` or `ignored`, never crashes.

## Money notes
- No existing money behaviour changes: producers only append events inside the transaction that already existed.
- Creators accrue only on `order_line.closed`, on `merchandise_gross - voucher-funded value - refunded part`, rate
  from the attribution snapshot. `refunded_merchandise_gross` at closure comes from the refunds store and counts
  in-flight refunds (conservative: under-accrue, never over-accrue).
- `order_line.refunded.refunded_merchandise_gross` is cumulative and the creators claim is monotonic: redelivery,
  reordering and a smaller later value cannot claw back twice or give value back.

## Known gaps
- `category_id` is not available to orders, so category-specific creator rates fall back to the default rate.
- Closure delay is a platform constant (33 days). Seller-configured windows up to 90 days are not honoured.
- An open return or dispute at closure is not consulted (the returns module does not change the seller order status).
- No client field carries an affiliate token: attribution stays server-side by device hash; there is no
  referral-reward flag on `order_group.paid` because the creators module asks the referrals port itself (A-4).
- `payment_method.removed` cancels all of the user's armed rules; narrowing by token needs the vault adapter.
