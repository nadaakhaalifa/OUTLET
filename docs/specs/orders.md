# Spec: seller order lifecycle (orders), Phase 1 wave 3

Status: DRAFT for review · Spec refs: master prompt §7 (domain model), §19 (Seller Center, SLAs, data access), §20.1 (orders), §B1 (sellers as processors, masked buyer data), §B5 (windows count from `delivered_at`), A2.5/A2.6/A2.7, A3 · Grounding: `docs/data-model/orders.md`, `docs/api/openapi.yaml` operations `getOrderGroup`, `listSellerOrders`, `getSellerOrder`, `acceptSellerOrder`, `rejectSellerOrder`, `packSellerOrder`, `cancelSellerOrder` · ADR-0018 (vocabulary).

Scope: the lifecycle of a SellerOrder from `PAID | CONFIRMED_COD` to `SHIPPED`, the two ways out before shipping (seller rejection, shopper cancellation), the 24 h accept SLA, and the listings for seller and shopper. Out of scope (hard limit, waits for the owner's F-1 money-design checkpoint): any PSP call, ledger posting, refund or payout execution. The module only emits events that the refund saga consumes. Checkout is out of scope: orders enter through the `OrderIntake` port, fed by a fake here.

## Flow
1. Intake: the checkout saga (later) calls `OrderIntake.place(...)` once per OrderGroup, after `order_group.paid` or COD confirmation. It carries the group, one seller order per store (already `PAID` or `CONFIRMED_COD`, with `paid_at`), lines, and the seller-safe buyer contact projection. `accept_by = paid_at + 24 h` is frozen at intake. Re-delivery of the same `idempotency_key` returns the existing group and writes nothing.
2. Seller lists `GET /v1/seller/orders` (own stores only), opens `GET /v1/seller/orders/{id}`.
3. `POST .../accept` moves `PAID | CONFIRMED_COD -> ACCEPTED` (event `SELLER_ACCEPT`) and freezes `dispatch_by = accepted_at + 48 h`.
4. `POST .../pack` moves `ACCEPTED -> PACKED`.
5. `PACKED -> SHIPPED` (`SHIP`) is driven by the fulfilment module through `MarkShipped` (application use case, no seller HTTP route; the master prompt has none, shipments are created through `POST /v1/seller/shipments`). It is implemented and tested here so the lifecycle is complete.
6. `POST .../reject` moves `PAID | CONFIRMED_COD | ACCEPTED -> REJECTED_BY_SELLER` with a reason code. It emits `seller_order.rejected` for the refund saga. It never refunds and never touches a ledger.
7. `POST /v1/seller-orders/{id}/cancel` (shopper) moves any of `PENDING_PAYMENT | PAID | CONFIRMED_COD | ACCEPTED | PACKED -> CANCELLED`. After `SHIPPED` the endpoint answers 409 `not_cancellable` (it becomes a refusal or a return, other modules). It emits `seller_order.cancelled`.
8. SLA sweep: `ExpireUnacceptedOrders` (called by a worker, idempotent) cancels `PAID | CONFIRMED_COD` orders whose `accept_by <= now`, with initiator `SYSTEM_TIMEOUT`, and emits `seller_order.accept_sla_expired` plus `seller_order.cancelled` (the refund saga listens to the latter; the first feeds the seller health penalty, owned elsewhere).
9. `GET /v1/order-groups/{id}` returns the group with its seller orders to its owner.

After every transition the OrderGroup is rolled up inside the same transaction (domain function `rollupOrderGroup`): first seller order past `PAID` starts `FULFILLING`; all seller orders cancelled or rejected cancels the group (`ALL_SELLER_ORDERS_CANCELLED`). `COMPLETED` is driven by delivery and returns (later waves), not here.

## Rules
- The state machine is `sellerOrderMachine` from `packages/domain` (ADR-0018: tested code wins). This module adds no states or events. Guards added on top of the table are application guards, pure and unit-tested in `packages/domain/src/orders`:
  - accept is refused with `accept_window_elapsed` when `now >= accept_by` (the sweep owns that order now);
  - reject and cancel carry a mandatory reason code from a closed set;
  - `PACKED` requires the order to have been accepted (machine), and `SHIPPED` needs `PACKED`.
- Optimistic versioning: every seller order has `version`. A command loads the order, decides purely, then writes with `WHERE id = ? AND version = ?`. A lost race re-reads once; if the order is then already in the target state with the same command it is a replay, otherwise 409 `order_conflict`.
- Idempotent commands: each command carries a `command_key` (the `Idempotency-Key`; system commands derive a stable key such as `sla:<order id>`). `order_status_history (seller_order_id, command_key)` is unique, so a replay returns the stored current order with no second transition and no second event. Same key on a different order or different command kind is a different row and independent.
- Outbox: state change, history row, group roll-up and events are written in one transaction (A2.7). Events are P0-P2 only, never buyer contact data.
- Seller PII masking (§B1, OpenAPI `SellerOrderView.buyer`): the seller sees `first_name` and `phone_relay` only while the order is active and accepted (`ACCEPTED .. OUT_FOR_DELIVERY`, plus `DELIVERY_FAILED`) and within the grant window (30 days after `delivered_at` or `closed_at`); `address_visible` is true on the same condition. Before acceptance only `governorate_code` is shown (the seller needs nothing else to decide). For cancelled, rejected, closed or refunded orders only `governorate_code` remains. The raw phone and the address are never in this module's data (P3 delivery snapshots belong to checkout and fulfilment).
- Seller money view: `commission` and `net_to_seller` are computed from `commission_rate_snapshot_bps` with the single documented rounding point of `@outlet/domain` money (banker's rounding). They are informational for the seller and post nothing.
- Money is bigint piastres, EGP only, strings on the wire.
- Roles (policy `store_order`): read by owner, manager, warehouse, support, finance; write (accept, pack, reject) by owner, manager, warehouse. Token scopes `seller:read` / `seller:write`. Shopper routes use `shopper:orders.read|write` and resource type `order` (owner only).

## Edge cases
- Accept after the SLA: 409 `accept_window_elapsed`; the sweep cancels it.
- Accept twice (same key): replay, 200, one event. Accept twice (new key) on an `ACCEPTED` order: 409 `invalid_transition` (not silently ok: the second caller should know the first won), except the same key.
- Reject after `PACKED`: 409 (machine forbids; the seller must cancel through support). Reject after `SHIPPED`: 409.
- Shopper cancels while seller accepts concurrently: version CAS decides. The loser gets 409 `order_conflict` and re-reads.
- Cancel of one seller order does not touch its siblings; the group stays `FULFILLING` or `PAID` unless all are cancelled.
- Seller of store B calls accept on store A's order: 404 (resolver returns a resource with store A, policy answers `not_owned`). Unknown or non-UUID id: 404. Shopper token on a seller route: 401 (audience). Seller with a role lacking `write` (support, finance): 403.
- A shopper reading another shopper's group: 404.
- Order intake with zero lines or a line sum that does not equal `subtotal`: rejected with a typed error, nothing written.
- Clock skew: the sweep uses the injected clock; `accept_by` is stored, never recomputed.
- Seller store suspended after placement: orders stay in their state; the cancellation saga (later) uses the same `CANCEL` event with initiator `ADMIN`/`RISK`. Not implemented here.

## Data
Migration `0019_orders.sql` (expand). PII classes in `docs/privacy/data_inventory.yaml` (tables `order_groups`, `seller_orders`, `order_lines`, `order_buyer_contacts`, `order_status_history`).

| Table | Key columns | Notes |
|---|---|---|
| `order_groups` | `id`, `user_id` FK, `status`, `payment_method`, totals, `idempotency_key` unique, `version` | owner RLS; status = `ORDER_GROUP_STATES` |
| `seller_orders` | `id`, `order_group_id` FK, `store_id` FK, `user_id` (denormalised for RLS), `status`, `version`, money columns, `commission_rate_snapshot_bps`, `payment_type`, `paid_at`, `accept_by`, `dispatch_by`, `accepted_at`, `packed_at`, `shipped_at`, `delivered_at`, `closed_at`, `cancel_reason`, `reject_reason` | partial index `(accept_by) WHERE status IN ('PAID','CONFIRMED_COD')` for the sweep; `(store_id, status, created_at DESC, id)` for the listing |
| `order_lines` | `id`, `seller_order_id` FK, `store_id`, `sku_id`, `product_id`, `qty`, `unit_price_amount`, `discount_amount`, `vat_amount`, `title_ar`, `title_en`, `size_label` | copies so the invoice is stable |
| `order_buyer_contacts` | `seller_order_id` PK, `first_name`, `phone_relay`, `governorate_code` | the seller-safe projection only. Full recipient and address (P3, encrypted `delivery_snapshots`) stay with checkout |
| `order_status_history` | `id`, `seller_order_id` FK, `from_status`, `to_status`, `event`, `actor_type`, `actor_id`, `reason_code`, `command_key`, `occurred_at` | append-only; unique `(seller_order_id, command_key)` |

Deviations from `docs/data-model/orders.md` (reported): the tenant session variable is the existing `app.store_ids` (`app_store_ids()` helper from 0002, a list, because one staff member can serve several stores) rather than a single `app.current_store_id`; `order_status_history`, `delivery_snapshots`, `seller_delivery_access_grants` and `order_cancellations` are reduced: cancellation facts live on `seller_orders` (`cancel_reason`, `cancel_initiator`) and the grant is derived from `delivered_at`/`closed_at`; history is not partitioned yet (same deferral as the outbox, 0004). A trigger forbids leaving a terminal state (defence in depth behind the machine).

## API
| Method and path | Auth | Idempotent | Rate limit | Success |
|---|---|---|---|---|
| `GET /v1/order-groups/{id}` | shopper, owner (`order:read`) | n/a | 60/min/user | 200 `OrderGroup` + ETag |
| `GET /v1/seller/orders?status=&cursor=&limit=` | seller, `store_order:read` per store | n/a | 120/min/user | 200 `SellerOrderViewPage` |
| `GET /v1/seller/orders/{id}` | seller, `store_order:read` | n/a | 120/min/user | 200 `SellerOrderView` + ETag |
| `POST /v1/seller/orders/{id}/accept` | seller, `store_order:update` | required | 60/min/user | 200 `SellerOrderView` |
| `POST /v1/seller/orders/{id}/pack` | seller, `store_order:update` | required | 60/min/user | 200 `SellerOrderView` |
| `POST /v1/seller/orders/{id}/reject` | seller, `store_order:update` | required | 60/min/user | 200 `SellerOrderView` |
| `POST /v1/seller-orders/{id}/cancel` | shopper, owner (`order:update`) | required | 10/min/user | 200 `SellerOrder` |

Errors (Problem+JSON): `validation_failed`, `unauthenticated`, `forbidden`, `not_found`, `order_conflict` 409, `invalid_transition` 409, `accept_window_elapsed` 409, `not_cancellable` 409, `rate_limited`. The listing uses an opaque keyset cursor over `(created_at, id)` and `limit` 1..50 (default 20); a store header is not needed because the listing covers every store the actor may read (filtered by RLS and by the explicit store list).

## Events (outbox, same transaction)
`seller_order.accepted`, `seller_order.packed`, `seller_order.shipped`, `seller_order.rejected {reason}`, `seller_order.cancelled {initiator, reason}`, `seller_order.accept_sla_expired`, `order_group.fulfilling`, `order_group.cancelled`, and `seller_order.placed` at intake (for seller notifications; checkout owns `order_group.placed/paid`). Payload keys are snake_case ids, enum codes and integer amounts as strings, no names or addresses. `seller_order.rejected` and `seller_order.cancelled` carry `refund_required` (true when `payment_type = prepaid` or the order was paid) so that the refund saga (F-1) decides routing. Analytics events (typed, consent-aware, later): `seller_order_accepted`, `seller_order_rejected(reason)`, `order_cancelled(reason)`.

## Failure handling
- Optimistic CAS conflict: one internal retry, then 409.
- Sweep: bounded batch (default 100), each order in its own transaction, a failing order does not stop the batch; the sweep is re-runnable and idempotent through `sla:<id>` keys.
- Outbox relay failure is the platform's concern (at-least-once; consumers dedupe through inbox).
- Production wiring without a repository throws at boot (`NoProductionAdaptersError`); the intake fake and the store lookup fake are test-mode only.

## Security and abuse
- BOLA/BFLA (API1/API5): every object route authorizes through the central policy with a resolver that returns the real owner/store; non-owned is 404, missing role 403. The listing is scoped to stores the actor holds a read-capable grant for, in the query and by RLS. Cross-tenant negative tests cover every route (see tests).
- Mass assignment (API3): strict Zod bodies; the wire view is an explicit allow-list; buyer PII is minimised by `buyerViewForSeller`.
- Sensitive business flow (API6): per-user rate limits above; accept/reject/cancel are idempotent; reject reason is mandatory so serial rejection is visible to health scoring.
- No money moves here, so no ledger, PSP or refund code exists in this module (enforced by the dependency-cruiser boundary: no import of `ledger` or payment modules).

## Metrics
Accept latency p50/p95 (paid to accepted), auto-cancel rate (SLA expiry), seller rejection rate by reason, shopper cancel rate before ship, 409 conflict rate. SLO: accept and pack commands p95 < 300 ms; sweep lag (oldest un-swept expired order) < 5 min.

## Acceptance (Gherkin, becomes E2E)
- Given a PAID order of store A, when store A's manager accepts, then the status is ACCEPTED, `dispatch_by` is accepted_at + 48 h, and one `seller_order.accepted` event exists.
- Given the same request is replayed with the same key, then the response is identical and the event count is still one.
- Given an order 24 h and 1 s after payment, when the seller accepts, then 409 `accept_window_elapsed`; when the sweep runs, then it is CANCELLED with `seller_order.accept_sla_expired` and `seller_order.cancelled`.
- Given store B's manager, when they accept store A's order, then 404 and nothing changes.
- Given a SHIPPED order, when the shopper cancels, then 409 `not_cancellable`.
- Given a rejected order, then no refund, ledger or payment function was called (fake refund saga only saw the event).
- Given an unaccepted order, then the seller view has no `first_name`, no `phone_relay`, `address_visible=false`.

## Known gaps
- `note` on reject and cancel is validated (max 500) but not persisted: free text is P2 and needs its own retention class before storage.
- `store_id` has no FK (stores module is separate); `packages/domain/src/index.ts` does not yet `export * from "./orders"` (integrator): the API bridge imports `@outlet/domain/src/orders/index` until then.
- Full recipient and address snapshot (P3, encrypted) is checkout/fulfilment; here only the seller-safe projection exists.
- Group `COMPLETED`, delivered/closed transitions and return states are driven by fulfilment and returns modules.
