# @outlet/checkout: one bag, one payment (design)

Status: **design + schema + contracts landed; application code is the builder's next step (section 9).** Two-key area (checkout, payments, ledger): needs a fresh-context reviewer and owner approval before merge (BUILD-PROMPT section 2.3). Mark the PR `needs-human`.

Sources: master prompt section 7 (checkout), 20.1 (order machines), 15.6 (refunds, ports only), B5 (Arabic invoice data), B8 (SAQ A); `docs/data-model.md` 7.14-7.16; `docs/api/openapi.yaml` (`quoteCheckout`, `placeOrder`, `getOrderGroup`, `receivePspWebhook`); `docs/specs/ledger-chart-of-accounts.md` 4.1, 4.3, 4.7, 4.13, section 5; ADR-0003, ADR-0005, ADR-0011; owner decision D5 = Paymob, split model A.

Packages: `@outlet/orders` (pure order, seller-order and payment-intent machines, reusable by Seller Center and fulfilment) and `@outlet/checkout` (saga, ports, quote). Schema: `packages/db/migrations/0016_orders_checkout.sql`.

## 1. Flow (one page)

Address -> delivery per store -> payment method -> store credit -> review ("You saved X", verified only) -> place. Every fee is on the **first** quote render: delivery per store and the fee of **every** offered payment method (config, default 0), so choosing a method never adds a surprise fee (no drip pricing).

## 2. Saga (orchestrated)

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant API as CheckoutService (outlet_app, user ctx)
  participant DB as Postgres (one tx)
  participant PSP as PaymentProviderPort (Fake / Paymob)
  participant W as WebhookProcessor (outlet_worker, job payments.webhook)
  C->>API: POST /checkout/quote (pure)
  API-->>C: Quote + signed quote token (10 min)
  C->>API: POST /checkout (Idempotency-Key, token, echoed quote, method)
  API->>DB: tx1: idem begin, re-quote, compare lock, kill switch, COD risk,<br/>insert session/group/seller orders/lines, reserveIn(TTL by method),<br/>credit hold (ledger_holds), payment_intents CREATED, outbox order_group.placed
  alt COD allowed or credit-only
    API->>DB: same tx1: claimIn (+ ledger post if credit-only), CONFIRMED_COD / PAID
  else external tender
    API->>PSP: createIntent(Idempotency-Key = order_group_id, split per seller order)
    API->>DB: tx2: provider_ref, client_action, REQUIRES_ACTION, idem complete
  end
  API-->>C: 201 {order_group_id, status, client_action}
  C->>PSP: authenticate (3-DS / Apple Pay / redirect / Fawry ref)
  PSP->>W: webhook (raw bytes)
  W->>DB: txA: store raw (encrypted), UNIQUE (market, provider, event id)
  W->>W: verifyWebhook (signature before parse)
  W->>DB: txB: lock raw row + intent, narrow to owner,<br/>claimIn + Ledger.post(order_paid) + holds CAPTURED + statuses + outbox order_group.paid
  C->>API: GET /order-groups/{id} (poll; server is the source of truth)
```

Steps that cross the network never run inside a DB transaction. Webhook-before-redirect is safe: the client polls `GET /order-groups/{id}` and the webhook may land first.

## 3. State machines (`@outlet/orders`, tables in `src/machines.ts`)

- **OrderGroup:** `PENDING_PAYMENT -> PAID | CONFIRMED_COD | AWAITING_COD_CONFIRMATION | PAYMENT_FAILED | EXPIRED | CANCELLED`; `AWAITING_COD_CONFIRMATION -> CONFIRMED_COD | EXPIRED | CANCELLED`; `PAYMENT_FAILED | EXPIRED -> PAID (late_payment_claimed) | REFUND_PENDING (late_payment_unavailable)`; `REFUND_PENDING -> REFUNDED`; `PAID | CONFIRMED_COD -> PARTIALLY_FULFILLED -> COMPLETED`, `-> CANCELLED`.
- **SellerOrder (20.1):** `PENDING_PAYMENT -> PAID | CONFIRMED_COD | VOIDED`, `VOIDED -> PAID (late_pay)`, `PAID|CONFIRMED_COD -> ACCEPTED -> PACKED -> SHIPPED -> OUT_FOR_DELIVERY -> DELIVERED -> CLOSED`, exceptions `REJECTED_BY_SELLER`, `CANCELLED` (only before SHIPPED), `DELIVERY_FAILED -> RTO -> RETURNED_TO_SELLER`, `DELIVERED <-> DISPUTED`. Return states live on `return_requests`.
- **PaymentIntent:** `CREATED -> REQUIRES_ACTION -> AUTHORIZED -> CAPTURED -> PARTIALLY_REFUNDED -> REFUNDED`; `* -> FAILED | CANCELLED | EXPIRED`; those three `-> CAPTURED (late_capture)` because the PSP is the truth for money; `CREATED -> NOT_REQUIRED` for COD and credit-only.
- Invalid transitions throw `OrderStateError`. Tests: BFS reachability = declared states, terminal iff no out-edge, 1,000-run fast-check walk, SQL CHECK lists equal the arrays (`packages/checkout/test/schema-0016.test.ts`).

## 4. Pure quote (`quote(input: QuoteInput): Quote`, contract in `src/domain/types.ts`)

- Per store: lines `unitPrice x qty` (live price, never the cart's price_at_add), VAT per line via `taxSnapshotForLine` + `splitInclusive` (computed **once per line**, ledger spec 4.13), delivery fee from `ShippingQuotePort` with VAT `roundHalfEven(gross x 1400, 11400)`.
- `total = items - discount (0, promotions not built) + delivery`; `storeCredit = min(requested, available, total)`; `payableByMethod[m] = total + fee[m] - storeCredit` for every non-killed method.
- `verifiedSavings = sum((vrp - unitPrice) x qty)` only where `claimType = verified_discount` and `vrp > unitPrice` (PriceSnapshotService, fails closed to plain). Never from vouchers or unverified references (CPL 181/2018, section 9).
- `hash = sha256(canonical JSON)` (sorted keys, bigint as decimal strings). `QuoteTokenPort.sign({jti, userId, marketId, quoteHash, method, expiresAt = now + 600 s})`.
- Query budget for `CheckoutService.quote()`: `<= 6 + S + 2K` statements (S stores, K distinct skus): cart 3 + stock S, price snapshots about 2 per sku, credit 1-2, tax categories 1. A counting `Queryable` test pins it. Tighten to a constant once pricing-integrity ships a batch `snapshotsForOrderLines` (request R2).

## 5. Price lock: options compared

| Option | Complexity | Accuracy / fairness | Cost | Scalability |
|---|---|---|---|---|
| A. Guarantee the checkout-start price for 10 min, seller absorbs increases | Medium | Shopper-friendly, but binds sellers to a price they changed: Seller Agreement term (owner decision) | Seller margin risk | Fine |
| **B. Quote valid 10 min; any change at commit returns 409 `price-changed` with a delta list and a fresh quote (chosen)** | Low | The shopper is never charged an amount they did not see, up or down | None | Fine |

Choice: B needs no contract term and never charges an unseen amount; A can be added later behind config if the owner and Seller Agreement adopt it. The client echoes the quote; the server checks `sha256(echo) = token.quoteHash`, re-quotes, and `compareLock(echo, fresh)` returns `PriceDelta[]` (line price, line unavailable/added, shipping, method fee, store credit, total). Expired token -> 409 `quote-expired` + fresh quote.

## 6. Data and RLS (migration 0016)

| Table | Tenant | Notes |
|---|---|---|
| `checkout_sessions` | user | created at placement (quote stays pure); `id = quote jti` so one quote places at most one group |
| `order_groups` | user | `UNIQUE (checkout_session_id)`, `UNIQUE (user_id, idempotency_key)`; CHECK `total = items - discount + shipping` |
| `seller_orders`, `order_lines` | both | single `_store_isolation` policy: market pin AND (store = ctx store OR (ctx in user/worker AND user = ctx user)) |
| `payment_intents` | user | `UNIQUE (order_group_id)`, `UNIQUE (provider, provider_ref)`; worker SELECT exception for webhook lookup |
| `payment_events_raw` | none | encrypted body; `UNIQUE (market_id, provider, provider_event_id)`; revoked from outlet_app; worker job only |
| `ledger_holds` | user | store-credit holds (rows, not pending postings) |

Why one combined policy: the unchanged audit allows one PUBLIC policy per tenant table and requires `_store_isolation` to use the store and market predicates; a second PUBLIC "shopper read" policy fails it. The `app.ctx()` guard keeps a store context that carries the staff user's id from opening that person's own orders at other stores (tested).

Grants: outlet_app UPDATE is column-limited (status and timestamps; money columns write-once), no DELETE anywhere. New worker jobs `payments.webhook` and `checkout.expiry` (WORKER_JOBS). Exception policies: `payment_intents__worker_payments_webhook` (SELECT), `order_groups__worker_checkout_expiry` (SELECT, expired pending only), `payment_events_raw__worker_payments_webhook`, two INSERT-only outbox policies, plus the generated retention policies for `raw_webhooks_financial`. **Review item:** outlet_worker also gets SELECT/INSERT on ledger tables and SELECT/UPDATE on reservations, inventory_units, inventory_levels (narrow-then-act inside the webhook transaction).

## 7. Ports (`src/ports.ts`)

`PaymentProviderPort` (createIntent with split per seller order, voidIntent, verifyWebhook over raw bytes + headers + query: Paymob signs ordered fields with HMAC-SHA512 in the query string, so the port must not assume raw-body HMAC), `RefundPort` (ports only; called by `LateRefundConsumer`), `ShippingQuotePort` (real one in packages/shipping), `AddressPort`, `RiskPort`, `CommissionPort`, `TaxCategoryPort`, `StoreCreditPort`, `QuoteTokenPort` (payload Zod-parsed after the MAC check, carries a `kid`; production: keys live in the secrets manager, rotate on a schedule, and the previous kid stays verifiable for one token lifetime of 10 min; the fake `HmacQuoteTokens` models this with a key map), `RawBodyCipher`, `CheckoutConfig`. Only fakes in this package; production adapters stay Unconfigured and fail closed.

Kill switches (fail closed): card -> `payments.card.enabled`, apple_pay, meeza, wallet -> `payments.mobile_wallet.enabled`, instapay, fawry, bnpl, cod, store credit -> `payments.store_credit.enabled`. A killed method is absent from the quote and refused by `place()` (403 `method-unavailable`). Webhooks are processed regardless: the money already moved.

Hold windows (config): card/apple_pay/meeza 600 s, wallet/instapay 1,800 s, fawry 86,400 s, cod 7,200 s (confirmation window). `payment_expires_at = reservation expires_at`. Fawry must exclude drop SKUs (drops not built: TODO guard).

## 8. Ledger at `payment.succeeded` (one entry, kind `order_recognised`, key `order_paid:{order_group_id}`)

Per seller order s: `base_s = items_s - seller_discount_s`; `commission_s = roundHalfEven(base_s x bp_s, 10000)`; `cvat_s = roundHalfEven(commission_s x 1400, 10000)`; `net_s = base_s - commission_s - cvat_s` (I13, >= 0 or typed error); delivery VAT per 4.13.

| Account | Side | Amount |
|---|---|---|
| `psp_clearing:{m}:{c}:{provider}` (BNPL: `bnpl_clearing:{m}:{c}:{bnpl}`, 4.8) | Dr | external amount (if > 0) |
| `store_credit:{m}:{c}:{user}:{sub}` | Dr | each captured hold |
| `seller_pending:{m}:{c}:{store}` | Cr | `net_s` per store |
| `commission_revenue` | Cr | sum commission |
| `platform_vat_output` | Cr | sum commission VAT + sum delivery VAT |
| `shipping_revenue` | Cr | sum delivery net |

Balances by construction: Dr = total = sum base + delivery. Worked example 4.1 (A 249,900; B 89,950 + 6,000; C 45,000 + 6,000; 15%) must reproduce **exactly**: 396,850 / 207,167 / 74,569 / 37,305 / 57,727 / 9,556 / 10,526. Model A (D5) changes settlement only, not this entry; split instructions sent to the PSP pay each seller `min(net_s, its share of the external amount)` and the platform the rest (C5: property-tested, `sellerAmount_s <= net_s` and the sum never exceeds the sum of nets, so credit-funded orders never over-pay a seller). **Settlement under model A debits `seller_pending` by the ACTUAL split amount sent to the PSP, not by `net_s`; the remainder (`net_s` minus the split amount, non-zero when store credit funded part of the order) flows to the seller through the normal payout.** R3 for the ledger owner: the settlement entry kind and the payout path for that remainder must be specified and tested with the split instructions. COD: nothing is posted at placement (I15); `order_delivered_cod` posts at delivery (fulfilment). Late payment with no stock: `refund_issued`, key `late_refund:{group}`, Dr clearing / Cr `shopper_refunds_payable`, then `RefundPort.requestRefund` (ledger owner to confirm the kind, request R3).

## 9. Compensations

| Failure | Compensation (same tx unless noted) |
|---|---|
| Stock shortfall at reserve | whole tx rolled back; 409 `stock-shortfall` with shortfalls; idempotency abandoned |
| Price, fee or credit changed | 409 `price-changed` + deltas + fresh quote; nothing written |
| PSP createIntent retryable error / timeout | group stays PENDING_PAYMENT, intent CREATED; same Idempotency-Key resumes and re-calls the PSP with the same key |
| Synchronous PSP decline (non-retryable) at `createIntent`, or webhook `payment.failed` on **COD** | intent FAILED, group PAYMENT_FAILED, seller orders VOIDED, credit holds RELEASED, reservation released (`releaseIn`), outbox `order_group.payment_failed` |
| Webhook `payment.failed` on an **external** method (C1) | **not final**: only `payment_intents.failure_code` is recorded and outbox `order_group.payment_attempt_failed` is emitted; the group stays PENDING_PAYMENT, the intent keeps its status, the reservation and credit hold lapse at the window's end exactly like `expired`. A later `payment.succeeded` inside the window claims normally (PAID, no refund) |
| Payment window passes (`checkout.expiry`, every 30 s per market) | `voidIntent` first (network, outside tx): `already_captured` -> leave for the webhook; else tx: lock group, still pending? -> EXPIRED, VOIDED, holds EXPIRED, intent EXPIRED, outbox `order_group.expired`; the reservation lapses through the inventory sweeper (same instant) |
| Success after EXPIRED / PAYMENT_FAILED | `claimIn` late path + re-hold credit if it was released: both OK -> PAID + ledger; else REFUND_PENDING + late-refund entry + `RefundPort` + outbox `order_group.late_payment_refund` (apology). Alert above 0.1 % of paid groups |
| Webhook amount/currency/reference mismatch | raw row `rejected`, audit-log security event, alert; no state change |
| `payment.succeeded` with a provider reference different from the intent's (C2) | raw row `rejected`, no state change, outbox `payment.webhook_rejected {reason, groupId, providerRef}`: `duplicate_capture` when the group is already settled (possible double capture: finance must refund the second capture at the PSP), `provider_ref_mismatch` when it is not yet settled. The reconciliation job lists every such event next to the PSP settlement file (unmatched capture = same alert path as an unmatched settlement line) |
| Webhook processing throws | txB rolled back, raw row marked `failed` (txC), 500 so the PSP retries; DLQ replay tool reads `failed` rows |
| COD `require_confirmation` | AWAITING_COD_CONFIRMATION, reservation TTL cod; confirm -> claim + CONFIRMED_COD; timeout -> EXPIRED |

Webhook dedup: txB locks the raw row `FOR UPDATE`; `processed` or `ignored` -> 200 `duplicate=true`. The inbox for webhooks IS the raw row status (UNIQUE market, provider, event id, plus the row lock): it flips to `processed` in the same transaction as the effects, so no separate `inbox_processed` row is written for `payments.webhook` (C11). `inbox_processed` is used by outbox consumers such as `checkout.late_refund`. Intent machine guards out-of-order events (`fail` after CAPTURED is ignored).

### 9.1 ADR-lite: a declined attempt is not a final failure (C1)

Options: (a) treat the first `payment.failed` webhook as final and release the reservation at once (frees stock sooner; but a PSP that reports a declined attempt and later a success for the same order, as Paymob can with several attempts per order, would turn a paid order into a late refund and an apology voucher); (b) **keep the reservation until the window closes (chosen)**: stock is held at most the normal window (10 min card), the shopper can retry with another card, and a success inside the window is a normal PAID. The cost is up to one window of held stock for a shopper who walked away, which the sweeper already bounds. COD keeps the immediate release (no later payment can arrive). **VERIFY V41:** confirm Paymob's per-attempt callback semantics (one order id, a transaction id per attempt, whether a failed attempt can be followed by a success on the same order, and which reference is stable) against the contract and sandbox; the provider-reference check in section 9 depends on it (a failed attempt never back-fills `provider_ref`).

### 9.2 Late refund ownership (C4)

The outbox event `order_group.late_payment_refund` (idempotency key `late_refund:{group}` in the payload, plus the intent id and amount) is the only trigger of the refund request. `LateRefundConsumer` (`src/application/late-refund-consumer.ts`) calls `RefundPort.requestRefund` outside any transaction with that key, throws if the port does not accept (the relay redelivers, the group stays REFUND_PENDING, the ledger already owes the money), and writes `inbox_processed (checkout.late_refund, event id)` only after acceptance; a redelivery is a no-op. The webhook processor no longer calls the port.

### 9.3 Order cancellation before shipping (`src/application/cancellation*.ts`)

Master prompt 20.1 / 15.6 / B5. `OrderCancellation` (apps/api `OrderCancellationPort`: `cancel(input)`; `execute` returns the result; `cancelBySeller`).

| Case | Effect (one outlet_app transaction, shopper user context) |
|---|---|
| Unpaid (PENDING_PAYMENT, AWAITING_COD_CONFIRMATION), whole group only | PSP `voidIntent(key cancel:{group})` first, outside the tx (`already_captured` = 409 `payment-in-flight`); intent `cancel`, group `cancel`, seller orders `void`, lines cancelled, credit holds RELEASED, reservation `releaseIn`, session expired; vouchers `release` after commit. No refund (nothing charged) |
| Paid (PAID, CONFIRMED_COD, PARTIALLY_FULFILLED), whole group or chosen stores | each target PAID / CONFIRMED_COD / ACCEPTED / PACKED -> CANCELLED (`cancel_reason`, `cancelled_at`, `cancel_refund_choice`), lines cancelled, per store `inventory.release_required` (claimed units) and `seller_order.cancelled`; group -> CANCELLED when no live seller order remains, then vouchers `reinstate` after commit |
| A target at or after SHIPPED | 409 `cancel-after-shipping` (a refusal or a return) |
| Same request again (group + reason) | replay, no new rows or events; another reason on a cancelled target is 409 `order-not-cancellable` |
| BNPL + `store_credit` preference | 422 `refund-preference-invalid` (provider only, B3) |

**M4 (composed).** A PACKED target with a live outbound shipment (LABEL_PENDING / LABEL_READY) also emits `shipment.cancel_required {shipment_id, seller_order_id, order_group_id, store_id, user_id}` in the same transaction. `ShipmentCancelConsumer` (@outlet/shipping, worker job shipping.tracking, `shipmentCancelHandlers` in apps/api `worker-consumers.ts`; inbox `shipping.shipment_cancel`) calls `CourierPort.cancelShipment(awb)` outside any transaction, then moves the shipment to CANCELLED and emits `shipment.cancelled`. Courier `CourierCancelError` `not_found` / `already_cancelled` and an already CANCELLED shipment are success; other courier errors throw (redelivery); permanent cases (`not_cancellable`, picked up meanwhile, unknown shipment, bad payload, shipment shared by several seller orders) become `shipment.cancel_attention {reason}`. SHIPPED and later is never cancelled (a return). Open edge: a `shipment.create` whose courier call is in flight (LABEL_PENDING, no AWB yet) when the cancel lands leaves an orphan AWB at the courier; the create's final update then finds CANCELLED and records nothing. The `shipment.cancel_attention` events need an ops consumer.

Every change emits `order_group.cancelled {user_id, scope, reason_code, initiator, seller_order_ids, refund_expected}` (notifications); the hash-chained audit record (`CancellationAuditPort.appendIn`, PgAuditStore) is appended in the same transaction as the state change, replays included, with actor `user` for the shopper and `store_member` for `cancelBySeller` (M5, chief review waves 9-10). Money: `CancellationRefundConsumer` (inbox `checkout.cancellation_refund`) consumes `seller_order.cancelled` and `seller_order.rejected` and calls `RefundService.createForCancellation` (finance.refunds worker): per seller order, key `refund:cancel:{seller order}`, RefundRouter by tender with the stored shopper choice, the same dual approval as returns, `due_at` = cancelled_at + 14 days (V7). In that worker transaction `cancel_adjust:{seller order}` reverses what the refund entry does not (platform-funded discount, delivery discount); refund entry + adjustment negate the seller order's share of `order_paid:{group}` exactly (property test in @outlet/returns). The provider call happens in `RefundService.process` (ledger first), never in the API process. COD before delivery and unpaid groups create no refund row.

Details fixed by the chief review: a replay keeps the refund choice stored by the FIRST cancel (`cancel_refund_choice`); a repeat with another `refundPreference` replays and changes nothing (L4). A replay of a whole-group cancel re-runs the voucher release / reinstate (both idempotent), so a failed settlement is retried by repeating the request (M3). A PSP capture that lands after an unpaid group was cancelled (intent CANCELLED) is never re-claimed: `recordLateRefund` posts `late_refund:{group}` and emits `order_group.late_payment_refund` (LateRefundConsumer), group CANCELLED -> REFUND_PENDING (H1); `voidIntent` answering `not_found` for an intent in REQUIRES_ACTION / AUTHORIZED is 409 `payment-in-flight` (state unknown, fail closed). The refund consumer parks permanent refusals (ReturnsError, ZodError) as `refund.attention {order_group_id, seller_order_id?, error}` in the inbox transaction and keeps throwing on infrastructure errors (M1). The refund row reports the delivery fee the shopper actually paid (shipping minus the delivery discount, VAT floor-proportional); the rest is in `cancel_adjust` (L2).

Vouchers (chief review waves 9-10). `makePromotionsPort` defaults the reinstate gate to `PgOrderFacts.forShopper` (shopper's user context on the app pool, explicit `user_id` filter), so production reinstates instead of failing `REINSTATE_NOT_ALLOWED` (H). A failed release / reinstate is never silent: error log (`OrderCancellationDeps.log`, @outlet/logger in apps/api) plus `promotions.settle_attention {order_group_id, action, error}` in a small transaction; the result says `vouchers: "failed"` and a replay retries. Race with `PromotionsSettleConsumer` (finding 2): `confirm` / `release` / `reinstate` take a per-group advisory lock; `confirm` skips a CANCELLED group; `reinstate` of a whole-cancelled group also releases rows still `reserved`. The settle consumer runs as outlet_worker job `checkout.settle` (migration 0031) for its inbox and parks a malformed payload as `promotions.settle_attention {action: "confirm", error: "invalid_payload"}`; the confirm itself runs on the outlet_app port (no promotions grant for outlet_worker, finding 11). `promotions.settle_attention` needs an ops consumer.

Not yet composed (open items, not built):
- **M2 (health penalty only)** the seller cancel route (`POST /v1/{market}/seller/orders/{id}/cancel`, apps/api seller-orders) is composed: store-context authorize (`order.fulfill`), cross-tenant 404 under RLS, Idempotency-Key required, fixed `SELLER_CANCEL_REASONS` code, runs `OrderCancellation.cancelBySeller`. No seller health-score penalty hook exists in the codebase yet, so none is applied: TODO in `SellerOrderService.cancel` (and the SLA penalty of `reject` is likewise open). The older `reject` route (PAID or CONFIRMED_COD only, emits `seller_order.rejected`) is unchanged; the two paths differ only in the states they accept.
- Notifications has no template mapped for `order_group.cancelled` yet.

ADR-lite (options compared): (a) one worker transaction in the API doing state, ledger and refund rows: atomic, but the API would hold outlet_worker finance credentials (ADR-0011) and post money from the request path; (b) **chosen**: state + events in the request transaction (outlet_app), refunds from the outbox in the finance.refunds worker. Same pattern as `return.accepted -> createForReturn`; at-least-once + per-seller-order keys make it exactly-once in effect, and the 24 h initiation SLO only needs the relay and the refund worker running.

## 10. Threat notes (STRIDE / OWASP API 2023)

- **API1 BOLA:** order data only through RLS; foreign ids -> 404. `address_id` checked by `AddressPort` (404), cart lines come from the caller's own cart.
- **Tampering (price):** client totals ignored; the echoed quote is trusted only if its hash matches the HMAC'd token; server re-quotes.
- **Repudiation / double charge:** Idempotency-Key + `UNIQUE (user_id, idempotency_key)` + `UNIQUE (checkout_session_id)` + one intent per group + PSP key = group id + ledger key `order_paid:{group}`.
- **Spoofing (webhook):** edge IP allow-list, signature verified before parsing, constant-time compare, timestamp window where the PSP sends one (V-row: Paymob has no timestamp; replay is bounded by event-id dedup), amount, currency and merchant reference matched to the local intent (PAY-T02).
- **Information disclosure:** billing data decrypted only for the PSP call and never logged; raw bodies encrypted (aad `payment_events_raw.body_ct`) and unreadable by outlet_app; card data never touches us (SAQ A).
- **API3 mass assignment:** column-level UPDATE grants; explicit DTO allow-lists.
- **API4/API6:** body <= 256 KB; checkout 5/min per user and device, 1 concurrent, Turnstile; card-testing signals to the risk model; 3-DS mandatory (PSP config).
- **Elevation:** worker grants are narrow-then-act; exception policies are SELECT/INSERT only, job- and market-pinned, snapshot-tested.
- **Never fake:** savings only from verified VRP snapshots; `order_lines` CHECK forbids a verified claim without a higher VRP.
- **CPL 181/2018 / B5:** `title_ar_snapshot` NOT NULL, seller legal identity comes from the store at invoice time (tax module).

## 11. Builder plan (implement in this order; every item has a test)

1. `src/domain/quote.ts`, `price-lock.ts` (canonical hash, `compareLock`), `ledger-entry.ts` (`orderPaidDraft`), `split.ts`, `methods.ts`. Tests: 4.1 exact postings; every fee in the first quote; savings only verified; property: entry balances and `net_s >= 0` for random rates 0-10,000 bp and amounts; delta list for each change kind.
2. `src/testing.ts` fakes: `FakePaymentProvider` (HMAC-SHA256 over raw body with a test key; scriptable outcomes requires_action, captured, decline, timeout, already_captured; records split and keys), shipping, risk, commission, address, tax category, quote token (HMAC), cipher, refund recorder.
3. `src/application/pg-store-credit.ts` (`StoreCreditPort` over ledger_holds + `balance`), `checkout-service.ts` (`quote`, `place`, resume, `confirmCod`), `webhook-processor.ts`, `expiry-sweeper.ts`.
4. PGlite tests (outlet_app user ctx; webhook as outlet_worker job `payments.webhook`): stores A, B, C -> one charge = sum, ledger 3 seller payables + commission + VAT + shipping, trial balance 0; duplicate taps -> one group; duplicate webhook -> no double claim or post; webhook before redirect; expired then paid -> late claim, and no stock -> refund request + apology event; split tender hold released on failure; price change -> 409 deltas; COD skips intent and PSP; kill switch per method; tenant negatives (shopper B -> not_found, seller A cannot read B's seller order); quote statement count.

## 12. Deviations, requests and open items

Deviations (also in the 0016 header): holds are `ledger_holds` rows, not pending postings (data model 7.16: postings stay immutable); quote writes nothing, session is created at placement; raw body encrypted (`body_ct`), not plain jsonb; extra columns listed below; payment_events_raw not partitioned in Phase 1; COD cannot be combined with store credit in Phase 1 (credit would be held for days until delivery; default, revisit with fulfilment); COD above `codMaxFirstOrder` is refused in `place()` regardless of the risk adapter (C6) and the default risk adapter, `UnconfiguredRisk`, returns `block` (fail closed); payment methods with a non-zero fee are excluded at quote time because the ledger has no `payment_fee_revenue` account yet (C8; add the account, then lift the exclusion); a bag line outside qty 1..10 is a 422 `invalid-quantity` (C10); a quote token reused with a second Idempotency-Key is a 409 `quote-token-invalid` (C7); the late-payment refund request is owned by the outbox consumer, not the webhook (C4); outlet_worker UPDATE on reservations, inventory_units and inventory_levels is column-limited to what claim, release and the pool top-up write (C3; INSERT/DELETE on inventory_units, needed only if a release must grow or trim the pool, is NOT granted and would fail closed).

Requests to other owners: **R1** inventory `ReservationService.releaseIn(tx, reservationId)` (release inside the failure transaction; until then the reservation lapses at TTL, 24 h for Fawry); **R2** pricing-integrity batch snapshot; **R3** ledger: confirm `refund_issued` for late refunds and own `ledger_holds`; **R4** cart `defect_ack_*` (422 `defect-ack-missing` cannot be enforced yet); **R5** addresses table (AddressPort fake until then); **R6** `data_inventory.yaml` rows; **R7** `retention_policies.tax_records_orders` names table `orders`, which does not exist (order tables are uncovered).

New columns for data_inventory (P1 unless noted): order_groups `idempotency_key`, `payment_method`, `payment_expires_at`, `reservation_id`, `shipping_vat_minor`; seller_orders `commission_vat_minor`, `seller_net_minor`, `shipping_vat_minor`; order_lines `evidence_ids_snapshot`; checkout_sessions `quote_hash`, `payment_method`, `reservation_id`, `address_ref` (P2); payment_events_raw `body_sha256`, `failure_reason`; ledger_holds `user_id` (P2).

VERIFY: V4/V41 (Paymob split, sub-merchant, settlement), V5 (methods), V63 (COD under split), Paymob webhook timestamp and retry policy, V7 (refund deadline).
