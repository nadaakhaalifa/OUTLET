# Phase 1 wave 4: money re-review (chief reviewer, second pass)

- Date: 2026-10-11 · Reviewer tier: Fable, high effort · Scope: Part A, the fixes for `docs/plan/phase-1-wave-4-money-review.md` (F-1, F-2, F-4, F-5, F-6, F-7, F-8, F-9, F-12, ADV-W4-4, ADV-W4-5); Part B, the Phase 2 modules that touch money or value (`subscriptions`, `gift-cards`, `rewards`, `ads`), their pure domains in `packages/domain` and migrations 0036, 0037, 0041, 0045.
- Method: independent adversarial read of the code and the new tests, then targeted runs. No source was edited. Line numbers are from the working tree at review time.
- Test runs: `apps/api` checkout, store-credit, refunds, composition, payouts, adversarial: 279/280 (one intermittent, R-7). `apps/api` subscriptions, gift-cards, rewards, ads: 312/312. `packages/domain` subscriptions, gift-cards, rewards, ads, refunds, checkout, ledger-posting, reconciliation: 250/250.

## Verdicts

| Module | Verdict | Why |
|---|---|---|
| Checkout saga + store credit (F-1) | **GO**, condition R-2 before beta | Hold TTL follows the method window plus grace; capture is a hard step before the entry is posted and before orders exist; `not_held` re-holds under a fresh id or compensates the whole group; replay and crash points are idempotent. The new path leaks claimed stock on one branch (R-2). |
| Refunds (F-2, F-5, F-6, F-8) | **NO-GO** until R-1 | F-2 is closed and F-6 is closed (one allocator). But the F-8 guard checks a key that checkout never writes, so on the real wiring every refund throws forever (R-1). F-5 is closed for lines, not for the delivery fee (R-3). |
| Payouts (F-7, ADV-W4-5) | **GO**, condition R-5 before any real rail | Approve from a money hold re-checks; send re-checks the balance; the send-versus-cancel race reverses or leaves the entry correctly. One crash window still leaves a live payout entry that cancel never reverses (R-5). |
| Payments (F-9) | **GO** | Ambiguous pending refunds are parked as `unknown_refund` anomalies; `ResolvePendingRefunds` exists. |
| Ledger integrity (F-12) | **GO** | Projection read before and after the snapshot; drift reported only when the ledger matches neither. |
| Reconciliation (ADV-W4-4) | **GO** | `reconcileAcrossFiles` is wired in `run.ts:125`; same (ref, kind, signed gross) across files of one provider is `duplicate_external`, refunds do not trip it. |
| Gift cards | **NO-GO** until B-1 | Codes, HMAC storage, conservation and locking are right. An ambiguous failure after the credit posted reverses the card: value is created (B-1). Pot close can keep a contributor's money (B-3). |
| Plus subscriptions | **GO with conditions** (B-4, B-5) | Charge keys per (sub, cycle, attempt), invoices unique on that triple, trial keys claimed atomically, proration integer with one rounding point, entitlements time based and commerce-only. Two edge paths lose the member's money or mis-key the PSP account. |
| Rewards (coins, tiers, games) | **GO with condition** (B-6) | Issuance idempotent on (kind, source_ref) and ledger key; pending settlement when the ledger is down; clawback proportional, capped, never charged; odds table sums to 1e6 ppm, draw unbiased, no cash outcome at domain or DB level. Clawback is not serialised (B-6). |
| Ads (sponsored products) | **GO** | Winner never pays above its effective bid, the floor, the remaining daily budget or the prepaid balance; bill-time re-check under row locks; jti unique plus advisory lock; postings idempotent per click; budget data unreachable by type, lint and DB CHECK. Two low items (B-8). |

Merge gate for the wave: fix R-1 and B-1 (blockers), then R-2, R-3, R-5, B-3 before any persisted beta on a PSP sandbox. Everything else is a condition or hygiene.

## Part A: verification of the fixes

### F-1 · Closed, with one new branch defect (R-2)

What I verified in code:
- `apps/api/src/modules/checkout/application/saga-runner.ts:305-307` derives the hold TTL as `reservationTtlSeconds(method) + 300 s`; `composition/checkout-adapters.ts:230` passes it; `store-credit/application/credit.ts:188-197` honours a per-hold TTL. `test/credit-capture.test.ts:41-57` asserts 10 min, 30 min and 24 h plus grace.
- `packages/domain/src/checkout/saga.ts:224-231`: `post_ledger` now precedes `place_orders`, and the runner (`saga-runner.ts:239-251`) captures the hold in the same step as the entry under one CAS. `captureOrRehold` (`:314-343`) treats `not_held`/`not_found` as a hard failure: re-hold under `hold:{g}:{seq}`, capture again, else `credit_unavailable` / `late_credit_unavailable` and the group is refunded. The capture outcome is no longer discarded (`checkout-adapters.ts:235-238` returns the typed kind).
- Replay and crash points I walked: crash after capture committed and before the CAS: retry calls `captureHold` with the same `(ref, orderEntryKey)` and gets `captured` back (`kysely-store.ts:254`), the entry posts under its derived key, no double spend. Crash after a re-hold and before the CAS: `placeHold` is idempotent on `(user, ref)` (`:191-193`) and returns the existing hold whether `held` or already `captured`; the adapter maps `exists` to `held` (`checkout-adapters.ts:232`) and the second capture is idempotent. Crash after the ledger post: the key `checkout:{g}:recognised` replays.
- `test/credit-hold-window.test.ts` drives the real harness with the clock advanced past 10 min and the sweeper run before the payment event for card (599 s), wallet (25 min) and wallet (29 min), and asserts lots consumed = `credit_used` = ledger debit. This is the invariant test the first review asked for.

Residual: the sweeper guard `isLive` added to `CreditHolds` (`credit.ts:179`, `:234`) is never wired; `store-credit.module.ts:60` constructs `new CreditHolds(s, i, c)`. With the TTL equal to the window plus grace this is defence in depth only, but the ADV-W4-1 comment claims a protection that is not in force (R-6).

### F-2 · Closed
`refunds/application/entry-codec.ts:5-15` stores the intake id; `fromStoredEntry` reuses it (`:22-31`) and only mints a uuid for legacy rows with `id === ""`. `composition/refunds-ledger.test.ts:76-98` runs intake → process against the real `PostingService` through the production `LedgerGateway`, asserts the posted entry id equals the stored id and that a second `process.execute` appends nothing. Good.

### F-4 · Closed
`composition/money-wiring.ts:149-168`: `RegisteredCommerceTerms` has no default; an unknown store throws `UnknownStoreTermsError`; `register` rejects bps outside 0..10_000. `packages/domain/src/checkout/ledger.ts:17-24` throws `InvalidCheckoutError` for a missing or out-of-range commission at entry build; `saga-runner.ts:429-433` does the same for `placeCommand`. `test/commission-fail-closed.test.ts` exists and passes. No `?? 0` remains on a commission path (the one left at `saga-runner.ts:179` is a quantity map).

### F-5 · Closed for lines, open for the delivery fee (R-3) and for sibling seller orders (R-4)
`intake.ts:96-117` now routes through `planRefundLegs` → `planRefund`, which enforces `refundedBefore + goods <= gross` per line (`refund-allocation.ts:127-129`) with `refundedBefore` including this module's non-cancelled refunds (`intake.ts:101-105`, `kysely-store.ts:216-239`); intake is serialised per seller order by `pg_advisory_xact_lock` and a count-based CAS (`kysely-store.ts:254-261`). ADV-W4-3 covers the second-intent case. Two gaps remain, below.

### F-6 · Closed
`packages/domain/src/refunds/plan.ts:81-107` is the single allocator: it calls `ledger-posting::planRefund` for voucher release, total and the per-tender draw, then labels the draw with the router's channel. The entry is `buildEntry({type: "refund", ...})` so the key is the template's `refund:{refundId}:{storeId}` (`templates.ts:156-157`). It is posted through `PostingService.post` rather than `postCommand`, but `post` uses the same key and payload fingerprint, and `refunds-ledger.test.ts:89-92` proves a replay appends nothing. One allocator, one key: accepted. The old `routeRefund` (`router.ts:103-125`) still exists as an exported helper; nothing in `apps/api` calls it for posting, so it is not a second path, only dead weight.

### F-7 · Closed as specified; residual crash window (R-5)
`payouts/application/commands.ts:296-302` refuses `approve` from `ON_HOLD` with `exceeds_ledger_balance` or `risk_review` unless `moneyHoldReason` passes again; `sendHoldReason` (`:413-423`) re-checks the bank token (a changed token is `risk_review`), the name match and the ledger balance at send. The R5 limitation (natural balance includes not-CLOSED orders) is now documented honestly at `:220-226`.

ADV-W4-5 (send versus cancel): `send` posts the entry (`:390`) then transitions under the version (`:393`); on a lost CAS it leaves the entry only when the winner is another send of the same attempt (owns the same `ledgerRef`) and reverses it otherwise (`:401-409`). Correct for the race. The remaining window is a crash, not a race (R-5).

### F-8 · Implemented as fail-closed, but against the wrong key (R-1)
`process.ts:56-61` refuses to post a refund whose `entry.requires` keys are all absent, and `SweepRefunds` skips such refunds without stalling the rest (`:225-227`). The intent is right; the keys are not (R-1). Separately, no caller of `order_cod_confirmed` or `cod_collected` exists yet (grep: only templates, the recon settle map and the refunds fake), so COD refunds stay impossible until fulfillment posts recognition at `delivered_at`. That is the expected consequence of fail-closed and must stay a blocking item for the COD launch path.

### F-9 · Closed
`payments/application/payments.ts:558-575`: with no provider refund ref, settlement by amount happens only when exactly one pending refund matches; two or more park the event as `unknown_refund` with detail `ambiguous_pending_refund`. `ResolvePendingRefunds` (`:377`) exists to settle by replaying each refund's own key.

### F-12 · Closed
`ledger/application/integrity-job.ts:38-74` reads the projection before and after the ledger snapshot and reports an account as drift only when it matches neither read.

### ADV-W4-4 · Closed
`packages/domain/src/reconciliation/suites.ts:99-125` and its wiring at `apps/api/src/modules/reconciliation/application/run.ts:125`. The first file by settlement id owns the line; later copies are findings; a refund of the same reference has another kind and sign. Spec text at `docs/specs/reconciliation.md:78`.

## Ranked findings

Severity scale as in the first review: **Critical** = money created or lost on a reachable path with no alarm; **High** = money loss or total outage of a money function on a reachable path; **Medium** = wrong amounts, attribution, or a bypassable guard; **Low** = hygiene or latent.

### R-1 · High · Refunds require `order_paid:{g}` but checkout recognises orders under `checkout:{g}:recognised`, so on the real wiring no refund can ever be posted

- `apps/api/src/modules/refunds/application/intake.ts:175` sets `requires = ["order_paid:{orderGroupId}", "order_cod_confirmed:{orderGroupId}"]`.
- `apps/api/src/modules/checkout/application/saga-runner.ts:62` and `:412` post the recognition entry under `keyOf(g, "recognised")` = `checkout:{g}:recognised` (kind `order_recognised`, `packages/domain/src/checkout/ledger.ts:47`). Grep of `apps/api/src` and `packages/domain/src` finds no writer of `order_paid:` other than the `ledger-posting` template, which nothing in the API calls, and the refunds fake (`refunds/adapters/fakes.ts:24`).
- `process.ts:56-61` throws `RefundRecognitionMissingError` when neither key exists; `SweepRefunds` skips it (`:225-227`) and `listActionable` returns it again next pass.

Failing scenario: any prepaid order placed through checkout, delivered, returned; `return.refund_intent` is intaken; every `ProcessRefund.execute` throws; every leg stays `REQUESTED`; the legal 14-day deadline is breached for 100% of refunds. This is F-2's outage again behind a green suite: `composition/refunds-ledger.test.ts:58-71` seeds recognition with `buildEntry({type: "order_paid"})` instead of running checkout, so the test cannot see the mismatch.

Fix (pick one, I prefer the first because it also closes the "one business event, two keys" gap for orders): make checkout post recognition through `PostingService.postCommand({type: "order_paid", ...})` so the key is the template's `order_paid:{g}`, and change `reverse_ledger`, `captureOrRehold`'s `orderEntryKey` and the store-credit reconciler to the same key; or add `checkout:{g}:recognised` to `requires`. Either way add a composition test that runs `PlaceCheckout` → payment event → intake → process on the real ledger.

### R-2 · Medium · Late re-hold failure after a successful claim leaves the units CLAIMED forever (stock leak)

- `saga-runner.ts:239-247`: `post_ledger` runs after `claim` (`saga.ts:225`). When `captureOrRehold` cannot re-hold (`:339-341`) it begins `late_credit_unavailable` compensation; `pendingCompensations` (`saga.ts:134-144`) runs `refund_payment` and `release_reservation`.
- `packages/domain/src/inventory/model.ts:290-297`: `release` is a `noop` unless the reservation is `ACTIVE`; a claimed reservation stays claimed and its units stay `CLAIMED` with no order behind them.

Scenario: wallet checkout with 1,000 EGP of credit; the hold lapses (window elapsed, compensation released it); a late `payment.succeeded` revives the saga; the shopper has meanwhile spent the credit on another order; `claim` returns `claimed_late` (units CLAIMED), the re-hold fails, the external amount is refunded correctly, the saga ends `REFUNDED` with `reservationReleased: true` while the units are still claimed. Money is right; the stock is gone until an operator notices. `test/credit-capture.test.ts:79-98` asserts `activeReservations() === 0` after this path, which a claimed reservation satisfies, so the leak is invisible to the test.

Fix: either re-hold before `claim` on the revive path (the facts know `holdReleased`), or give the inventory port an `unclaim` for a saga that never placed orders and call it in `release_reservation` when `claimed && !ordersPlaced`. Add the assertion "no CLAIMED units without a placed order" to the chaos invariants.

### R-3 · Medium · Refund intake takes the delivery fee from the intent with no cap against the seller order

- `intake.ts:78` reads `deliveryFeeTotal` from the event and `:109` passes it as `shippingGross` to `planRefund`; `RefundFacts` (`refunds/domain/ports.ts:162-181`) carries no shipping amount, so `planRefund` (`refund-allocation.ts:170-179`) bounds it only by the group's remaining tender capacity.

Scenario: multi-store group paid 3,000 EGP by card: store A 1,000 (fee 60), store B 2,000. Two partial return intents for store A's line (each under a new `returnId`, each with `deliveryFeeTotal: 6000`) pass the per-line cap because their goods sum to the line, and each adds the full fee. Store A's refunds draw 1,120 from a tender that paid 1,060 for store A; the extra 60 is store B's money and store A's `seller_payable` is debited for a fee it never charged twice. A returns-module bug or a crafted internal event is enough; nothing in refunds can tell.

Fix: add the seller order's delivery fee and its `feeRefundedBefore` to `RefundFacts`, cap `shippingGross` in `planRefund` (the same way lines are capped), and reject `allocation_inconsistent` when the intent's fee exceeds the cap.

### R-4 · Medium · In-flight refunds of sibling seller orders in one group are not counted against the group's tenders

- `kysely-store.ts:216-239` `committedForSellerOrder` and the advisory lock at `:254` are per seller order; `ports.ts:169-172` delegates refunds of other seller orders to the facts port's `refundedBefore`, and the only facts port is `FakeRefundFacts`.

Effect today: per-line caps bound the goods, so the group cannot be over-refunded on goods alone; with R-3 open, the fee path can cross stores. Once a real `RefundFactsPort` exists it must either include this module's own non-cancelled refunds for every seller order of the group, or intake must lock and count at group level. Record as a hard requirement for I-1, with a test: two concurrent intents on stores A and B of one group whose sum exceeds the remaining tender capacity, exactly one created.

### R-5 · Medium · A crash between the payout posting and the SEND transition, followed by cancel, leaves a live payout entry

- `commands.ts:388-393`: `postPayout` commits in its own unit of work; the `SEND` transition is a separate write. `cancel` (`:330-349`) only releases lines (`release: true`); it never looks for `ledgerPayoutRef(p.id, p.attempts + 1)`.

Scenario: process dies after line 390; the payout is still `APPROVED` with `ledgerRef: null`; finance cancels it (balance concern, bank change); `Dr seller_payable:X 10,000 / Cr bank` stays live, nothing is sent. The seller is under-credited by 10,000 with no alarm from the trial balance or hash chain; only a bank-statement reconciliation suite, which does not exist for payouts, would catch it. If instead the sweeper re-sends first, the key replays and all is well, so the window is operational, not a race.

Fix: `cancel` and `hold` reverse the entry for the next attempt ref when it exists (`reversePayout` is idempotent); or persist `ledgerRef` before posting so the entry is always owned by a row.

### R-6 · Low · The sweeper's live-saga guard is not wired

`store-credit/application/credit.ts:175-180,234` adds `isLive`; `store-credit.module.ts:60` does not pass it. Safe today because the TTL covers the window plus grace and a stuck saga keeps its hold until the TTL, but the ADV-W4-1 comment describes a guard that is not in force. Wire it (a `SagaLiveness` port over the checkout repository) or delete the parameter.

### R-7 · Low · ADV-W4-1 failed once with a 500 in the combined run and passed alone and with the composition directory

`apps/api/src/adversarial.wave4.test.ts:97` saw `/problems/internal-error` on `POST /v1/checkout` in the full run (279/280); two re-runs passed. The harness sets `logger: false`, so the cause was not captured. Treat as intermittent until the body of that 500 is known; a flaky money test is not green.

### Verified sound in Part A (so the next reviewer does not redo it)

- Capture is idempotent on `(user, ref, orderEntryKey)` with a row lock; lots cannot go negative (CHECKs); `credit_used` rows dedupe on `(hold, lot)`.
- `reverse_ledger` no longer invents an original (`saga-runner.ts:353-355`), F-13 closed. `lockCovers` uses the signed lock expiry (F-14 reliability item) at `:298-303`.
- Payout approve keeps requester ≠ approver, exact subject and amount, unexpired (`approvalCovers` unchanged); kill switch before anything is posted; SENT/SETTLED require `approved_by`.
- Payments: `findPendingRefunds` returns candidates and the application decides; webhooks still HMAC over raw bytes with the ±5 min window and `UNIQUE(provider, event_id)`.
- BNPL: provider-only through the real ledger (`refunds-ledger.test.ts:111-123`), `refund_legs_bnpl_provider_only_chk`, router and `destinationFor` both hard-route.
- Closed loop unchanged: no top-up, withdrawal or transfer route.

## Part B: Phase 2 modules (first review)

### B-1 · High · Gift-card redemption reverses the card on any error after the credit may already have posted: value is created

- `gift-cards/application/redeem.ts:108-121`: `creditGiftCard` is called with the idempotency key `gift-card-redemption:{redemptionId}`; the `catch` on **any** throw calls `reverseRedemption`, which restores `remaining` and the pre-redemption status (`adapters/kysely-store.ts:330-341`).

Scenario: a 1,000 EGP card; `creditGiftCard` posts the ledger entry and grants the lot, then the call times out or the connection drops on the way back; the catch reverses the card to 1,000 remaining; the shopper now holds 1,000 of store credit and a card worth 1,000. Redeeming again creates another 1,000 (new redemption id, new key). No invariant catches it: the ledger balances (Dr `gift_card_liability` / Cr `store_credit` is a valid entry), and the card-side conservation (`sum(redemptions) + remaining = amount`) holds because the reversed redemption is excluded.

Fix: never reverse on an ambiguous failure. Leave the redemption `pending`, and resume by re-posting the same key (the ledger and `addLot` are idempotent on it): a `ResumePendingRedemptions` sweeper and a retry on the request path. Reverse only on a definitive, typed rejection from the credit port (card scope refused, user blocked). Also add a test: credit port throws after committing, assert card remaining + credit granted = face value.

### B-2 · Low · Redemption throttle is not atomic and ignores the stored IP hash

`redeem.ts:65-73` reads the failure windows, then `:79-80` records the attempt in a separate transaction; N parallel wrong attempts all pass the 5/h account limit. `ip_hash` is stored (`0037:98-105`) but never throttled on, so rotating accounts and device hashes bypasses both limits. This is survivable only because the code space is 2^100 (`code.ts:11`, 20 Crockford chars, unbiased encoding) and `invalid_code` is returned for format, unknown and wrong alike. Add a per-IP window and record-then-check inside one transaction before any guessable artefact (short codes, pot tokens) is introduced. Entropy, HMAC-with-key-version storage and "code never persisted" are verified.

### B-3 · Medium · Pot close marks a contribution cancelled even when the PSP already captured it, and the overshoot check is unlocked

- `pots.ts:286-289` `voidPending`: `payments.cancel` is `Promise<void>` (`ports.ts:102`), its outcome is ignored and the row becomes `cancelled`. A later `payment.succeeded` for that intent hits `ConfirmContribution` (`:220`) with `status !== "pending"` → `replayed`; the money is kept and never refunded.
- `pots.ts:223-224` reads `paidTotal` without locking the pot; two concurrent contribution webhooks both pass `overshoot === false`; the pot closes funded at the target face value (`:265-266`, the card was created with `amount = target`) and the excess paid contribution is neither on the card nor refunded.

Fix: in `voidPending`, keep `pending` when cancel does not confirm a void, and let `ConfirmContribution` refund a paid-after-cancel contribution (it already has the `refunded_late` path); take the pot row `FOR UPDATE` while deciding overshoot, or decide it inside `updateContribution` with a conditional sum.

### B-4 · Low · Two Plus edge paths lose the member's money

- Late success after the last dunning retry: `sweeper.ts:324` caps `attempt` at 3; the FAILED attempt-3 invoice already exists, so `postCharge` (`shared.ts:163-174`, key `plus:{sub}:cycle:{c}:attempt:3:charged`) posts the cash, then the commit fails on `subscription_invoices_attempt_uq` (`0036:95`) and the handler returns `ignored` (`:345`). The ledger shows the charge; the member stays expired. Use a distinct key and attempt slot for webhook-confirmed charges, or re-use the FAILED invoice row by updating it.
- Refund-if-unused after an upgrade: `manage.ts:252,265-271` refunds `latestPaidInvoice`, which after monthly → yearly is the upgrade invoice (yearly price minus credit). The monthly credit portion that was rolled into it is not refunded, so "full refund within 14 days if no benefit was used" is not full for that member. Policy for VR-P2-01; at least document it.

### B-5 · Low · Plus charges and refunds post to `psp_clearing:unknown` when the invoice has no provider

`shared.ts:170` and `manage.ts:276` use `invoice.provider ?? "unknown"`. A charge always has a provider; a zero-amount upgrade is skipped; but any path that records `provider: null` with a positive amount lands in an account no reconciliation suite reads. Make the provider mandatory on PAID invoices (CHECK) rather than defaulting.

### B-6 · Low · Coin clawback is computed from unlocked reads

`rewards/application/coins.ts:167-188` reads `alreadyClawed`, `expired`, the lot and the live balance without a lock; two `order.refunded` events for one order processed concurrently both compute `effective` from the same `room` and `reversible` from the same `liveCoins`. Their sum can exceed what was earned and the two reversing entries (keys per `refundRef`) can take `store_credit:{user}:cashback_coins` negative until the integrity job reports it. Serialise clawbacks per order (advisory lock on `orderRef`) and recompute under it. Also `triggers.ts:73` truncates `amountPiastres / piastresPerCoin`; harmless at the default 1 piastre per coin, lossy otherwise.

### B-7 · Low · Games: odds integrity holds; "provably fair" is overstated

Verified: `validateOddsTable` requires the ppm to sum to exactly 1,000,000, outcome kinds are `nothing | coins | voucher` at the domain (`games.ts:10,38`) and the DB (`0041:123`); `selectOutcome` maps the roll by cumulative ppm in table order, so the executed distribution equals the disclosure; `rollFromBlocks` is rejection-sampled over 48-bit blocks (no modulo bias); plays per day are enforced by `UNIQUE(user, game, day_key, seq)`; odds versions are immutable, dual-approved and effective only after the lead time. What is not true: the seed hash is written in the same row as the seed at draw time (`games.ts:60-79`) and never committed to the player before the draw, so a dishonest server could re-draw. Not a money defect; change the wording from "provably fair" to "auditable" or publish the seed hash before the play.

### B-8 · Low · Ads: two hygiene items

- `clicks.ts:74-95` reads the dedupe and burst signals outside `billClick`'s transaction; two clicks on two distinct impressions of the same campaign inside the dedupe window both see `validInWindow = 0` and both bill. Bounded by the frequency cap (5 impressions per session per campaign per day), so the exposure is a few floor-priced clicks. Re-check `validInWindow` inside `billClick` under the campaign-day lock.
- `billing.ts:92` hardcodes the PSP as `"ads"`, so top-ups land in `psp_clearing:ads` and the real PSP settlement file cannot match them. Pass the intent's provider.

Verified sound in ads: `auction.ts:144` clamps the price into `[floor, effectiveBid] ∩ [0, remainingCap]` with `cap = min(remainingDaily, balance)`; GSP ≤ first price is property-tested; the price is inside the signed click token (`selection.ts:26-34`) and re-clamped to `maxCpc` at click (`clicks.ts:97`); `billClick` locks the token jti, the campaign-day row and the balance row and refuses `budget_exhausted` / `no_balance` (`kysely-store.ts:459-487`); spend postings are idempotent on the click id with a sweeper for unposted clicks; credit-back excludes the click from the unposted sweep (`:537`); budget data is unreachable by the `TargetingContext` type (`types.ts:82-89`), the dependency-cruiser rule, the module test and the DB CHECK on keywords (`0045:49-50`). The prepaid balance is a seller liability with no withdrawal route.

### B-9 · Integration gap (not a defect)

None of `subscriptions`, `gift-cards`, `rewards`, `ads` is registered in `apps/api/src/app.module.ts`, and each refuses to boot outside `in-memory-dev` without real ports (`*.module.ts`, `NoProductionAdaptersError`, `Missing*PortsError`). The real `StoreCreditPort` for gift cards, `RecurringChargePort` / `PlusRefundPort` for Plus, `LedgerPort` for rewards and ads, and the approval ports do not exist yet. Every GO above is on module logic; the composition review is still owed when they are wired.

### Cross-cutting checks

- **No float on money**: all amounts are `bigint`; `divideRoundHalfEven` is the single rounding point (proration, coins, CTR); `Math.round/floor` appear only on day counts, ppm and binary search indices. `Number()` on money exists only in outbox payloads (`gift-cards/application/shared.ts:79`, `pots.ts:36`, `clicks.ts:103`, `billing.ts:83`), which contradicts the wave-4 convention "amounts as strings" but cannot lose value below 2^53 piastres. Hygiene.
- **No seller-visible budget data**: enforced three ways (above); seller analytics was out of scope here.
- **No cash**: games have no cash kind at any layer; gift cards refuse purchase with store credit, gift card, BNPL or COD (`rules.ts:25-27`) and cannot buy Plus or other cards; wallet wording lint applies to card messages (`purchase.ts:68`).

## Conditions

1. Merge: fix R-1 and B-1, add the two named tests (checkout → refund on the real ledger; credit port throws after commit), explain or fix R-7, then a short re-review of the diff.
2. Before any persisted beta on a PSP sandbox: R-2, R-3, R-5, B-3; wire or delete the `isLive` guard (R-6); R-4 as a stated requirement of the real `RefundFactsPort`.
3. Before real money: F-3 (pooled-funds chart) remains open from the first review and still gates everything; B-4 decided under VR-P2-01; B-5, B-6, B-8 closed or accepted in writing; COD recognition posted by fulfillment before COD refunds are offered.
