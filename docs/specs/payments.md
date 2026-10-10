# Payments (spec sections 7, B8, 15.6)

Status: Phase 1, synthetic data only, fakes and a fixture-only Paymob adapter, nothing deployed · Module: `apps/api/src/modules/payments` · Pure rules: `packages/domain/src/payments` · Migration: `0032_payments.sql` · Privacy: `docs/privacy/data_inventory.yaml` (`payment_intents`, `payment_events_raw`, `payment_refunds`, `payment_methods`)

## Hard limits
* **Paymob is not contracted.** There is an in-repo `FakePaymentProvider` and a `PaymobPort` that talks only to a `PaymobTransport`. The only transport in the repo replays hand-authored fixtures (`adapters/paymob/fixtures`). There is no HTTP client in this module, a test scans the module source for network APIs. Every endpoint, field, header and signing assumption is a VERIFY BEFORE LAUNCH row (VR-PAY-01 to VR-PAY-12).
* **SAQ A.** No card data exists in any schema, table, outbox payload, log line or fixture. Saved cards are PSP tokens plus `brand, last4, exp_month, exp_year, fingerprint`. Tests assert it by schema introspection, migration column scan, fixture scan and a Luhn scan of stored webhook bodies.
* **No ledger writes here.** This module records PSP truth and emits `payment.*` events. Posting to `psp_clearing` is the checkout saga's job on `payment.succeeded` (spec 7 step 6).
* **No live network calls.**

## Flow
1. Checkout calls `CreatePaymentIntent({orderGroupId, userId, method, amount, containsDropSku})`. The `payment_intents` row is inserted FIRST (`CREATED`, unique per `order_group_id`), then the router picks a provider and the PSP is called with `Idempotency-Key = order_group_id`, then the row gets `provider_ref`, `client_action` and `REQUIRES_ACTION`. A webhook that races the response still finds the row by `order_group_id`.
2. The shopper authenticates (3-DS, Apple Pay sheet, wallet redirect, InstaPay request, Fawry reference).
3. The PSP posts `POST /v1/webhooks/{provider}`. The handler authenticates, stores the raw event durably, appends `payment.webhook_received` to the outbox in the same transaction and answers 200. Nothing else happens in the request.
4. The outbox consumer `ProcessPaymentWebhook` normalizes the stored event, locks the intent, applies the state machine, writes the state change, `payment.succeeded|failed|authorized|voided|refunded|anomaly` events, the inbox row and marks the raw event processed, all in one transaction.
5. Capture, void and refund are explicit use cases that call the provider with deterministic idempotency keys and then apply the same transition code.
6. `ExpirePaymentIntents` (sweeper) retrieves each overdue intent from the PSP first (a late success wins), otherwise voids and marks it `FAILED(expired)`.

## State machine: payment intent
`CREATED, REQUIRES_ACTION, AUTHORIZED, SUCCEEDED, FAILED, VOIDED, PARTIALLY_REFUNDED, REFUNDED`

| From | Events |
|---|---|
| CREATED | REQUIRE_ACTION, AUTHORIZE, SUCCEED, FAIL, VOID |
| REQUIRES_ACTION | AUTHORIZE, SUCCEED, FAIL, VOID |
| AUTHORIZED | SUCCEED (capture), FAIL, VOID |
| SUCCEEDED | REFUND_PARTIAL, REFUND_FULL (guarded by amounts) |
| PARTIALLY_REFUNDED | REFUND_PARTIAL, REFUND_FULL (guarded) |
| FAILED, VOIDED, REFUNDED | terminal |

A refund never exceeds the captured amount: the guards reject `refunded + refund > amount`. A void after capture is not a transition (it is a refund). Property tests walk random event sequences and assert only declared states, no escape from terminals, `0 <= refunded <= amount`, and `analyze()` is `ok` (no unreachable state, no dead end).

Out-of-order and conflicting events (`decideWebhookEffect`): a stale event for a state already past it is a no-op; a success for a `FAILED/VOIDED` intent, a failure for a `SUCCEEDED` intent, an amount or currency mismatch, and an unknown refund are **anomalies**: no state change, `payment.anomaly` emitted for finance. We never blindly move money state on a conflicting PSP message.

## Rules
| # | Rule |
|---|---|
| P1 | One intent per OrderGroup (`UNIQUE order_group_id`). A second create with the same parameters returns the same intent and the same `client_action`; with different amount, currency or method it is a conflict. |
| P2 | Amounts are bigint piastres, currency `EGP` only. `succeeded` events must match the intent amount and currency exactly. |
| P3 | Payment window per method (metadata, not hard-coded in callers): card, meeza, apple_pay 10 min; mobile_wallet and instapay 30 min; fawry 24 h. |
| P4 | Fawry reference expires after 24 h and is sold from the separate non-drop stock pool; drop SKUs are not payable with Fawry (`dropSkusAllowed=false`, enforced in availability and in create). |
| P5 | Kill switch per method through `PaymentMethodSwitchPort` (backed by `FlagClient.isPaymentMethodEnabled`, fail closed, `meeza` uses the card switch). A killed method is not offered and cannot create intents. |
| P6 | Failover: ordered providers per method, consecutive-failure circuit breaker with a single half-open probe. Only definitive "not accepted" outcomes (`unavailable`) fail over to the secondary; an ambiguous `timeout` is retried idempotently on the SAME provider (x3) and is never sent to another PSP, because the first PSP may have created the intent (double charge risk). The intent stays `CREATED` and is resolved by `retrieve` in the sweeper. |
| P7 | Declines are business outcomes, they never count against the breaker. |
| P8 | Saved cards: PSP token only; unique per `(provider, psp_token)`; deleting is a soft delete after asking the PSP. |

## Algorithm comparison (2 to 3 lines each)
* **Webhook processing.** Inline processing in the HTTP request gives the fastest state but a slow or failing handler makes the PSP retry-storm and ties DB locks to a third party's clock. Store-then-outbox answers fast and replays safely. Chosen: store + outbox, processing is idempotent by inbox row and by `processed_at`.
* **Dedup key.** `UNIQUE(provider, event_id)` on every row lets an attacker pre-register a real event id with a forged body and block the genuine one. Chosen: unique only over rows with `signature_ok`, and rows that failed verification get the synthetic id `unverified:<sha256(body)>` so identical garbage dedups too.
* **Circuit breaker.** A sliding error-rate window needs bucketed counters and a clock per provider; consecutive-failure counting with half-open is a tiny immutable value and is exhaustively testable. Chosen: consecutive failures (default 5), open 30 s, one probe, probe timeout 10 s. Per-process state (documented gap for multi-instance).
* **MAC verification.** HMAC over `timestamp "." rawBody`, constant-time `timingSafeEqual` on equal-length digests, secrets list for rotation, timestamp window of 5 min in both directions.

## Edge cases
* Raw body not available (server not started with `rawBody: true`): the route answers 500 so the PSP retries, never stores an unverifiable body as authentic.
* Body above 256 KiB: refused with 413 before any storage.
* IP not on the allow-list: 403, nothing stored (flooding guard). Verified and failed-signature bodies from allowed IPs are both stored; only verified ones are processed.
* Timestamp outside +-5 min is a verification failure (`timestamp_out_of_window`). A PSP that retries with the original timestamp after 5 min is rejected and the intent is recovered by `retrieve` (VR-PAY-07).
* Duplicate delivery: `duplicate` answered 200, no second processing.
* Unknown provider path: 404, nothing stored.
* Event for an intent we do not have yet: consumer throws `PaymentIntentNotFoundYet`, the relay retries with backoff and DLQ.
* Payment succeeded after the intent was expired/failed: `payment.anomaly(late_success)`, checkout decides (auto-claim if stock, else refund, spec 7).
* PSP outage: breaker opens, secondary used, or the method disappears from availability.
* Money fields in a JSON body that contains a PAN-shaped string: the stored body is redacted and a `payment.anomaly(pan_in_webhook)` is raised (should never happen under SAQ A).

## Data
`payment_intents(id, order_group_id UNIQUE, user_id, provider, provider_ref, method, amount, currency, status, refunded_amount, client_action jsonb, idempotency_key, failure_code, expires_at, version, created_at, updated_at)` · `payment_events_raw(id, provider, event_id, signature_ok, reject_reason, body jsonb, body_sha256, received_at, processed_at, process_outcome)` · `payment_refunds(id, intent_id, idempotency_key UNIQUE, amount, status, provider_refund_ref, failure_code)` · `payment_methods(id, user_id, provider, psp_token, brand, last4, exp_month, exp_year, fingerprint, deleted_at)`. PII classes in `data_inventory.yaml`. RLS: owner reads own intents and saved methods; all writes and raw events are `app.role = 'system'`.

## API
| Method and path | Auth | Idempotent | Rate limit |
|---|---|---|---|
| `POST /v1/webhooks/{provider}` | public, HMAC + timestamp + IP allow-list | by event id | 600/min IP |
| `GET /v1/payments/methods?amount=&contains_drop_sku=` | buyer, self | n/a | 60/min user |
| `GET /v1/me/payment-methods` | buyer, self | n/a | 60/min user |
| `DELETE /v1/me/payment-methods/{id}` | buyer, self, owner else 404 | by nature | 30/min user |

Intent creation, capture, void and refund are application use cases for checkout and the refund router, not public HTTP routes.

## Events (outbox, aggregate `payment_intent` unless noted)
`payment.webhook_received` (aggregate `payment_event`), `payment.authorized`, `payment.succeeded`, `payment.failed`, `payment.voided`, `payment.refunded`, `payment.refund_failed`, `payment.anomaly`, `payment_method.saved`. Payloads: ids, amounts as strings, codes. No card data, no raw bodies.

## Failure handling
PSP calls: timeout 10 s (adapter), 3 idempotent attempts with exponential backoff and jitter on the same provider; the breaker and failover as in P6. Webhook consumer: at-least-once, idempotent by inbox and `processed_at`. Dead letters go through the outbox DLQ and a replay tool. User-visible fallback: method hidden when no provider is available.

## Security and abuse
OWASP API: API1 (saved cards owner scoped, 404), API4 (body cap, rate limit), API6 (checkout keeps its own limits), API8 (secrets only from config), API10 (all PSP responses schema validated, timeouts, breaker). Timing attacks: constant time compare. Replay: timestamp window + event dedup. Forged success: signature, amount and currency match, unknown ref goes to anomaly. Log hygiene: signature headers and bodies are never logged.

## Metrics
Product: payment success rate by method, 3-DS drop-off. SLI/SLO: webhook to `payment.succeeded` p95 < 5 s, checkout success >= 99.5% (owned by checkout). Guardrail: anomaly rate, signature-failure rate, breaker open time, late-success rate (alert above 0.1%).

## Acceptance (Gherkin)
* Given a CREATED intent, when a signed `payment.succeeded` webhook with the right amount is posted twice, then exactly one `payment.succeeded` outbox event exists and the intent is SUCCEEDED.
* Given a body with a valid signature but a timestamp 6 minutes old, then the response is 200, the row has `signature_ok=false`, and no state changes.
* Given the card kill switch is off, then `card` and `meeza` are not available and create fails with `method_unavailable`.
* Given the primary is open-circuit, then the secondary is used; given a primary timeout, then no call reaches the secondary.
* Given a cart with a drop SKU, then Fawry is not available.
* Given a user B calling `DELETE /v1/me/payment-methods/{A's id}`, then 404 and A's token is intact.
