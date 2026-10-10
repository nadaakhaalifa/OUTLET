# Domain state machines

Transition-table machines for the 13 entities named in spec A2.6. Pure and synchronous: no I/O, no clock, no randomness. Anything time- or data-dependent (return window elapsed, attempts made, budget) is computed by the caller and passed in as a typed context that guards read.

## Engine

- `defineMachine<State, Event, Context>({ name, states, events, initial, terminal, transitions })`. The `transitions` record must have a row for every state (compile-time) and is validated again at construction (`MachineDefinitionError`).
- `transition(state, event, ctx?)` returns the next state or throws `InvalidTransitionError` (event not declared for the state), `GuardRejectedError` (declared but guard failed), `UnknownStateError` or `UnknownEventError`. All extend `DomainError`.
- One target per (state, event). Branches that depend on data use distinct events, each with a guard, so the table stays deterministic and analysable.
- `can`, `availableEvents`, `edges`, `parseState` (narrow a raw DB string to a state, throws `UnknownStateError`).
- `analyze()` returns `unreachable` (states not reachable from `initial`), `deadEnds` (non-terminal states from which no terminal is reachable), `terminalsWithOutgoing`, and `ok`. Tests require `ok` for every machine.
- Persisting the state, writing the outbox event and posting the ledger in one transaction is the application layer's job. A machine only decides legality.

## How the tables were chosen

The spec lists states for SellerOrder (20.1), Subscription (14), Drop (16), KYC (19) and Payout (T4) and names transitions only partly. For the rest it names the machine but not the states. Everything below beyond the spec's literal arrows is a design choice, open to change by the owner.

- **SellerOrder** follows 20.1 exactly (all 22 states, all arrows listed there). Additions needed to make it executable: `PAYMENT_FAILED` and `CANCEL` from `PENDING_PAYMENT`; `SELLER_REJECT` also from `ACCEPTED` (stock-out after accepting, with seller penalty); `DELIVERY_FAIL` from `SHIPPED` and `OUT_FOR_DELIVERY`; `DELIVERY_FAILED -> OUT_FOR_DELIVERY` while attempts < 3 and `-> RTO` at 3 (spec 21); `RETURNED_TO_SELLER -> REFUNDED` (prepaid) or `-> CLOSED` (COD, nothing to refund) so the state is not a dead end; `RETURN_RECEIVED -> RETURN_INSPECTED` by inspection or by 48h silence auto-approve (spec 22); `RETURN_REJECTED -> DISPUTED` (shopper dispute) or `-> CLOSED`; `DISPUTED -> REFUNDED | CLOSED`; a return can be withdrawn back to `DELIVERED` before pickup. `CLOSE` from `DELIVERED` is guarded by `returnWindowElapsed` (return window plus 3 days). Cancellation is free up to `PACKED` and not declared from `SHIPPED` onward; after shipping the exit is refusal (`DELIVERY_FAIL`) or return, as 20.1 says.
- **OrderGroup**: spec 17 gives the saga, not states. States follow the saga: reserve, payment intent or COD confirmation, paid, then a roll-up of its SellerOrders (`FULFILLING`, `COMPLETED`). The late-payment edge case (reservation expired, payment succeeded) is `EXPIRED -> PAID` guarded by `stockAvailable`, else `-> CANCELLED` with the refund handled by the Refund machine.
- **Shipment**: spec 21 gives the flow and the 3-attempt rule. COD adds `DELIVERED -> COD_REMITTED -> RECONCILED`; prepaid goes straight to `RECONCILED` (guards on `cod`). `LOST` is reachable from any in-flight state. This models the forward leg only; return pickups are tracked by the Return machine.
- **Return**: spec 22 flow. `AUTO_APPROVE` is guarded by `inspectionSlaElapsed`; `REJECT` requires `rejectionPhotosAttached`. `APPROVED` resolves to `REFUNDED` or `EXCHANGED`. A failed pickup returns to `REQUESTED` for re-booking.
- **Refund**: spec 15.6 says refunds are ledger-first. `REQUESTED -> LEDGER_POSTED` happens before any money movement; store credit completes instantly, PSP refunds go through `SUBMITTED`. `FAILED` retries below 3 attempts, then `MANUAL_REVIEW` (bank/wallet transfer by Ops). Once the ledger is posted a refund cannot be cancelled, only completed.
- **Payout**: spec T4 arrows `SCHEDULED -> ON_HOLD -> APPROVED -> SENT -> SETTLED | FAILED`. `APPROVE` requires the approval requirement (dual approval above threshold) and no open dispute; `SEND` requires the IBAN name match. `SCHEDULED -> APPROVED` is allowed (hold is only for risk); `APPROVED -> ON_HOLD` allows a late risk hold. `FAILED -> SCHEDULED` re-queues; `CANCELLED` releases the lines.
- **Subscription**: spec 14 arrows plus `TRIALING -> EXPIRED` (trial ends unpaid), `PAST_DUE -> CANCELLED_AT_PERIOD_END` and `CANCELLED_AT_PERIOD_END -> ACTIVE` (reactivate before period end), and `ACTIVE -> EXPIRED` via `CANCEL_WITH_REFUND` for the default 14-day full-refund policy (VERIFY BEFORE LAUNCH: CPL applicability). `EXPIRED` is terminal; resubscribing creates a new subscription.
- **Drop**: spec 16 states. `EARLY_ACCESS` is optional (`SCHEDULED -> LIVE` allowed). `DRAFT` and `SCHEDULED` can be cancelled straight to `ARCHIVED`. The rule "no price or stock edit after SCHEDULED except stock increase" is a catalog invariant, not a state transition, and is not enforced here.
- **PriceClaim**: spec 9 gives enforcement outcomes, not states. States are the scoring outcomes: `VERIFIED`, `CORRECTED` (claim exceeded VRP, display corrected), `PLAIN_PRICE` (insufficient or stale evidence, fail closed), `APPEALED`, `REVOKED` (enforcement ladder). A price change supersedes the claim (new claim, so `SUPERSEDED` is the terminal), which also guarantees every state can finish.
- **GiftCard**: spec 15.1. `CREATED` splits into a single purchase (`PENDING_PAYMENT`) or a group pot (`POT_OPEN`, which issues only if funded, else cancelled with contributions refunded). Redemption converts the card to store credit, so `REDEEMED` is terminal and partial use happens on the store-credit sub-balance, not on the card. `REDEEM` requires the expiry not reached; `EXPIRE` requires it reached.
- **KYC**: spec 19 arrows. `APPROVE` requires valid documents, clear sanctions screening and a 21+ signatory. Additions: `NEEDS_INFO -> SUBMITTED` (resubmit), `NEEDS_INFO -> REJECTED`, `SUSPENDED -> APPROVED` (reinstate), `SUSPENDED -> TERMINATED`. Human review of a suspension within 5 business days (spec 9.5) is an Ops process, not modelled.
- **Dispute**: spec 22: human T&S review, SLA 5 business days. Resolution requires `decidedByHuman`. `SLA_BREACHED` moves to `ESCALATED`. A resolved dispute is `FINALISE`d to `CLOSED` once the remedy (refund, nothing) has been executed by the owning machine.
- **PriceDropAutoBuy**: spec 28 row 1 (Phase 3). `ARMED -> TRIGGERED` requires a verified price at or below target. Checks (Plus active, within budget, non-BNPL/COD saved token) gate `NOTIFIED`; failure goes `SKIPPED` and can re-arm. The 15-minute cancel window gates `CHARGING`. SCA/3-DS goes via `REQUIRES_USER_ACTION`. One unit only, so `PURCHASED` is terminal. VERIFY BEFORE LAUNCH: PSP support for merchant-initiated transactions.

## Generated transition tables

Generated from the machines themselves (do not edit by hand; regenerate if a machine changes).

### OrderGroup

Initial: `CREATED`. Terminal: `COMPLETED`, `FAILED`, `CANCELLED`.

| From | Event | To | Guard |
|---|---|---|---|
| CREATED | RESERVE | RESERVED |  |
| CREATED | STOCK_UNAVAILABLE | FAILED |  |
| CREATED | CANCEL | CANCELLED |  |
| RESERVED | PAYMENT_INTENT_CREATED | PAYMENT_PENDING |  |
| RESERVED | COD_CONFIRMED | CONFIRMED_COD |  |
| RESERVED | RESERVATION_EXPIRED | EXPIRED |  |
| RESERVED | CANCEL | CANCELLED |  |
| PAYMENT_PENDING | PAYMENT_SUCCEEDED | PAID |  |
| PAYMENT_PENDING | PAYMENT_FAILED | FAILED |  |
| PAYMENT_PENDING | PAYMENT_WINDOW_ELAPSED | EXPIRED |  |
| PAYMENT_PENDING | CANCEL | CANCELLED |  |
| PAID | FULFILMENT_STARTED | FULFILLING |  |
| PAID | ALL_SELLER_ORDERS_CANCELLED | CANCELLED |  |
| CONFIRMED_COD | FULFILMENT_STARTED | FULFILLING |  |
| CONFIRMED_COD | ALL_SELLER_ORDERS_CANCELLED | CANCELLED |  |
| FULFILLING | ALL_SELLER_ORDERS_DONE | COMPLETED |  |
| FULFILLING | ALL_SELLER_ORDERS_CANCELLED | CANCELLED |  |
| EXPIRED | LATE_PAYMENT_CLAIMED | PAID | stockAvailable |
| EXPIRED | LATE_PAYMENT_REFUND | CANCELLED |  |

### SellerOrder

Initial: `PENDING_PAYMENT`. Terminal: `CLOSED`, `REFUNDED`, `CANCELLED`, `REJECTED_BY_SELLER`.

| From | Event | To | Guard |
|---|---|---|---|
| PENDING_PAYMENT | PAYMENT_SUCCEEDED | PAID |  |
| PENDING_PAYMENT | COD_CONFIRMED | CONFIRMED_COD |  |
| PENDING_PAYMENT | PAYMENT_FAILED | CANCELLED |  |
| PENDING_PAYMENT | CANCEL | CANCELLED |  |
| PAID | SELLER_ACCEPT | ACCEPTED |  |
| PAID | SELLER_REJECT | REJECTED_BY_SELLER |  |
| PAID | CANCEL | CANCELLED |  |
| CONFIRMED_COD | SELLER_ACCEPT | ACCEPTED |  |
| CONFIRMED_COD | SELLER_REJECT | REJECTED_BY_SELLER |  |
| CONFIRMED_COD | CANCEL | CANCELLED |  |
| ACCEPTED | SELLER_REJECT | REJECTED_BY_SELLER |  |
| ACCEPTED | PACK | PACKED |  |
| ACCEPTED | CANCEL | CANCELLED |  |
| PACKED | SHIP | SHIPPED |  |
| PACKED | CANCEL | CANCELLED |  |
| SHIPPED | OUT_FOR_DELIVERY | OUT_FOR_DELIVERY |  |
| SHIPPED | DELIVERY_FAIL | DELIVERY_FAILED |  |
| OUT_FOR_DELIVERY | DELIVER | DELIVERED |  |
| OUT_FOR_DELIVERY | DELIVERY_FAIL | DELIVERY_FAILED |  |
| DELIVERED | REQUEST_RETURN | RETURN_REQUESTED |  |
| DELIVERED | OPEN_DISPUTE | DISPUTED |  |
| DELIVERED | CLOSE | CLOSED | returnWindowElapsed |
| RETURN_REQUESTED | CANCEL_RETURN | DELIVERED |  |
| RETURN_REQUESTED | SCHEDULE_PICKUP | RETURN_PICKUP_SCHEDULED |  |
| RETURN_PICKUP_SCHEDULED | CANCEL_RETURN | DELIVERED |  |
| RETURN_PICKUP_SCHEDULED | PICKED_UP | RETURN_IN_TRANSIT |  |
| RETURN_IN_TRANSIT | RECEIVE_RETURN | RETURN_RECEIVED |  |
| RETURN_RECEIVED | INSPECT_COMPLETE | RETURN_INSPECTED |  |
| RETURN_RECEIVED | AUTO_APPROVE | RETURN_INSPECTED |  |
| RETURN_INSPECTED | REJECT_RETURN | RETURN_REJECTED |  |
| RETURN_INSPECTED | REFUND_COMPLETED | REFUNDED |  |
| RETURN_REJECTED | OPEN_DISPUTE | DISPUTED |  |
| RETURN_REJECTED | CLOSE | CLOSED |  |
| DELIVERY_FAILED | RETRY_DELIVERY | OUT_FOR_DELIVERY | deliveryAttemptsLeft |
| DELIVERY_FAILED | RETURN_TO_SELLER | RTO | deliveryAttemptsExhausted |
| RTO | RTO_RECEIVED | RETURNED_TO_SELLER |  |
| RETURNED_TO_SELLER | REFUND_COMPLETED | REFUNDED |  |
| RETURNED_TO_SELLER | CLOSE | CLOSED |  |
| DISPUTED | RESOLVE_FOR_SHOPPER | REFUNDED |  |
| DISPUTED | RESOLVE_FOR_SELLER | CLOSED |  |

### Shipment

Initial: `LABEL_PENDING`. Terminal: `RECONCILED`, `RETURNED_TO_SELLER`, `CANCELLED`, `LOST`.

| From | Event | To | Guard |
|---|---|---|---|
| LABEL_PENDING | CREATE_LABEL | LABEL_CREATED |  |
| LABEL_PENDING | CANCEL | CANCELLED |  |
| LABEL_CREATED | PICK_UP | PICKED_UP |  |
| LABEL_CREATED | CANCEL | CANCELLED |  |
| PICKED_UP | IN_TRANSIT | IN_TRANSIT |  |
| PICKED_UP | MARK_LOST | LOST |  |
| IN_TRANSIT | OUT_FOR_DELIVERY | OUT_FOR_DELIVERY |  |
| IN_TRANSIT | MARK_LOST | LOST |  |
| OUT_FOR_DELIVERY | DELIVER | DELIVERED |  |
| OUT_FOR_DELIVERY | ATTEMPT_FAILED | DELIVERY_ATTEMPT_FAILED |  |
| OUT_FOR_DELIVERY | CUSTOMER_REFUSED | RTO_INITIATED |  |
| OUT_FOR_DELIVERY | MARK_LOST | LOST |  |
| DELIVERY_ATTEMPT_FAILED | RETRY | OUT_FOR_DELIVERY | attemptsLeft |
| DELIVERY_ATTEMPT_FAILED | INITIATE_RTO | RTO_INITIATED | attemptsExhausted |
| DELIVERED | REMIT_COD | COD_REMITTED | isCod |
| DELIVERED | RECONCILE | RECONCILED | isNotCod |
| COD_REMITTED | RECONCILE | RECONCILED |  |
| RTO_INITIATED | RTO_DELIVERED | RETURNED_TO_SELLER |  |
| RTO_INITIATED | MARK_LOST | LOST |  |

### Return

Initial: `REQUESTED`. Terminal: `REFUNDED`, `EXCHANGED`, `CLOSED`, `CANCELLED`.

| From | Event | To | Guard |
|---|---|---|---|
| REQUESTED | SCHEDULE_PICKUP | PICKUP_SCHEDULED |  |
| REQUESTED | CANCEL | CANCELLED |  |
| PICKUP_SCHEDULED | PICKUP_FAILED | REQUESTED |  |
| PICKUP_SCHEDULED | PICK_UP | IN_TRANSIT |  |
| PICKUP_SCHEDULED | CANCEL | CANCELLED |  |
| IN_TRANSIT | RECEIVE | RECEIVED |  |
| RECEIVED | APPROVE | APPROVED |  |
| RECEIVED | AUTO_APPROVE | APPROVED | inspectionSlaElapsed |
| RECEIVED | REJECT | REJECTED | rejectionPhotosAttached |
| APPROVED | COMPLETE_REFUND | REFUNDED |  |
| APPROVED | SHIP_EXCHANGE | EXCHANGED |  |
| REJECTED | OPEN_DISPUTE | DISPUTED |  |
| REJECTED | DISPUTE_WINDOW_ELAPSED | CLOSED |  |
| DISPUTED | UPHOLD_FOR_SHOPPER | APPROVED |  |
| DISPUTED | UPHOLD_FOR_SELLER | CLOSED |  |

### Refund

Initial: `REQUESTED`. Terminal: `COMPLETED`, `CANCELLED`.

| From | Event | To | Guard |
|---|---|---|---|
| REQUESTED | POST_LEDGER | LEDGER_POSTED |  |
| REQUESTED | CANCEL | CANCELLED |  |
| LEDGER_POSTED | CREDIT_ISSUED | COMPLETED |  |
| LEDGER_POSTED | SUBMIT_TO_PSP | SUBMITTED |  |
| SUBMITTED | PSP_CONFIRMED | COMPLETED |  |
| SUBMITTED | PSP_REJECTED | FAILED |  |
| FAILED | RETRY | SUBMITTED | attemptsBelowMax |
| FAILED | ESCALATE | MANUAL_REVIEW | attemptsAtMax |
| MANUAL_REVIEW | RETRY | SUBMITTED |  |
| MANUAL_REVIEW | MANUAL_TRANSFER_CONFIRMED | COMPLETED |  |

### Payout

Initial: `SCHEDULED`. Terminal: `SETTLED`, `CANCELLED`.

| From | Event | To | Guard |
|---|---|---|---|
| SCHEDULED | RISK_HOLD | ON_HOLD |  |
| SCHEDULED | APPROVE | APPROVED | approvalRequirementMetAndNoOpenDispute |
| SCHEDULED | CANCEL | CANCELLED |  |
| ON_HOLD | APPROVE | APPROVED | approvalRequirementMetAndNoOpenDispute |
| ON_HOLD | CANCEL | CANCELLED |  |
| APPROVED | RISK_HOLD | ON_HOLD |  |
| APPROVED | SEND | SENT | ibanNameMatched |
| APPROVED | CANCEL | CANCELLED |  |
| SENT | BANK_CONFIRMED | SETTLED |  |
| SENT | BANK_REJECTED | FAILED |  |
| FAILED | RESCHEDULE | SCHEDULED |  |
| FAILED | CANCEL | CANCELLED |  |

### Subscription

Initial: `TRIALING`. Terminal: `EXPIRED`.

| From | Event | To | Guard |
|---|---|---|---|
| TRIALING | TRIAL_CONVERTED | ACTIVE |  |
| TRIALING | TRIAL_ENDED_UNPAID | EXPIRED |  |
| TRIALING | CANCEL | CANCELLED_AT_PERIOD_END |  |
| ACTIVE | CHARGE_FAILED | PAST_DUE |  |
| ACTIVE | PAUSE | PAUSED |  |
| ACTIVE | CANCEL | CANCELLED_AT_PERIOD_END |  |
| ACTIVE | CANCEL_WITH_REFUND | EXPIRED |  |
| PAST_DUE | CHARGE_SUCCEEDED | ACTIVE |  |
| PAST_DUE | GRACE_ELAPSED | EXPIRED |  |
| PAST_DUE | CANCEL | CANCELLED_AT_PERIOD_END |  |
| PAUSED | RESUME | ACTIVE |  |
| CANCELLED_AT_PERIOD_END | REACTIVATE | ACTIVE |  |
| CANCELLED_AT_PERIOD_END | PERIOD_ENDED | EXPIRED |  |

### Drop

Initial: `DRAFT`. Terminal: `ARCHIVED`.

| From | Event | To | Guard |
|---|---|---|---|
| DRAFT | SCHEDULE | SCHEDULED |  |
| DRAFT | CANCEL | ARCHIVED |  |
| SCHEDULED | OPEN_EARLY_ACCESS | EARLY_ACCESS |  |
| SCHEDULED | GO_LIVE | LIVE |  |
| SCHEDULED | CANCEL | ARCHIVED |  |
| EARLY_ACCESS | GO_LIVE | LIVE |  |
| EARLY_ACCESS | STOCK_EXHAUSTED | SOLD_OUT |  |
| EARLY_ACCESS | WINDOW_CLOSED | ENDED |  |
| LIVE | STOCK_EXHAUSTED | SOLD_OUT |  |
| LIVE | WINDOW_CLOSED | ENDED |  |
| SOLD_OUT | ARCHIVE | ARCHIVED |  |
| ENDED | ARCHIVE | ARCHIVED |  |

### PriceClaim

Initial: `SUBMITTED`. Terminal: `SUPERSEDED`.

| From | Event | To | Guard |
|---|---|---|---|
| SUBMITTED | START_SCORING | SCORING |  |
| SUBMITTED | PRICE_CHANGED | SUPERSEDED |  |
| SCORING | SCORED_VERIFIED | VERIFIED |  |
| SCORING | SCORED_EXCEEDS_VRP | CORRECTED |  |
| SCORING | SCORED_INSUFFICIENT_EVIDENCE | PLAIN_PRICE |  |
| SCORING | PRICE_CHANGED | SUPERSEDED |  |
| VERIFIED | EVIDENCE_STALE | PLAIN_PRICE |  |
| VERIFIED | RESCORE | SCORING |  |
| VERIFIED | ENFORCEMENT_APPLIED | REVOKED |  |
| VERIFIED | PRICE_CHANGED | SUPERSEDED |  |
| CORRECTED | APPEAL | APPEALED |  |
| CORRECTED | RESCORE | SCORING |  |
| CORRECTED | PRICE_CHANGED | SUPERSEDED |  |
| PLAIN_PRICE | EVIDENCE_REFRESHED | SCORING |  |
| PLAIN_PRICE | APPEAL | APPEALED |  |
| PLAIN_PRICE | PRICE_CHANGED | SUPERSEDED |  |
| APPEALED | RESCORE | SCORING |  |
| APPEALED | PRICE_CHANGED | SUPERSEDED |  |
| REVOKED | APPEAL | APPEALED |  |
| REVOKED | PENALTY_ELAPSED | SCORING |  |
| REVOKED | PRICE_CHANGED | SUPERSEDED |  |

### GiftCard

Initial: `CREATED`. Terminal: `REDEEMED`, `EXPIRED`, `VOIDED`, `CANCELLED`.

| From | Event | To | Guard |
|---|---|---|---|
| CREATED | START_CHECKOUT | PENDING_PAYMENT |  |
| CREATED | OPEN_POT | POT_OPEN |  |
| PENDING_PAYMENT | PAYMENT_SUCCEEDED | ISSUED |  |
| PENDING_PAYMENT | PAYMENT_FAILED | CANCELLED |  |
| POT_OPEN | CLOSE_POT | ISSUED | potFunded |
| POT_OPEN | CANCEL_POT | CANCELLED |  |
| ISSUED | DELIVER | DELIVERED |  |
| ISSUED | REDEEM | REDEEMED | expiryNotReached |
| ISSUED | EXPIRE | EXPIRED | expiryReached |
| ISSUED | VOID | VOIDED |  |
| DELIVERED | REDEEM | REDEEMED | expiryNotReached |
| DELIVERED | EXPIRE | EXPIRED | expiryReached |
| DELIVERED | VOID | VOIDED |  |

### KYC

Initial: `DRAFT`. Terminal: `REJECTED`, `TERMINATED`.

| From | Event | To | Guard |
|---|---|---|---|
| DRAFT | SUBMIT | SUBMITTED |  |
| SUBMITTED | START_CHECKS | AUTO_CHECKS |  |
| AUTO_CHECKS | APPROVE | APPROVED | documentsValidSanctionsClearSignatory21 |
| AUTO_CHECKS | REQUEST_INFO | NEEDS_INFO |  |
| AUTO_CHECKS | REJECT | REJECTED |  |
| NEEDS_INFO | REJECT | REJECTED |  |
| NEEDS_INFO | RESUBMIT | SUBMITTED |  |
| APPROVED | SUSPEND | SUSPENDED |  |
| SUSPENDED | REINSTATE | APPROVED |  |
| SUSPENDED | TERMINATE | TERMINATED |  |

### Dispute

Initial: `OPEN`. Terminal: `WITHDRAWN`, `CLOSED`.

| From | Event | To | Guard |
|---|---|---|---|
| OPEN | ASSIGN_REVIEWER | UNDER_REVIEW |  |
| OPEN | WITHDRAW | WITHDRAWN |  |
| UNDER_REVIEW | REQUEST_EVIDENCE | AWAITING_EVIDENCE |  |
| UNDER_REVIEW | SLA_BREACHED | ESCALATED |  |
| UNDER_REVIEW | RESOLVE_FOR_SHOPPER | RESOLVED_FOR_SHOPPER | decidedByHuman |
| UNDER_REVIEW | RESOLVE_FOR_SELLER | RESOLVED_FOR_SELLER | decidedByHuman |
| UNDER_REVIEW | WITHDRAW | WITHDRAWN |  |
| AWAITING_EVIDENCE | EVIDENCE_RECEIVED | UNDER_REVIEW |  |
| AWAITING_EVIDENCE | WITHDRAW | WITHDRAWN |  |
| ESCALATED | RESOLVE_FOR_SHOPPER | RESOLVED_FOR_SHOPPER | decidedByHuman |
| ESCALATED | RESOLVE_FOR_SELLER | RESOLVED_FOR_SELLER | decidedByHuman |
| RESOLVED_FOR_SHOPPER | FINALISE | CLOSED |  |
| RESOLVED_FOR_SELLER | FINALISE | CLOSED |  |

### PriceDropAutoBuy

Initial: `ARMED`. Terminal: `PURCHASED`, `CANCELLED_BY_USER`, `FAILED`, `DISARMED`, `EXPIRED`.

| From | Event | To | Guard |
|---|---|---|---|
| ARMED | PRICE_AT_TARGET | TRIGGERED | verifiedPriceAtOrBelowTarget |
| ARMED | DISARM | DISARMED |  |
| ARMED | OPT_IN_EXPIRED | EXPIRED |  |
| TRIGGERED | CHECKS_PASSED | NOTIFIED | plusActiveWithinBudgetEligibleMethod |
| TRIGGERED | CHECKS_FAILED | SKIPPED | someCheckFailed |
| TRIGGERED | DISARM | DISARMED |  |
| SKIPPED | REARM | ARMED |  |
| SKIPPED | DISARM | DISARMED |  |
| NOTIFIED | CANCEL_WINDOW_ELAPSED | CHARGING | cancelWindowElapsed |
| NOTIFIED | USER_CANCELLED | CANCELLED_BY_USER |  |
| NOTIFIED | DISARM | DISARMED |  |
| CHARGING | CHARGE_SUCCEEDED | PURCHASED |  |
| CHARGING | CHARGE_FAILED | FAILED |  |
| CHARGING | SCA_REQUIRED | REQUIRES_USER_ACTION |  |
| REQUIRES_USER_ACTION | SCA_COMPLETED | CHARGING |  |
| REQUIRES_USER_ACTION | SCA_ABANDONED | FAILED |  |

