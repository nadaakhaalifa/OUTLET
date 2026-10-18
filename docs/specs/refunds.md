# Spec: Refunds (RefundRouter, refund machine, ledger-first processing)

Status: implemented for Phase 1 on synthetic data. Sources: master prompt 15.6, 22, B3, T4; ADR-0021 decisions 3 and 5; ADR-0003; ADR-0018.
Code: `packages/domain/src/refunds`, `apps/api/src/modules/refunds`, migration `0034_refunds_store_credit.sql`.

## Flow
1. The returns (or orders cancellation) module emits `return.refund_intent` through the outbox with the per-line allocation.
2. `IntakeRefundIntent` consumes it through the inbox (consumer `refunds.return_intent`): validates the schema (strict Zod), loads payment facts (`RefundFactsPort`), checks owner and store agree, re-checks the allocation arithmetic, routes with `routeRefund`, builds the journal entry with `buildRefundEntry`, and stores refund + legs + `refund.requested` in one unit.
3. `ProcessRefund` (called by `SweepRefunds`) posts the stored entry to the ledger (idempotent on its key) BEFORE any provider call, marks the refund `APPROVED`, then drives each leg.
4. Credit legs restore HAUL credit (`CreditRestorePort`, idempotent on leg id). Provider legs call `RefundExecutionPort` with the leg id as the provider idempotency key. Payout legs wait for a verified IBAN or wallet (`PayoutDetailsPort`) without failing.
5. Provider answers: `confirmed` completes; `pending` waits for `ConfirmProviderOutcome` (webhook adapter, already signature-verified and deduplicated); `rejected` or a thrown error becomes `FAILED` with exponential backoff and jitter, then `MANUAL_REVIEW` after `MAX_REFUND_ATTEMPTS`. Finance resolves a manual-review leg with `ResolveManualReview` (transferred or retry).
6. Shopper reads: `GET /v1/me/refunds` (cursor), `GET /v1/refunds/:id`.

## Rules
RefundRouter (pure, `routeRefund`):
| Tender | Default route | Shopper choice |
|---|---|---|
| card, Apple Pay, Meeza | `psp_original` | may choose instant credit |
| mobile wallet, InstaPay | `psp_reverse` if the PSP supports it, else `bank_transfer_iban` (needs verified IBAN); VERIFY VR-RF-01 | may choose instant credit |
| Fawry | store credit or `fawry_voucher` by `RefundRouterConfig.fawry`; VERIFY VR-RF-02 | may choose credit |
| BNPL | `bnpl_cancel` (provider cancellation) ONLY; VERIFY VR-RF-03 | none: the preference is ignored and noted |
| COD | instant `refund_credit` by default; bank or wallet transfer if chosen (needs verified details); VERIFY VR-RF-04 | credit or transfer |
| store credit, gift card | `store_credit_original_sub`: back to the same sub-balance | none |

- Allocation across tenders: pro rata to each tender's refundable remainder with largest-remainder (`allocate`), parts sum to the total. Compared with "external method first" (leaves credit tenders unrefunded and pushes cash-like value out first) pro rata mirrors how the order was paid and cannot exceed any tender when the total does not.
- Per-line allocation (item, voucher share, delivery fee share, net) arrives in the intent and is re-checked: lines sum to net, `item - voucher + fee = net`.
- SLO: initiated within 24 h of return receipt, paid within the legal deadline (assumed 14 days, VERIFY VR-RF-05). `sloState` is a pure function of timestamps.
- Retry delay: `min(1h, 60s * 2^(n-1))`, half to full with jitter supplied by the caller (pure).
- Leg state is the shared Refund machine: `REQUESTED -> LEDGER_POSTED -> SUBMITTED -> COMPLETED | FAILED(retry) | MANUAL_REVIEW`; refund status is `aggregateStatus` of legs (REQUESTED, APPROVED, PROCESSING, COMPLETED, FAILED, MANUAL_REVIEW, CANCELLED).
- Algorithm choice for retry: fixed interval versus exponential with jitter. Exponential with jitter, because a provider outage otherwise sees synchronised retries from every refund at once.

## Edge cases
- Payment facts not yet available: the intake throws, the message is not marked processed and is retried by the relay.
- Same return republished under another message id: `exists`, nothing created (unique idempotency key `refund-intent:{returnId}`).
- Intent for another user's order or another store: rejected with a recorded `refund.intent_rejected` event, not retried.
- Amount above what the tenders can still refund, or negative: rejected (`not_refundable`).
- Crash between ledger post and provider call: the next sweep resumes; the ledger post, credit restore and provider call are each idempotent.
- Provider timeout after the provider accepted: the same idempotency key returns the first outcome.
- COD payout details missing: refund stays `APPROVED`, not failed; the SLO view shows it.
- Zero or EGP-foreign currency: rejected.

## Data (PII class P1 unless noted)
`refunds` (user_id P2, allocation_lines, ledger_entry jsonb, unique idempotency_key), `refund_legs` (CHECK `(method='bnpl') = (channel='bnpl_cancel')`, credit_sub required iff credit channel), `refund_attempts` (unique leg_id + attempt_no). RLS: owner read, staff read, writes by `app.role = 'system'`. Tags in `docs/privacy/data_inventory.yaml`. Retention follows `orders_tax_records`.

## API
| Method and path | Auth | Idempotent | Rate limit |
|---|---|---|---|
| `GET /v1/me/refunds?cursor=&limit=` | buyer token, subject only | n/a (read) | 60/min/user |
| `GET /v1/refunds/{id}` | buyer token; foreign or missing id is 404 | n/a (read) | 60/min/user |

There is deliberately no HTTP write: refunds exist only from `return.refund_intent`, so a client cannot mint or redirect one (route-absence test). Admin manual-review resolution is an application use case (`ResolveManualReview`); its HTTP route and the dual-approval threshold (policy rule `refund.approve`) belong to the admin console wiring (integrator).

## Events
Outbox (same transaction as the state change, ids and amounts as strings): `refund.requested`, `refund.approved`, `refund.completed`, `refund.failed`, `refund.manual_review`, `refund.intent_rejected`. Inbox: `return.refund_intent` (consumer contract test against the returns module schema).

`order_line.refunded` (aggregate `refund`): one per refunded line, written in the same transaction as the refund's transition to `COMPLETED` (ledger-first is already done by then). Payload: `refund_id`, `seller_order_id`, `order_line_id`, `user_id`, `line_merchandise_gross` (line value after item discounts, null on refunds written before the field existed), `refunded_merchandise_gross` (cumulative goods over every COMPLETED refund of the seller order for that line), `delta`, `currency`. Consumer: creators `ApplyLineRefund` (monotonic, so a redelivery or a smaller cumulative claws back nothing). Producer spec: `docs/specs/commerce-events.md`.

## Failure handling
Provider timeout 10 s (adapter), retry up to `MAX_REFUND_ATTEMPTS` with backoff, then `MANUAL_REVIEW` plus an alert event. Ledger unavailable: the pass throws and is retried by the sweeper. The sweeper is safe to run concurrently (guarded transitions return `stale`).

## Security and abuse
BOLA: reads are keyed by token subject; non-owner is 404. No client-supplied refund destination exists. Provider responses are treated as untrusted (Zod at the adapter boundary, API10). BNPL cash conversion is blocked three ways: router, domain property test, DB CHECK constraint (B3). Paymob is not contracted: only a fake and a recorded-fixture executor exist, every assumption is a VERIFY row (VR-RF-01..08).

## Metrics
Refund initiation within 24 h (SLO >= 99 %), time to completion p95, MANUAL_REVIEW count, provider failure rate by channel, drift between legs and ledger (0).

## Acceptance
- Card refund: ledger entry posted once, one provider call keyed by the leg id, status COMPLETED, replay is a no-op.
- BNPL order with a store-credit preference: only `bnpl_cancel`, no credit restored.
- For any tender mix and choice: legs sum to the refund, the posted entry sums to zero, replay posts nothing new (property tests).

## Wave 4 review fixes (F-2, F-5, F-6, F-8, F-14)
- **One allocation.** `planRefundLegs` (domain `refunds/plan.ts`) calls `ledger-posting::planRefund`; its voucher release, total and per-tender draw are both the ledger entry (`buildEntry({type:"refund"})`, key `refund:<refundId>:<storeId>`) and the legs. The returns module's net must equal the plan total, else the intent is rejected `allocation_mismatch`. The old voucher split (`refunds/ledger-entry.ts`) is deleted.
- **Entry id.** The uuid chosen at intake is stored in `StoredEntry.id` and posted unchanged; the posting service rejects any other id. Composition test `composition/refunds-ledger.test.ts` runs intake to process against the real `PostingService` through `LedgerGateway`.
- **Capacity.** `RefundFacts` carries `lines[{orderLineId, gross, refundedBefore}]`, voucher totals by funder and `orderGroupId`. Intake adds what the module already holds for the seller order (`committedForSellerOrder`) and enforces `refundedBefore + item <= gross` per line and per tender; unknown line, over a line or over a tender is `not_refundable`. Intents are serialised per seller order: `intake` carries `expectedCommitted` (count of live refunds) and returns `stale` (use case throws retryable `RefundIntakeConflictError`) when another intent committed in between; Postgres takes an advisory lock per seller order. A re-publication of the same return stays `exists`.
- **Facts contract.** `tenders[].refundedBefore` and `lines[].refundedBefore` must cover refunds of OTHER seller orders and refunds not held by this module; the module adds its own for this seller order.
- **Recognition.** The stored entry carries `requires = [order_paid:<g>, order_cod_confirmed:<g>]`; `ProcessRefund` throws the retryable `RefundRecognitionMissingError` unless one exists in the ledger (`RefundLedgerPort.hasEntry`). The sweeper skips such refunds and continues.
- **Provider callbacks** look the leg up by `(provider, providerRef)`.

## RefundFactsPort requirements (R-3, R-4, wave 4 re-review)

The real `RefundFactsPort` (payments and orders read model, ticket I-1) MUST satisfy:

1. **Delivery fee from facts, never from the intent.** `RefundFacts.deliveryFee` is the fee the shopper paid for the seller order and `deliveryFeeRefundedBefore` is what refunds outside this module already returned. Intake rejects (`allocation_inconsistent`) any intent whose fee exceeds `deliveryFee - deliveryFeeRefundedBefore - fee already held by this module`, so repeated partial intents never refund the fee twice nor draw a sibling store's tender.
2. **In-flight refunds count toward every cap.** `RefundFactsPort.refundedBefore` (tenders and lines) MUST include non-COMPLETED (REQUESTED, APPROVED, PROCESSING, MANUAL_REVIEW) refunds of every sibling seller order of the same group that this module holds, not only completed ones. This module adds its own non-cancelled refunds for the seller order being refunded; for sibling seller orders the port is the only source, or intake must lock and count at group level.
3. A required test for the real port: two concurrent intents on stores A and B of one group whose sum exceeds the remaining tender capacity; exactly one is created.
4. **Recognition.** Refunds post only after the order's recognition entry exists: `order_paid:{group}` (written by checkout through the single `orderRecognitionKey` in `packages/domain/src/checkout/ledger.ts`) or `order_cod_confirmed:{group}` (written by fulfillment at delivered_at). Until then processing fails closed and retries.
