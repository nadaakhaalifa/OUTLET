# Spec: checkout (multi-store, one payment), Phase 1 / F-1

Status: IMPLEMENTED on fakes and PGlite, awaiting the Fable-tier money review (ADR-0021) and integrator wiring · Spec refs: master prompt §7, §6, §15.2, §15.6, §20.2, §20.7, §T4, §B2, §B3, §B8 · ADR-0003, ADR-0011, ADR-0018, ADR-0019, ADR-0021 · Related specs: `orders.md`, `inventory.md`, `promotions.md`, `tax-eta.md`, `cart.md`, `ledger-chart-of-accounts.md`.

Scope: quote, commit (saga), payment events, recovery. `GET /v1/order-groups/{id}` stays in `orders`. Hard limits: Paymob is not contracted, so only an in-repo fake and a recorded-fixture adapter exist behind `PaymentProviderPort`; no live network calls; every PSP endpoint, field or window assumption is a VERIFY row (VR-CHK-1..8, `docs/compliance/verify-register.md`).

## Flow
1. **Quote** `POST /v1/checkout/quote` (pure, no writes). The server reads the bag (server prices), evaluates promotions in two passes (item-scope discounts first, because the free-delivery threshold is measured after item-level discounts and before vouchers; then the final evaluation with the resulting shipping fees), asks tax for line VAT, applies the Plus waiver, plans store credit, and returns every fee on the first render (no drip pricing), the method list with availability reasons (COD from risk, BNPL from the age policy, Fawry excluded when drop SKUs are present), and a signed `price_lock` token valid 10 minutes.
2. **Commit** `POST /v1/checkout` (idempotent, `Idempotency-Key` required, App Attest assertion required when the flag is on). Re-prices, enforces gates, applies the price lock, creates the saga row and OrderGroup id, runs the saga to its first wait point, and returns `client_action` (`none`, `redirect`, `sdk`, `fawry_reference`, `await_confirmation`).
3. **Saga** (persisted, one row per OrderGroup, optimistic version): `VALIDATE_CART -> RESERVE_INVENTORY -> HOLD_CREDIT -> CREATE_INTENT -> AWAIT_PAYMENT -> CLAIM_AND_POST -> PLACED`. Steps that do not apply are skipped (no credit: no hold; COD or nothing external: no intent).
4. **Payment events** `POST /v1/webhooks/{provider}`: HMAC verified over the raw body by the provider adapter, dedup on provider event id, recorded on the saga whatever step it is in (webhook before redirect), then the saga advances.
5. **Recovery**: a sweeper (`RecoverSagas`, worker, idempotent) re-drives every non-terminal saga whose `next_wake_at` has passed.

## Rules
- One payment intent per OrderGroup, PSP idempotency key = `order_group_id` (ADR-0021 d6). One reservation per OrderGroup. Client totals are never trusted: the commit carries `expected_total` and a difference is a 409 `price_changed` with the delta and a fresh quote token (re-confirmation).
- **Price lock** is stateless: HMAC-signed token over `(user, expiry, sku -> unit price, total)`. Inside the window the shopper pays the lower of locked and current unit price; after it, the current price. Options compared: (a) persist quotes server side (strong, but turns a pure endpoint into a writer and needs expiry sweeps); (b) signed token (chosen: keeps quote pure, no storage, tamper-evident).
- **Free delivery** (spec 6): Plus -> 0; else store merchandise after item-scope discounts and before vouchers >= effective threshold -> 0; else the store fee. A shipping promotion may still discount a charged fee.
- **Tender**: store credit first in the chart's spend order (soonest expiry first, refund credit last), then exactly one external method. COD never combines with store credit (COD is recognised in the ledger at delivery, ADR-0021 builder rule; safest default, recorded as a decision here). A fully credit-covered order creates no intent but still records the shopper's chosen method.
- **Reservation window** by method from ADR-0011 defaults (card 10 min, wallets and InstaPay 30 min, BNPL 15 min, Fawry 24 h separate pool, drop SKUs excluded from Fawry). The inventory port owns the clock; the saga stores `expires_at`.
- **Ledger-first**: at `CLAIM_AND_POST` the order is recognised (`orderRecognised`, balanced, idempotency key `checkout:{order_group_id}:recognised`) before orders are placed. A failure after posting compensates with a reversing entry. COD posts nothing at checkout.
- **Late payment** (success after expiry): revive the saga, take the credit hold again if needed, claim directly; claimed -> place orders; no stock -> refund through the provider, park and release the receipt in the ledger (`late_receipt_*`), emit `checkout.apology_voucher_requested`, increment `checkout_late_payment_refund_total` (alert above 0.1% of paid groups).
- **Compensation order**: refund or void intent, reverse ledger, release hold, release reservation. Never after orders are placed (cancellation belongs to orders).
- COD: risk decision `allow` places immediately; `require_confirmation` waits for `ConfirmCodOrder` (OTP or WhatsApp result); `require_prepayment`, `prepaid_only`, `limit_value` (over the cap), `block` make COD unavailable with a typed reason.
- Age gates: account 18+ is enforced at auth; BNPL and Plus use the age policy port (provider KYC decides BNPL, "eligibility checked by {provider}").
- Rate limits declared: quote 30/min/user; commit 5/min/user, 10/min/device, 20/min/IP (API6).

## Edge cases
Duplicate taps and retries: same key -> same OrderGroup and the stored response (different body -> 422). A second key for the same bag and method while a saga is live -> the live saga (one OrderGroup). Empty bag or every line unavailable -> 409 `bag_empty`; unavailable lines are excluded and listed (checkout continues for the rest, spec 6). Stock shortfall at reserve -> 409 `insufficient_stock` with shortfalls, nothing held. PSP create fails -> compensate (release reservation and hold), 502 `payment_unavailable`. Webhook for an unknown group -> 202 stored (never 404-oracle). Webhook amount differing from the intent -> recorded `amount_mismatch`, saga not advanced, alert. Process killed between any two steps -> recovery resumes, every port call is keyed. Payment succeeded after cancellation -> refunded, never placed. Store suspended between quote and commit -> line unavailable at validation.

## Data
Migration `0033_checkout.sql`: `checkout_sagas` (PK `order_group_id`, `user_id`, `idempotency_key` unique per user, `request_hash`, `status`, `facts jsonb` (saga facts), `quote jsonb` (money as strings), `version`, `next_wake_at`, `attempts`, `last_error`), `checkout_payment_events` (provider, `event_id` unique, saga id, kind, amount, `signature_ok`, received_at; raw body stored as text for audit, P2). PII: none beyond ids; no address, phone or card data (PSP tokens only). RLS: owner read, system write.

## API
| Route | Auth | Idempotent | Rate limit |
|---|---|---|---|
| `POST /v1/checkout/quote` | buyer, self | no (pure) | 30/min user |
| `POST /v1/checkout` | buyer, self, App Attest | yes, required | 5/min user, 10/min device, 20/min IP |
| `GET /v1/checkout/{order_group_id}` (saga status, owner only, 404 otherwise) | buyer, resource | no | 60/min user |
| `POST /v1/checkout/{order_group_id}/cancel` | buyer, resource (owner else 404) | yes, required | 10/min user |
| `POST /v1/checkout/{order_group_id}/confirm-cod` (body `code`, verified through `CodConfirmationPort`) | buyer, resource | yes, required | 5/min user |
| `POST /v1/webhooks/checkout/{provider}` (spec path `/v1/webhooks/{provider}`; namespaced so it cannot collide with a payments route, the integrator may alias) | public, HMAC over the RAW body + timestamp | dedup on event id | 600/min IP |

## Events (outbox, same transaction as the saga write)
`order_group.paid`, `order_group.failed`, `order_group.expired`, `checkout.late_payment_refunded`, `checkout.apology_voucher_requested`, `checkout.saga_stuck`. Analytics (consent-aware, owned by the client and analytics ingest): `checkout_started`, `payment_selected`.

## Failure handling
PSP and other port calls: timeout 10 s (adapter), retried by the recovery sweeper with backoff (`next_wake_at = now + min(2^attempts, 300) s`), idempotent by key. Max 8 attempts on a step, then `checkout.saga_stuck` and the saga stays for Ops (never silently dropped). Webhook processor: unmatched or failed events stay in `checkout_payment_events` for replay (DLQ equivalent).

## Security and abuse
BOLA: sagas and groups readable by owner only, others 404. API6 sensitive flow: rate limits above plus App Attest on commit (flag `checkout.require_app_attest`, default on outside tests). Webhook: HMAC over raw body, timestamp +-5 min, IP allow-list at the edge, replay dedup. Card data never reaches the module (SAQ A). Seller text never enters prompts here. Threat notes: price tampering (server prices + signed lock), replay (idempotency + event dedup), double charge (one intent key), oversell (reservation then claim), reservation leak (sweeper + compensation), credit double spend (hold, then capture with the ledger entry).

## Metrics
Checkout success >= 99.5% (SLO), time to confirmation p95 < 5 s, late-payment refund rate < 0.1%, saga recoveries per hour, stuck sagas = 0, quote p95 < 300 ms.

## Acceptance (Gherkin, become E2E)
- Given a bag with stores A, B, C, when the shopper pays by card, then one intent equals the sum, the ledger shows three seller payables, commission and VAT, and balances to zero.
- Given the API process is killed at any step boundary, when recovery runs, then there is at most one charge, no oversell, and no leaked reservation or hold (deterministic harness).
- Given payment succeeds after the reservation expired and stock remains, then orders are placed; given no stock remains, then the payment is refunded, an apology voucher intent is emitted and the alert counter increments.
- Given the same `Idempotency-Key` twice, then one OrderGroup; a different body with the same key -> 422.
- Given the price changed between quote and commit outside the lock, then 409 with delta; inside the lock the shopper never pays more than the locked unit price.

## Decisions and options compared (added at implementation)
- **Saga driver.** (a) Choreography over outbox events: no central row, hard to prove "no leaked hold" and harder to resume. (b) Persisted orchestrator row driven by a pure `nextAction(facts, now)`, one effect per loop, CAS save with the outbox events (chosen). Every port call is keyed by the OrderGroup (`hold:{g}`, intent key `{g}`, ledger key `checkout:{g}:recognised`, orders key `checkout:{g}:place`, refund key `checkout:{g}:refund`), so effect-then-save is safe: a kill between them replays the same effect and gets the same answer. The opposite order (save intent-to-do, then effect) was rejected because it needs a second reconciliation state for "intent recorded, effect unknown".
- **Hold ids after a revive.** A late payment revives an expired saga whose credit hold was released. A released hold id must not be reused (the store-credit port contract is unverified), so the facts carry `holdSeq` and the hold id is `hold:{g}` then `hold:{g}:{n}`.
- **Ledger of a payment with no order.** Money that arrives for a saga that can no longer place orders is parked (`late_receipt_parked`: Dr psp_clearing, Cr refund_reserve) before the refund leaves, then released (`late_receipt_refunded`). When `OrderRecognised` was already posted it is reversed instead, and the PSP refund nets against the reversed clearing debit. VERIFY VR-CHK-6.
- **COD confirmation** is verified server side through `CodConfirmationPort` (OTP or WhatsApp code), never by a client-asserted boolean.
- **Failure of a port** (timeout, 5xx) never fails the saga: attempts and backoff are persisted, the sweeper retries, and after 8 attempts (or a ledger key conflict) the saga is parked `stuck` with `checkout.saga_stuck`. Money is never auto-refunded from a stuck saga: Ops decides.
- **Payment events** record `rejected` with `amount_mismatch` when the amount or the intent differs from the saga. The route answers 200 "recorded" so the PSP does not retry, the counter `checkout_amount_mismatch_total` alerts.

## Ports (all injected, fakes for tests, nothing live)
`CartPort`, `PromotionsPort` (domain evaluator in the fake), `TaxPort`, `RiskPort`, `AgePolicyPort`, `KillSwitchPort`, `AddressPort`, `AppAttestPort`, `CodConfirmationPort`, `InventoryPort`, `StoreCreditPort`, `PaymentRegistry` + `PaymentProviderPort` (in-repo fake, recorded-fixture adapter), `LedgerPort`, `OrdersIntakePort` (= orders `PlaceOrders`), `MetricsPort`.

## Test evidence
Domain: pricing and ledger property tests (parts sum to total, tender sums to total, balanced entry, reversal symmetry, replay identical), saga facts property (any interleaving ends terminal, nothing leaked). API: use-case suite on fakes, application-level money property test, HTTP suite (authn, BOLA 404, idempotency, 409 shapes, raw-body webhook), repository contract on in-memory and Kysely/PGlite, migration lint + DB invariants + RLS, and the kill-point sweep (every port call, before and after, 6 scenarios on fakes; every fifth point on Postgres). The sweep asserts: at most one intent and one charge, no oversell, trial balance zero, no active reservation, no held credit, at most one placed OrderGroup, expected terminal status.

## Wave 4 money review fixes (F-1, F-4, F-11, F-13, F-14)

- **Credit hold lifetime (F-1).** `HOLD_CREDIT` passes `ttlSeconds = reservationTtlSeconds(method) + 300` to the store-credit port, so a hold outlives the method's payment window (card 10 min, wallet/InstaPay 30 min, BNPL 15 min, Fawry 24 h). `CreditHolds` also takes an optional liveness guard so a sweeper never releases the hold of a non-terminal saga.
- **Capture is a hard step.** `StoreCreditPort.capture` returns `captured | not_held | not_found`. `post_ledger` captures the hold and posts the order entry in one step (one CAS), so `holdCaptured` and `ledgerPosted` are persisted together. `not_held`/`not_found` re-holds under `hold:<group>:<seq+1>` before anything is posted; if the credit cannot be taken again the whole group is compensated (`late_credit_unavailable` when paid, else `credit_unavailable`) and the payment is refunded. For COD (no ledger entry at checkout) `capture_credit` runs before `place_orders`. Capture under the same order entry key is an idempotent replay.
- **Invariant.** After `PLACED`, the sum of `credit_used` equals the `store_credit` debits of the order entry; tested with the clock advanced past the old 10 minute TTL before the payment event.
- **Commission fails closed (F-4).** A missing or out-of-range (0..10000) commission throws `InvalidCheckoutError` in quote, in the domain ledger entry and when placing orders; `StoredSchema` rejects values outside 0..10000.
- **F-11.** Tender planning uses `availableOf(lot, now)` (expired lots are not planned). **F-13.** `reverse_ledger` never invents the original entry. **F-14.** The price-lock coverage check uses the signed lock's own expiry, persisted as `lockExpiresAtMs`.
