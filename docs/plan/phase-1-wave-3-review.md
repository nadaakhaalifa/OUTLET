# Phase 1 wave 3 independent spec review

Date: 2026-10-10. Reviewer: independent spec auditor (read only, no source edited, no tests run; findings come from reading code, tests and docs).
Scope: orders, returns, promotions, fulfillment, search against master prompt sections 4, 17, 19, 20.1, 21, 22, B5.

## Verdict

The pure domain rules are in good shape and the hard limits hold. The weak part is the seams: the courier-confirmed `delivered_at` never reaches orders or returns in production code, return pickups have no caller, and disputes have no resolver route. Wave 3 is a sound set of modules, not yet a working order-to-return flow.

| Check | Result |
|---|---|
| Windows count from `delivered_at`, never order date | PASS in domain and use case. Chain from courier to returns is NOT wired (F-1) |
| No money executed anywhere | PASS. No PSP, ledger, payout, refund call in the five modules. Outputs are outbox events and intents only |
| No fake social proof | PASS in search and promotions. PARTIAL in orders shopper wire (F-8) |
| Arabic present | PARTIAL. Return refusals, promotion titles, search lexicon are Arabic. Order statuses, problem titles and promotion rejection reasons are not (F-5) |
| Authz negative tests on every route | PASS for returns, promotions, fulfillment, search (route-coverage tests plus 401/403/404 matrices). Orders covered by per-route "negative authorization" cases and the central DELEGATED table, no dedicated matrix file (F-14) |
| Adapter parity with in-memory | PARTIAL. Contract suites run on in-memory and Kysely/PGlite for all five. Typesense is a stub with no real client. Ordering and suggest semantics differ (F-11) |

## Ranked findings

### High

**F-1. `delivered_at` has no path from courier to orders or returns.**
- Fulfillment stores `shipments.delivered_at` and emits `shipment.delivered`. No consumer exists.
- `OrderCommands` has accept, pack, reject, cancel, `markShipped` only. There is no OUT_FOR_DELIVERY, DELIVERED, CLOSED, DELIVERY_FAILED or RTO command. `markShipped` has no caller outside tests, so a shipped shipment does not move the seller order to SHIPPED either.
- `orders.delivered_at` is therefore never set. The 14/30 day windows, the 7-day fee rule (all in `returns.ts` from `line.deliveredAtMs`), the 30-day seller buyer-data grace (`buyerAccessOpen`) and payout eligibility (`CLOSED`) cannot start.
- `ReturnableLinePort` has no production adapter (boot fails closed), and nothing states which of the two `delivered_at` columns is authoritative.
- Spec: B5 "All windows count from courier-confirmed delivered_at", 20.1, 21, 22.
- Fix: one `shipment.delivered` consumer in orders that applies DELIVER with the shipment's instant, plus a returns line adapter reading that single column. Add an end-to-end test: webhook delivered, then day 15 changed-mind refused, day 29 defect accepted.

**F-2. Return logistics cannot advance past REQUESTED.**
- `ScheduleReturnPickup`, `RecordReturnPickedUp`, `RecordReturnPickupFailed`, `RecordReturnReceived` are registered but nothing calls them. `CourierPort` has no reverse-shipment operation.
- The inspection clock starts only at RECEIVED, so the 48h silence-approves rule, the refund intent and the exchange intent are unreachable in a running system.
- Spec: 21 "Return pickups are booked automatically for approved returns", 22.
- Fix: reverse shipment in `CourierPort` and Bosta adapter, a consumer of `return.requested`, tracking events mapped to the four bookkeeping use cases.

**F-3. Disputes have no resolver surface.**
- `ResolveReturnDispute` exists as a use case but no admin or T&S route calls it. A shopper dispute reaches DISPUTED and stays there. The 5-business-day human review (spec 22) has no queue, no actor and no authz test.
- Fix: admin route (`return_dispute:update`, dual-control not needed, audit mandatory) and a negative authz test.

### Medium

**F-4. Mutation testing not configured for returns, orders, fulfillment.** A2.10 requires >= 80% on refunds. `allocateRefund` and the return policy sit in `packages/domain/src/returns` with no Stryker config (only promotions has one, 90.29% on Node 25). Add configs and a floor in CI.

**F-5. Arabic coverage gaps for customer-facing strings.**
- Order status labels, shopper cancel reasons, Problem titles (all English: "The order can no longer be cancelled") and promotion `rejected[].reason` (machine codes) have no AR keys. `packages/i18n` has no keys for orders, returns, promotions, search, shipments, so the CI parity check passes vacuously.
- Good: return refusals carry `reason_ar`/`reason_en`; promotion titles require `ar`.
- Spec: A2.15, B5 "Arabic is mandatory".
- Fix: add AR+EN keys for status/problem codes and make the i18n check scan these modules' code lists.

**F-6. Refund intent carries no payment method.**
- `ReturnableLine` has no `paymentType`/`paymentMethod`, and `return.refund_intent` has `refundPreference` only. A BNPL or COD order can record `store_credit` preference at request time. The B3 invariant (BNPL refunds only via provider) is left entirely to the future RefundRouter.
- Fix: add payment method to the line facts and the intent, and refuse or coerce the preference at request time for BNPL.

**F-7. 7-day distance-selling cancellation not honoured as a free return.**
- Spec 20.1 says it is honoured as a free return within 7 days of delivery. `shippingPayerFor` charges the shopper for changed-mind inside days 0 to 7 unless Plus, per spec 22's table. The two spec sections conflict and the conflict is only in VR-07 generically, not in `docs/specs/returns.md`.
- Fix: decide, record in an ADR, and encode as a test. Safest default is the shopper-favourable reading.

**F-8. Orders shopper wire emits invented values.**
- `storeWire` in `orders/adapters/wire.ts` sends `rating_count: 0`, `follower_count: 0`, `live_drop: false`, `is_favorite: false`, `max_verified_discount_pct: null` for any store. Zero followers is a claim, not an absence.
- `shipment: null` and `return_eligible_until: null` are always null, so the shopper never sees tracking or the window end that CPL transparency (B5, spec 5) expects.
- Fix: omit unknown fields or use a minimal store ref; populate `return_eligible_until` from `delivered_at` once F-1 lands.

**F-9. Search live-facts gate is partial.**
- `passesLiveFacets` re-checks price, verified badge, installments, COD, store credit, size, budget. It does not re-check `freeDeliveryEligible` (present in `ProductFacts`), conditions, rating, colors, materials, newArrivals, category or store. They are trusted from the index, which has no producer yet (staleness SLO 60s unmet).
- `total_estimate` is the index total before the gate, so the filter-sheet "live count" is overstated.
- Fix: re-check the facts that exist; compute the count after gating or label it an estimate.

**F-10. Search engine and filter gaps against section 4.**
- Typesense is a stub with no transport, so every request runs on Postgres FTS (`degraded: true`). Nothing hybrid/vector, no typo tolerance outside pg_trgm.
- Missing filters: pattern, fit, occasion, vibe, modest, season, delivery speed, Fulfilled-by-HAUL, ending soon.
- Saved searches accept `alert_enabled` but no runner exists; `last_run_at` is never set.
- Good: Arabic/Franco/Eastern numeral parsing, 30-facet cap, page cap 50, sponsored cap 2 of top 10 and sponsored items pass the same filters, relaxation order, "did you mean".

### Low

**F-11. Adapter parity details.**
- With keywords, Postgres orders by `ts_rank` then `listed_at`; in-memory by `listed_at` only. The contract suite sorts ids, so it cannot see this.
- Suggest: in-memory matches substrings anywhere; Postgres matches word prefixes, ordered by `listed_at`.
- Trigram typo rescue exists only in Postgres. `updated_at` uses `now()` in Postgres and the injected clock in memory.
- Add ordered assertions to the shared contract.

**F-12. Saved-search cap race maps to a 500.** The advisory-locked trigger raises `check_violation`; `kysely-saved-searches.create` does not catch it, so the 51st concurrent insert is not a 422. The use case count check is also non-atomic.

**F-13. PII risk in `search_no_result`.** `normalizedQuery` is free text up to 300 chars and could contain a phone or email. Scrub or hash digit runs and `@` strings before publishing (spec 4 "PII-free").

**F-14. Orders authz tests are per-route cases, not a route-coverage matrix.** Orders lacks the "every controller route is in the matrix" test that returns, fulfillment, promotions and search have. Add one so a new route cannot ship untested.

**F-15. Promotions details.**
- Only 5 of the spec's 12 types are accepted (percent, fixed, bogo, tiered, free shipping). First order, birthday, win-back, payment-partner (as a type), store follower return 422.
- Candidate truncation (top 5 by standalone value) happens before stacking, so an entered code can be dropped as `candidate_limit` while auto promos fill the slots. Greedy pre-filter means "exact over 5" is not globally optimal.
- `ReinstateRedemptions` trusts the caller that the whole order was cancelled before shipping; it verifies nothing.
- Seller can activate its own draft; the dual-approval threshold for platform promotions is noted in the integration report but not enforced or registered.
- Good: seller funding forced to 0% platform, store scope enforced, budget tables not importable (test), property and mutation tests, Cairo-day caps, evaluate uses constant-time service token.

**F-16. Fulfillment details.**
- Courier selection is `DEFAULT_COURIER`; no governorate SLA, cost or p80 ETA (spec 21 rules). Proof of delivery deferred (documented).
- A remittance with zero lines is classified `MATCHED` (`0 === 0`).
- `shipment.cod_remitted` and remittance mismatch are events only (correct); ledger posting stays with F-1 money checkpoint.
- Good: HMAC over raw body before parse, raw-body fail closed, dedup by courier event id, `redelivered` handling so a conflict is not lost, future-clock clamp for `delivered_at`, replay property test.

**F-17. Small items.**
- `returns.ts` uses `deliveredAtMs: line.deliveredAtMs ?? now`; the null case is unreachable (refused as `not_delivered`) and the fallback would mask a broken invariant. Make it an assertion.
- `note` is accepted and dropped on shopper cancel and seller reject.
- Verify register: the seven rows the integration report says to add (24h accept SLA, 48h dispatch SLA, 30-day buyer grace, window counting basis, serial thresholds, promotion dual approval, Bosta specifics) are not in `docs/compliance/verify-register.md` (ends at VR-20 and VR-B4-08).
- Return window uses exact 24h periods; Cairo-day rounding is still open (already a VERIFY note in the returns spec, add a register row).

## Acceptance criteria to named tests

| Spec criterion | Test | Status |
|---|---|---|
| 22: day 15 change of mind refused with reason | `packages/domain/src/returns/policy.test.ts` "day 15 change of mind is refused..."; `returns/test/returns.http.test.ts` "day 15 change of mind is refused with an Arabic and English reason" | Covered |
| 22: defect day 29 accepted | `policy.test.ts` "day 29 defect with a photo is accepted, day 31 is refused"; `returns.http.test.ts` "day 29 defect with a photo is accepted" | Covered |
| 22: inspection 48h silence approves | `returns.http.test.ts` / `repository-contract.ts` sweeper cases (use case `AutoApproveOverdueInspections`) | Covered at use case, no scheduler (F-2) |
| 22: dispute, T&S review | Use-case tests only | Not reachable over HTTP (F-3) |
| 20.1: cancel free before SHIPPED, not after | `orders.http.test.ts` "cancels before shipping, idempotently..." and "cannot cancel once shipped" | Covered |
| 20.1/19: accept within 24h else auto-cancel | `orders.http.test.ts` "after the SLA the answer is 409 accept_window_elapsed and the sweep cancels" | Covered, sweeper not scheduled |
| 19: seller B cannot touch seller A order | `orders.http.test.ts` "another store's order is 404 and byte-identical..." and per-route negative authorization | Covered |
| 21: replaying webhooks twice gives identical state | `fulfillment/test/replay.property.test.ts`, `fulfillment.http.test.ts` | Covered |
| 21: AWB idempotent per shipment | `fulfillment/test/repository-contract.ts`, `bosta-adapter.test.ts` | Covered |
| 17: no combination exceeds caps, no negative totals, idempotent re-evaluation | `packages/domain/src/promotions/evaluate.property.test.ts`, `stacking.test.ts` | Covered, mutation 90.29% |
| 17: budget data never used | `promotions/test/no-budget-import.test.ts` | Covered |
| 17: refund-then-reuse reinstated only on whole-order cancel | `repository-contract.ts` reinstate cases | Covered at repo, caller unverified (F-15) |
| 4: Arabic and English query give equivalent filters; Eastern numerals | `search.test.ts` lines 26 and 102; `search.http.test.ts` lines 43 and 116 | Covered |
| 4: sponsored cap 2 in top 10 | `search.test.ts` capSponsored cases; `search.usecase.test.ts` | Covered |
| 4: facets <= 30, page <= 50 | `search.http.test.ts`, `search.usecase.test.ts` | Covered |
| 4: Typesense down falls back to Postgres | `search.usecase.test.ts`, `typesense.test.ts` | Covered (primary is a stub) |
| 4: no-result relaxation, did-you-mean, `search_no_result` event | `search.usecase.test.ts` | Covered |
| 4: saved-search ownership 404 | `search.authz.test.ts` "another user's saved search" | Covered |
| B5: seller sees buyer data only 30 days after delivery/closure | `packages/domain/src/orders/orders.test.ts`, `orders.http.test.ts` "masks buyer data..." | Covered in domain, unreachable in practice (F-1) |

## What to do next

1. Wire F-1 and F-2 as one task (delivered consumer, reverse shipment, returns line adapter, bookkeeping callers) with the end-to-end test above. This unblocks everything that depends on a real `delivered_at`.
2. F-3 admin dispute route and F-14 orders route-coverage test.
3. F-5, F-6, F-8 before any shopper-facing screen consumes these wires.
4. F-4 mutation configs; add the missing VERIFY rows (F-17).
