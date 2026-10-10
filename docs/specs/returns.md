# Spec: returns and exchange-first, Phase 1 wave 3

Status: DRAFT for review · Spec refs: master prompt §22 (Returns), §B5 (CPL 181/2018), §15.6 (RefundRouter), §20.1, §T4 (payout interplay), A2, A3, T3, T5 · Grounding: `docs/data-model/returns.md`, `docs/api/openapi.yaml` operations `createReturn`, `listMyReturns`, `getMyReturn`, `listSellerReturns`, `inspectSellerReturn`, `disputeReturn`; state machine `returnMachine` (`packages/domain/src/state-machine/machines/return.ts`) is reused unchanged · Vocabulary rule ADR-0018: tested code wins, then the master prompt; the product is Z-OUTLET.

Scope: eligibility, request, pickup and receipt bookkeeping, inspection (48 h, silence approves), rejection with photos, dispute, serial-returner policy, and the pure refund allocation that becomes a `RefundIntent` event. HARD LIMIT: this module moves no money. It never calls a PSP, never posts to the ledger and never executes a refund. It only emits `return.refund_intent`; the RefundRouter and the ledger (owner F-1 money-design checkpoint) consume it later.

## Flow
1. Shopper: `POST /v1/orders/lines/{orderLineId}/returns` with qty, reason, resolution (exchange or refund), method, photos. The server loads the order line facts from `ReturnableLinePort`, evaluates eligibility with the injected clock, and creates a `REQUESTED` return with the window end, the shipping payer and, for refunds, nothing else (no money is computed yet).
2. Fulfillment (internal use cases, not HTTP): `ScheduleReturnPickup` (`REQUESTED` to `PICKUP_SCHEDULED`), `RecordReturnPickedUp` (`IN_TRANSIT`), `RecordReturnReceived` (`RECEIVED`, sets `inspection_due_at = received_at + 48 h`). A failed pickup goes back to `REQUESTED`.
3. Seller (or FBH hub): `POST /v1/seller/returns/{returnId}/inspect` with `approve` or `reject` (rejection needs a reason and at least one photo). Approve: `APPROVED`, the refund intent (or exchange intent) is computed and emitted. Reject: `REJECTED`, a 7 day dispute window opens.
4. Silence: `AutoApproveOverdueInspections` (scheduled sweeper) applies `AUTO_APPROVE` to every `RECEIVED` return whose `inspection_due_at` has passed. A seller call after the deadline first auto-approves, then answers 409 `inspection_window_elapsed`.
5. Shopper dispute: `POST /v1/returns/{returnId}/dispute` on a `REJECTED` return opens a dispute (`DISPUTED`) with `review_due_at` = 5 business days. Trust and safety resolves it through `ResolveReturnDispute` (internal): for the shopper goes to `APPROVED` and emits the refund intent, for the seller goes to `CLOSED`.
6. After the dispute window with no dispute, `CloseElapsedDisputeWindows` applies `DISPUTE_WINDOW_ELAPSED` (`CLOSED`).
7. Completion of money or exchange shipment is reported back by other modules through `CompleteReturnRefund` (`REFUNDED`) and `CompleteReturnExchange` (`EXCHANGED`). They only move state.
8. Reads: `GET /v1/me/returns`, `GET /v1/me/returns/{returnId}`, `GET /v1/seller/returns`.

## Rules
Windows (VERIFY BEFORE LAUNCH with counsel, see §B5 and verify register row 7). All windows count from the courier-confirmed `delivered_at`, never from the order date. A line with no `delivered_at` is not returnable (422 `not_delivered`).

| Reason | Window class | Days | Return shipping payer | Refund scope |
|---|---|---|---|---|
| `changed_mind` | change of mind | 14 | shopper; `platform_free` for Plus members unless serial-returner policy applies | item share; delivery fee only if the whole seller order is returned within 7 days |
| `too_small`, `too_large` | size exchange | 14 | `platform_free` for the first exchange of that line, else shopper (Plus: `platform_free`) | exchange first; refund path same as change of mind |
| `defective`, `not_as_described`, `wrong_item` | defect | 30 | seller | item share plus delivery fee share |
| `late` | change of mind window | 14 | `platform_free` (platform default, seller is not blamed for courier delay; VERIFY) | item share plus delivery fee share |

- Inclusive end: eligible while `now <= delivered_at + days * 24 h`. Exact 24 h periods from the confirmed instant; calendar-day rounding in Africa/Cairo is a VERIFY item (shopper-favourable alternative).
- Day 15 for change of mind: refused, `422 return-not-eligible`, `code: window_elapsed`, with `reason_ar` and `reason_en`. Day 29 for a defect: accepted.
- Non-returnable classes come from the catalog (`return_class`): `hygiene` and `personalized` are returnable only for `defective`, `not_as_described` and `wrong_item` (non-conforming goods stay within the 30 day right). The disclosure is on the PDP and at checkout (catalog module); this module only enforces. Items sold "as is" with a disclosed minor defect: the disclosed defect is not a reason, so `defective` is accepted but flagged for inspection (the inspector may reject with `other`).
- Photos: 1 to 8 required for `defective` and `not_as_described`; optional otherwise; ownership is checked through `EvidencePort`.
- Quantity: `qty` between 1 and the line's remaining open quantity (line qty minus quantities in non-cancelled returns). Partial returns are allowed while the window is open.
- Exchange: `resolution: exchange` needs `exchange_sku_id`; the SKU must be in stock (`ExchangeStockPort`), else 422 `exchange_unavailable` and the shopper picks a refund. The refund path is never blocked (14 day no-reason right), exchange is only the first offer.
- Refund preference: `original_method` (default) or `store_credit` is recorded and passed on in the intent. BNPL, COD and Fawry routing is the RefundRouter's (§15.6, §B3), not decided here.
- Inspection: 48 h from `received_at`. Silence auto-approves. A rejection needs one of `used`, `missing_tags`, `damaged_by_customer`, `wrong_item_returned`, `other` and at least one photo, else 422 `photos_required`.
- Dispute: only on `REJECTED`, only by the return's owner, once, within 7 days of the rejection (configurable `disputeWindowDays`, default 7, VERIFY). Review SLA: 5 business days, weekends Friday and Saturday (Egypt), public holidays not modelled (VERIFY).
- Serial returners (transparent, §22): over the trailing 6 months, if delivered orders >= 10 and returned orders * 100 / delivered orders > 60 (strict, integer basis points), free returns are removed: the shopper pays return shipping for `changed_mind` and size exchanges even as a Plus member. Seller-fault reasons (`defective`, `not_as_described`, `wrong_item`, `late`) never count toward the rate and never lose free return. The policy constants are exported (`SERIAL_RETURNER_POLICY`) and published; the notice event is emitted once on the first flip. Never secret, never silent.
- Refund allocation (pure, integer piastres, banker's rounding at the single documented point `divideRoundHalfEven` from `money.ts`): for a return of `r` units of a line with `qty` units, `unit_price`, `discount_alloc` (whole-line voucher share) and `delivery_fee_alloc` (whole-line delivery share), previously returned `p` units: `cum(k) = round_half_even(total * k / qty)`, part for this return = `cum(p + r) - cum(p)`. So partial returns of the same line always sum to the line's exact total. Refund = `unit_price * r - voucher_part (+ delivery_part when refundable)`. Sum of parts equals total, never negative (clamped, with a typed error if inputs are inconsistent).
- Delivery fee refundable when: seller fault, or `changed_mind`/size and the whole seller order is returned (all other lines fully returned or in return) within 7 days of delivery.
- Payout interplay (§T4, §22): the intent carries `store_id` and `seller_order_id` so payouts can net it; this module does not touch payouts.

## Edge cases
- Concurrent requests for the last units of a line: serialised per order line in the repository (advisory lock in Postgres); the loser gets 422 `qty_exceeds_returnable`.
- Same Idempotency-Key replay: platform interceptor replays the stored response; the use case also dedupes on `(user_id, idempotency_key)`.
- Seller suspended while a return is in flight: inspection falls to the hub or trust and safety (outside this module; the sweeper keeps working so silence still approves).
- Order line of another user or unknown id: 404, byte-identical.
- Return in a terminal state: any transition is a typed 409 `invalid_transition`.
- Clock skew: only the injected `Clock` is read. The courier `delivered_at` in the future (bad data) makes the line `not_delivered`.
- Exchange SKU sold out between request and approval: approval still succeeds; the exchange intent carries the SKU and the orders module falls back to refund with the shopper's choice (gap, orders module).
- COD and BNPL orders: eligibility is identical; routing differences belong to the RefundRouter.
- Account deletion with an open return: blocked by privacy (§2); this module exposes `hasOpenReturns(userId)` through the repository for that check.
- Zero or negative qty, more than 8 photos, unknown reason: 400 from Zod.

## Data
Migration `0020_returns.sql` (expand only; depends on migrations 0001 to 0011). Order, seller order and store tables arrive with the orders module, so `order_line_id`, `seller_order_id` and `store_id` are logical references (no FK) until then. Upload ids are logical references to the media module. PII classes are in `docs/privacy/data_inventory.yaml`. RLS class A (owner) for shopper reads, plus store scope for sellers, `system` role for the module's adapter (same pattern as 0015).

| Table | Key columns | Notes |
|---|---|---|
| `returns` | `id`, `user_id` FK users, `order_line_id`, `seller_order_id`, `store_id`, `qty`, `reason`, `resolution`, `exchange_sku_id`, `refund_preference`, `method`, `state`, `shipping_payer`, `delivered_at`, `window_ends_at`, `received_at`, `inspection_due_at`, `dispute_window_ends_at`, `rejection_reason`, `note`, `refund_intent` jsonb, `intent_published_at`, `prior_qty`, `delivery_fee_refundable`, `line_snapshot` jsonb, `inspection_note`, `idempotency_key`, `version` | unique `(user_id, idempotency_key)`; CHECK on enums and `qty > 0` |
| `return_evidence` | `id`, `return_id` FK, `upload_id`, `kind` shopper_photo / inspection_photo / dispute_photo, `uploaded_by_type`, `uploaded_by_id` | cascade with the return |
| `return_disputes` | `id`, `return_id` unique FK, `status`, `statement`, `review_due_at`, `decision`, `decided_at` | one dispute per return |
| `returner_standing` | `user_id` PK FK, `delivered_orders_6m`, `returned_orders_6m`, `rate_bps`, `free_returns_removed`, `notice_sent_at`, `evaluated_at` | published policy outcome per user |

## API
| Method and path | Auth | Idempotent | Rate limit | Success |
|---|---|---|---|---|
| `POST /v1/orders/lines/{orderLineId}/returns` | buyer, owner of the line (policy `return_request:create`) | required | 60/min/user | 201 `Return` |
| `GET /v1/me/returns` | buyer, self | n/a | 120/min/user | 200 `ReturnPage` |
| `GET /v1/me/returns/{returnId}` | buyer, owner (`return_request:read`) | n/a | 120/min/user | 200 `Return` |
| `POST /v1/returns/{returnId}/dispute` | buyer, owner (`return_request:update`) | required | 10/min/user | 201 `Dispute` |
| `GET /v1/seller/returns` | seller, brand role owner, manager, warehouse or support, scope `seller:read` | n/a | 120/min/user | 200 `ReturnPage` (own stores only) |
| `POST /v1/seller/returns/{returnId}/inspect` | seller, role owner, manager, warehouse or support with `seller:write` on the return's store (`store_return:update`) | required | 60/min/user | 200 `Return` |

Errors are Problem+JSON: `return-not-eligible` (422, codes `not_delivered`, `window_elapsed`, `non_returnable_class`, `qty_exceeds_returnable`, `photos_required`, `exchange_unavailable`, `exchange_sku_required`, each with `reason_ar` and `reason_en`), `invalid-transition` (409), `inspection-window-elapsed` (409), `dispute-window-elapsed` (422), `not-found` (404). Deviations from the OpenAPI skeleton (not edited): the wire `Return.status` has no `CANCELLED` and no `CLOSED`; `CLOSED` is mapped to `RETURN_REJECTED` (the rejection stands) and `CANCELLED` is unreachable over HTTP because no cancel route exists.

## Events
Outbox (domain events, Zod-typed in the module, no PII beyond ids): `return.requested`, `return.received`, `return.inspected {result}`, `return.disputed`, `return.refund_intent` (the allocation), `return.exchange_intent`, `return.serial_returner_notice`. Analytics (client taxonomy): `return_requested(reason)`, `return.received`, `return.inspected(result)`, `refund.completed` is emitted by the money module, not here.

`return.refund_intent` payload: `returnId`, `userId`, `storeId`, `sellerOrderId`, `orderLineId`, `reason`, `refundPreference`, `shippingPayer`, `currency`, `allocation {lines[{orderLineId, qty, itemAmount, voucherShare, deliveryFeeShare, netAmount}], itemTotal, voucherTotal, deliveryFeeTotal, netTotal}` (amounts are decimal strings of piastres), `idempotencyKey = "refund-intent:{returnId}"`, `occurredAt`. A consumer must dedupe on the key (at-least-once, A2.7).

## Failure handling
- Port failures (`ReturnableLinePort`, `EvidencePort`, `ExchangeStockPort`, `ReturnerHistoryPort`): throw `ReturnsDependencyUnavailableError`, mapped to 503 with Retry-After. Fail closed: no return is created from guesses.
- Version conflict on save: retry up to 3 times, then 409 `return_conflict`.
- Event publish is best effort after the state write. The intent is persisted on the return row, and `PublishPendingRefundIntents` (sweeper) republishes approved rows with `intent_published_at is null`. At-least-once, idempotent key.
- Sweepers are idempotent and bounded (batch 100).

## Security and abuse
- BOLA (API1): lines and returns resolve through resolvers returning the true owner or store, so foreign and missing ids are 404 and byte-identical. RLS repeats the predicates.
- BFLA (API5): a shopper token on a seller route is 401 (audience) or 403 (grant); a seller role without `warehouse`/`support`/`manager`/`owner` (for example `catalog`, `finance`) is 403.
- Mass assignment (API3): strict Zod bodies; explicit wire serialisers; the client never sends amounts, windows or payer.
- Resource consumption (API4): 8 photos, 500 char note, 1000 char statement, qty bounded, rate limits, sweeper batches.
- Business flow (API6): serial-returner policy, one dispute per return, exchange only against in-stock SKUs, BNPL cash-conversion signals are the fraud module's (event carries reason and preference).
- Evidence privacy: photos belong to the return and are purged by `returns_evidence` retention (12 months after closure). Sellers see photos and reason, never the shopper's address or phone (not stored here).
- Threat notes (STRIDE): Spoofing, buyer/seller audiences split. Tampering, server computes windows, payer and amounts. Repudiation, state history and idempotent writes. Information disclosure, 404 policy, no PII in events. DoS, caps. Elevation, role and scope checks per route.

## Metrics
Return rate by category, seller and reason; size-related return reduction vs control (target -10%); exchange acceptance rate; auto-approve share (health of seller SLA); dispute rate and overturn rate; refund-intent publish lag p95; eligibility refusals by code; serial-returner population (published).

## Acceptance
- Delivered 15 days ago, `changed_mind`: 422 `window_elapsed` with Arabic and English reason. Delivered 29 days ago, `defective` with a photo: 201.
- Delivered exactly 14 days ago (to the millisecond) `changed_mind`: accepted; one millisecond later: refused.
- `defective` without photos: 422 `photos_required`.
- Hygiene item, `changed_mind`: 422 `non_returnable_class`; same item `defective`: accepted.
- Size reason with exchange and the SKU out of stock: 422 `exchange_unavailable`.
- Received at T: auto-approved when the sweeper runs at T + 48 h; a seller reject at T + 49 h is 409 and the return is `APPROVED`.
- Reject without photos: 422. Reject with photos then shopper dispute: 201, `review_due_at` = 5 business days later.
- Property tests: parts sum to the total for any qty, discount and fee; successive partial returns sum to the whole line; refund never negative; windows monotonic in `delivered_at`.
- Foreign order line or return: 404 identical to missing; no token 401; seller token on buyer route 401; wrong brand role 403.
