# Spec P3-01: Price-drop auto-buy

Refs: §28 row 1, §14 (Plus), §12 (budget), §20.7 (risk), §B8, ADR-0036, VR-P3-01, VR-P3-02. Depends on: wishlists (alerts, `price_drop` verified only), price-integrity (`price_events`), subscriptions (entitlements), checkout saga, payments (`CardVaultPort`), budget (`AffordabilityFilterPort`), orders, notifications, fraud/risk.
Status: spec ready; build behind kill switches `price_drop_auto_buy` and `auto_buy.charge`, both off. Mode A (notify-and-confirm) is the default product; mode B (unattended charge) needs VR-P3-01 and VR-P3-02 Verified.

## Flow
1. On a PDP or wishlist item (Plus member): "Buy automatically at or below X EGP". Shopper picks size, target price (must be below current price), max price, expiry (<= 90 days) and a saved card token (mode B) or nothing (mode A). Mandate screen shows exact terms in Arabic and English; shopper confirms (biometric or passkey step-up).
2. A `price.changed` event for the SKU matches active rules (indexed by sku and target).
3. Mode A: push "Your target price was reached. Tap to buy" with deep link into normal checkout (SCA present). Stock is not held.
4. Mode B: pre-charge notice (push + in-app + WhatsApp if consented), 15-minute cancel window, then re-validate everything server-side and run the normal checkout saga with a MIT payment. Order confirmation like any order.
5. Rule closes on purchase, expiry, cancel, or item delisted.

## Rules
- Plus members only (entitlement `auto_buy`; age gate per `age_policy`, default 21 as Plus). Explicit opt-in per item; no global switch.
- Max 1 unit per rule; max 5 active rules per user (configurable); target must be a **verified** price per §9 (an unverified price drop never triggers an unattended charge; mode A may still notify).
- Never BNPL, never COD, never store credit as sole method in mode B (card token only); split tender with store credit not allowed in v1.
- At charge time recheck: price <= max price, size in stock, address deliverable, budget hard cap not breached (soft cap warns in the pre-charge notice and blocks the charge unless the mandate says otherwise), fraud decision `allow`, mandate unexpired, token valid, 18+/age policy.
- Price used is the price at charge time, never above max price. If the price rose within the pre-charge window the rule stays armed and notifies.
- Return and cancellation rights are identical to a normal order (§22). The mandate text says so.
- Reservation: placed at the start of the pre-charge window (TTL = window + payment time), released on cancel. Drop SKUs and Fawry stock pool excluded.
- One charge per `(mandate, price_event)`; idempotency key `auto_buy:{mandate_id}:{price_event_id}`.

## Edge cases
Price flaps (down, up, down) within the window: one attempt per armed cycle, 24h cool-down between attempts; item sold out in window: rule stays armed and offers nearest size with fit warning; token expired/declined: no retry storm, 1 retry after 1h then notify; user deletes card or account: all rules cancelled; Plus lapses: rules suspended, not charged; seller pauses SKU; two rules for same SKU (rejected, one active); price drop triggered by a seller error (price below cost): price-integrity anomaly flag blocks mode B and routes to mode A; clock skew (Cairo TZ for expiry display, UTC stored); app offline when cancel tapped (server-side cancel by push action and web link); concurrent cancel and charge (cancel wins if committed before the charge claim, otherwise the order is created and the shopper uses normal cancellation).

## Data
`auto_buy_mandates(id, user_id P2, sku_id, size_label, target_price BIGINT, max_price BIGINT, currency, psp_token_ref P3-ref, status, expires_at, mandate_version, accepted_at, accepted_device_id)` · `auto_buy_attempts(id, mandate_id, price_event_id, state, notice_sent_at, cancel_deadline, order_group_id NULL, failure_reason)` · unique `(mandate_id, price_event_id)`. Mandate text versions stored immutably.
State machine (domain, table-driven): `ARMED -> NOTIFIED -> (CANCELLED | CHARGING -> (PURCHASED | FAILED -> ARMED)) ; ARMED -> (EXPIRED | CLOSED)`; invalid transitions throw.

## API
| Endpoint | Auth | Idem | Rate |
|---|---|---|---|
| `POST /v1/me/auto-buy` | shopper, Plus, step-up | yes | 10/min |
| `GET /v1/me/auto-buy` | owner | no | 60/min |
| `DELETE /v1/me/auto-buy/{id}` | owner | yes | 20/min |
| `POST /v1/me/auto-buy/attempts/{id}/cancel` | owner (also signed push action) | yes | 20/min |
Internal: worker `auto-buy-evaluator` consuming `price.changed` outbox events.

## Events
Inbox (relay consumer `auto-buy.relay`, deduplicated by message id, use cases idempotent on their own): `price.changed` (evaluator), `privacy.deletion_completed` (cancel all, `account_deleted`), `order_group.paid` and `order_group.cod_confirmed` (`CloseOnPurchase` per `sku_ids`; an order without `sku_ids` is acknowledged and ignored), `payment_method.removed` (cancels every armed rule of the user with reason `card_removed`; not narrowed by token because the mandate's `psp_token_ref` is not known to equal the card id). Outbox: `auto_buy.armed`, `auto_buy.notified`, `auto_buy.cancelled`, `auto_buy.charged`, `auto_buy.failed`. Analytics (Zod): `auto_buy_created(price_band)`, `auto_buy_triggered`, `auto_buy_cancelled_in_window`, `auto_buy_purchased`. No exact budget or price in analytics.

## Failure handling
Evaluator is at-least-once, consumer idempotent (inbox). PSP MIT timeout 10 s, retry idempotently x2, then FAILED (no unknown state: reconcile through the normal PSP webhook path). Saga compensation = release reservation, void intent. DLQ with replay. Kill switch off: armed rules stay stored, evaluator no-ops, shoppers see "paused".

## Security and abuse
BOLA: mandates owner-only (404 otherwise). Step-up auth at creation. Mandate immutable once accepted; changes create a new version. Abuse: resale bots creating many rules (per-user cap, device and payment-fingerprint velocity, risk score at creation), price manipulation by a seller to trigger charges (§9.4 anomaly blocks; seller-side detection of "ping-pong" pricing), token theft (token never exposed; `psp_token_ref` only), notification phishing (deep links signed, no PII in push). OWASP API6 (sensitive business flow), API3. Chargeback risk: pre-charge notice logs are evidence.

## Metrics
Armed-to-purchase conversion, cancel-in-window rate (guardrail: > 15% means copy or targeting is off), return rate vs control (guardrail), charge failure rate, complaints per 1,000 charges (target ~0), average discount captured.

## Acceptance
```
Given a Plus member with a verified target price 649 and max 700, when the verified price becomes 640, then a pre-charge notice is sent and no charge occurs before the 15 minute window ends.
Given the shopper cancels in the window, then the reservation is released and no payment intent exists.
Given the price becomes 720 before charge, then no charge occurs and the rule stays armed.
Given the same price event is delivered twice, then exactly one attempt and at most one order exist.
Given an unverified price drop, then mode B never charges.
Given kill switch auto_buy.charge is off, then mode A still notifies and no MIT call is made (fake PSP asserts zero calls).
```
