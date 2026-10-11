# Threat model 04: orders, returns, fulfillment, tax/ETA, reviews

Status: Draft for review · Date: 2026-10-11 · Spec refs: §20.1, §21, §22, §B4, §B5, §27 · Code: `apps/api/src/modules/{orders,returns,fulfillment,tax-eta,reviews}`.

## Trust boundaries
Shopper and seller to order/return APIs; courier to API (`POST /webhooks/couriers/{courier}`); API to courier (AWB); API to ETA (submissions); staff moderation queue.

## Threats
| ID | STRIDE | Threat | Existing control | Proving test | Status |
|---|---|---|---|---|---|
| ORD-E1 | E | Shopper reads another's order group; seller reads another store's orders (BOLA) | Ownership/tenant check, 404 | `orders/test/orders.http.test.ts`: "lists only the caller", "negative authorization" (x2), "another store"; `apps/api/src/authz-matrix.test.ts` | implemented+tested |
| ORD-I1 | I | Seller sees buyer PII before acceptance | Masking until accept; relay phone and first name afterwards | orders.http.test.ts: "masks buyer data until acceptance and exposes only relay and first name afterwards" | implemented+tested |
| ORD-T1 | T | Invalid state jump (accept twice, ship after cancel) | Typed state machine; 409 `invalid_transition`; idempotent per key | orders.http.test.ts: "a second accept with a new key is 409 invalid_transition", "accepts, is idempotent per key and emits exactly one event" | implemented+tested |
| RET-T1 | T | Return outside window or wrong reason | Window from `delivered_at`, category rules | `returns/test/returns.http.test.ts` (VERIFY titles for day-15/day-29 acceptance) | implemented, window cases to confirm |
| RET-E1 | E | Seller queue shows other stores; replay of key on another line | Role per store; key bound to request hash | `adversarial.wave3.test.ts`: "the seller return queue lists only stores where the actor holds a return-read role", "one Idempotency-Key reused on a different order line is not replayed as success"; `returns/test/returns.authz.test.ts` | implemented+tested |
| RET-T2 | T | Forged pagination cursor crashes or leaks | Cursor validation | `adversarial.wave3.test.ts` cursor tests; `returns/domain/cursor.test.ts` | implemented+tested |
| FUL-S1 | S | Forged courier webhook / replay changes shipment state | Signature check, dedup by courier event id, normalized statuses | `fulfillment/test/fulfillment.pglite.http.test.ts`: "creates, tracks to delivered, replays and records a COD remittance"; `fulfillment/test/fulfillment.authz.test.ts` (VERIFY signature-negative case title) | implemented+tested for replay; signature scheme is fixture (Bosta VERIFY, VR-11) |
| FUL-D1 | D | Courier API down loses AWB | Queued AWB job with retry | fulfillment.pglite.http.test.ts: "holds the AWB job across a courier outage and finishes it later" | implemented+tested |
| FUL-E1 | E | Seller prints label for another store's shipment | seller-order-access check | `fulfillment.authz.test.ts` | implemented+tested (VERIFY titles) |
| TAX-T1 | T | VAT exemption changed without trace | Admin route with audit; exemption audit listing | `tax-eta/test/tax-eta.http.test.ts`; `adversarial.wave3-tax-analytics.test.ts` (VERIFY titles) | implemented, partly verified |
| TAX-D1 | D | ETA submission backlog | Requeue endpoint, reconciliation report | `tax-eta/test/application.test.ts` | implemented+tested with fake ETA adapter. Real ETA signing absent (VR-06) |
| REV-T1 | T | Review by non-buyer, self-review, toxic UGC | Verified purchase check, moderation queue, report endpoint | `modules/reviews` tests (VERIFY titles) | implemented, partly verified. Image classifier absent |

## Residual risk
Courier, ETA and COD remittance adapters are fakes. COD remittance mismatch alerting depends on the reconciliation job that has no scheduler (see 03, R-PAY-2). Seller dispatch SLA auto-cancel timers have no scheduler either (VERIFY).
