# Phase 1 wave 4: independent money review (chief reviewer)

- Date: 2026-10-11 · Reviewer tier: Fable, high effort (global delegation rules) · Scope: ADR-0021 F-1 and the seven money modules of wave 4 (ledger posting, payments, checkout, refunds, store credit, payouts, reconciliation), their pure domains in `packages/domain`, migrations 0003/0011/0031..0035, and the composition layer `apps/api/src/composition` that wires them together.
- Method: adversarial read of every file listed in the task plus every adapter they depend on, looking for the hunt list in the brief (money created or lost, replay double posting, missing reversals, seller funds in a Z-OUTLET account, BNPL cash conversion, closed-loop breaches, webhook forgery/replay/ordering, non-idempotent saga steps, TOCTOU on holds, payout before CLOSED or without dual approval, requester = approver, negative balances, float on money, idempotency-key reuse, tenant leaks, card data or PII at rest or in logs). No source was edited. Line numbers are from the working tree at review time.
- Honest framing: the domain layer (`money.ts`, chart builders, posting templates, the refund and payout machines) is in good shape and well tested. The problems are at the seams: the application-level wiring between checkout, store credit and the ledger, the refunds module against the real posting service, and the funds-flow model the chart encodes. Two findings are blockers for merge; three more must close before any real-money or synthetic-but-persisted beta.

## Verdict per module

| Module | Verdict | Why |
|---|---|---|
| Ledger posting (`ledger`, `ledger-posting`, chart) | **GO** (merge) | Balanced per currency at build time and at COMMIT (deferred trigger), immutable postings, idempotent replay with payload fingerprint, one reversal per entry, hash chain under one advisory lock. Two low items (F-11, F-12). |
| Payments | **GO** (merge) | SAQ A holds (no card fields anywhere, PAN redaction, tokens only); webhooks are HMAC over raw bytes with timestamp window, deduped by `(provider, event_id)` with a separate namespace for unverified rows; state machine mirrored by a DB trigger; refunds capped under row lock. One medium (F-9), one low (F-13). |
| Checkout saga | **NO-GO** until F-1 and F-4 are fixed | F-1 is a real path where a shopper keeps store credit and the goods. F-4 silently zeroes platform commission. The saga itself (idempotent keyed effects, CAS, compensation order) is sound. |
| Store credit | **NO-GO** until F-1 is fixed (shared with checkout) | Closed loop is genuinely enforced (no top-up/withdraw/transfer path, migration test, wording lint). Holds are correct under `FOR UPDATE`. The TTL and the ignored capture outcome are the defect. |
| Refunds | **NO-GO** until F-2 is fixed; F-5 and F-6 before beta | On the real ledger every refund post throws (F-2). BNPL-only-to-provider is enforced three ways and verified. Per-seller-order over-refund is not bounded (F-5). |
| Payouts | **GO with conditions** (F-7 before any send to a real rail) | Eligibility (CLOSED + 3 days, no dispute), dual approval with `approvalCovers` (requester ≠ approver, exact subject and amount, unexpired) and the DB CHECK are correct; lines frozen; ledger-first with reversal on rejection. The ON_HOLD → APPROVED bypass of the ledger-balance and risk holds is the gap. |
| Reconciliation | **GO** (merge) | Read-only on money, deterministic matcher with conservation check, idempotent ingest by checksum, nightly uniqueness in the DB. Nothing in it can move money. Integration gap only (I-3). |

Merge gate for the wave as a whole: fix F-1, F-2 (blockers) and F-4 (one-line fail-closed), add the tests named under each, then re-run this review on the diff. F-3 is a design/legal finding that gates real money, not the merge.

## Ranked findings

Severity scale: **Critical** = money can be created or lost on a reachable path with no alarm that stops it; **High** = money loss/leak or a total outage of a money function on a reachable path; **Medium** = wrong amounts, attribution, or a guard that can be bypassed; **Low** = hygiene, latent, or unreachable today.

### F-1 · High · Checkout + store credit: credit hold expires before the payment window, capture outcome is discarded, shopper keeps the credit and the goods

- `apps/api/src/modules/store-credit/application/credit.ts:28` (`HOLD_TTL_MS = 10 * 60_000`, not parameterised by method) and `:185`; sweeper `:218` releases any hold past its TTL regardless of saga state.
- `apps/api/src/composition/checkout-adapters.ts:224` (hold passes no TTL) and `:231` (`capture` returns `void`, the `not_held` / `not_found` outcome of `kysely-store.ts:252` is dropped).
- `apps/api/src/modules/checkout/application/saga-runner.ts:242-246` sets `holdCaptured: true` whatever capture returned; `packages/domain/src/checkout/saga.ts:224-228` orders the step **after** `post_ledger` and `place_orders`.
- `packages/domain/src/checkout/saga.ts:271` re-holds on revive only when the saga's own facts say `holdReleased`; a release by the sweeper is invisible to the facts.

Failing scenario (deterministic, no race needed): Fawry order 5,000 EGP, shopper applies 1,000 EGP of refund credit. T0: `HOLD_CREDIT` holds 1,000 (TTL 10 min). T0+10 min: `CreditHolds.sweepExpired` releases the hold; the lot is spendable again. T0+2 h: the shopper pays at a Fawry outlet (window 24 h), `payment.succeeded` arrives, `claim` succeeds, `post_ledger` writes `Dr store_credit:user:refund_credit 1,000 / Dr psp_clearing 4,000 / Cr seller_payable ...`, `place_orders` places the order, `capture_credit` gets `not_held` and is ignored, status `PLACED`. Result: the shopper has the goods, the wallet projection still shows 1,000 EGP (lots untouched), the ledger says it was spent. The nightly wallet reconciler reports drift, but nothing recovers the value, and the shopper can spend the same 1,000 on a second order. The same path exists for mobile wallets and InstaPay (30 min window), BNPL (15 min), and for cards whenever the webhook lands in the last seconds of the 10-minute window (reservation and hold expire within seconds of each other; a late success claims stock via `claimed_late` but the hold is gone).

Why the existing tests missed it: the checkout fakes' `capture` is a no-op on a released hold and the kill-point sweep asserts "no held credit" (which a released hold satisfies) rather than "credit consumed equals the ledger debit".

Fix: (a) make the hold TTL follow the reservation window per method (`reservationTtlSeconds`) and have checkout pass it, or drop the TTL and release holds only from saga compensation; (b) return a typed capture outcome and treat `not_held` as a hard failure of the step (re-hold before posting, else compensate the whole group and refund); (c) move `capture_credit` to the same unit of work as `post_ledger` (the spec's own words: "credit double spend (hold, then capture with the ledger entry)"); (d) add an invariant test: after `PLACED`, sum of `credit_used` transactions equals the order entry's `store_credit` debits, run under a clock that advances past the hold TTL before the payment event.

### F-2 · High · Refunds: every refund entry is rejected by the real posting service (non-UUID entry id), so no refund can ever be paid on Postgres

- `apps/api/src/modules/refunds/application/process.ts:56` rebuilds the stored entry with `id = "refund-entry:<uuid>"`.
- `apps/api/src/modules/ledger/application/posting-service.ts:53` throws `InvalidEntryError("entry id must be a lowercase uuid")` for any non-UUID id.
- Wiring: `apps/api/src/composition/money-wiring.ts:349` sends refunds through `LedgerGateway.refunds()` → `PostingService.post`. The refunds module's own tests use `InMemoryRefundLedger` (`adapters/fakes.ts`), which never validates ids, and `composition/money-wiring.test.ts` covers checkout only.

Failing scenario: any `return.refund_intent` is intaken, `ProcessRefund.execute` posts, the gateway throws, the sweeper retries the same refund forever (`listActionable` keeps returning it), every leg stays `REQUESTED`, the legal 14-day deadline is breached for 100% of refunds. Not money creation, but a complete outage of the only money-out path to shoppers, and it ships behind green tests.

Fix: persist the entry id chosen at intake (`intake.ts:106` already generates a UUID but `StoredEntry` drops it) and reuse it in `fromStoredEntry`; add one composition test that runs intake → process against the real `PostingService` on PGlite.

### F-3 · High (compliance, gates real money not merge) · The chart encodes the pooled-funds model that ADR-0021 point 1 forbids

- `packages/domain/src/chart-of-accounts/builders.ts:280-300` (`clearingSettled`: every PSP/COD/BNPL settlement lands gross-less-fee in `bank_settlement:<account>`, a Z-OUTLET asset) and `:303-318` (`sellerPayout`: payouts leave `bank_settlement`).
- `apps/api/src/composition/ledger-gateway.ts` `payouts()` defaults the bank account to `"bank_settlement"`; `apps/api/src/modules/payouts/application/commands.ts:371` posts from `cfg.bankAccount = "payout_main"`.

What this means: the ledger as implemented is exactly "Z-OUTLET collects everything into its own bank account and pays sellers out of it", which is option (a) the ADR rejected (B2 e-money / aggregator licensing). There is no account that models a PSP-held sub-merchant balance, so the "PSP marketplace split" path the ADR chose has no representation and cannot be reconciled. This is not a code defect and the VERIFY rows (3, 4, VR-F1-03) already flag it, but the ADR text claims a property the code does not have. Either add the sub-merchant accounts (`psp_submerchant_balance:{store}`) and route payouts as PSP transfers, or amend ADR-0021 to say the aggregator model is the implemented default pending counsel. Nothing with real money (including a persisted synthetic beta that mirrors a real PSP sandbox) should run before that decision.

### F-4 · Medium (one line, fail-open) · Commission silently defaults to 0 bps

- `apps/api/src/modules/checkout/application/quote.ts:269` (`?? 0`), `packages/domain/src/checkout/ledger.ts:43` (`?? 0`), `apps/api/src/modules/checkout/application/saga-runner.ts:385` (`?? 0`).
- The only source is `apps/api/src/composition/checkout-adapters.ts:46-48` (`DevCommerceTerms`, 15% for every store, explicitly "never production", VR-INT-01).

Failing scenario: the future production `CommerceTermsPort` returns nothing for a store (new store, missing agreement row, map keyed by a different id) → `order_recognised` credits the seller 100% of merchandise, `platform_commission` and `platform_vat_output` get nothing. The entry balances, the trial balance is zero, the hash chain is fine: no integrity alarm will ever fire. Platform revenue leaks per order until someone reads a statement.

Fix: throw `InvalidCheckoutError` when a store's commission is absent (fail closed, like `shippingBeforePromotions` does for missing delivery terms), and reject `commissionBps` outside 0..10_000 in `StoredSchema`.

### F-5 · Medium · Refunds: refunded goods are capped only by the order group's tenders, not by the seller order or line

- `apps/api/src/modules/refunds/application/intake.ts:75-76` checks the intent's arithmetic only; `:102` passes `goodsRefundedBefore` from `RefundFactsPort`; `packages/domain/src/refunds/ledger-entry.ts` and `chart-of-accounts/builders.ts::refundIssued` never see the original merchandise of the seller order or the line.
- Contrast: `packages/domain/src/ledger-posting/refund-allocation.ts:163` (`planRefund`) does enforce `refundedBefore + goods <= line.gross` per line and per-tender capacity, but that template is not the one the refunds module uses (see F-6).

Failing scenario: multi-store group paid 3,000 EGP by card (store A 1,000, store B 2,000). Two `return.refund_intent` events for store A's only line (a returns-module bug, or a legitimate second return request after a rejected first one that the returns module re-publishes under a new `returnId`): both pass `routeRefund` because the group's card tender still has 2,000 of capacity. Store A's `seller_payable` is debited 2,000 for 1,000 of goods, the shopper is refunded 2,000 for store A, and store B's money is used to do it. Concurrently intaken intents for the same seller order also both read the same `goodsRefundedBefore` (no lock), so the cumulative commission differencing double-counts.

Fix: give `RefundFactsPort` the seller order's merchandise and per-line gross/refunded-before, enforce `refundedBefore + item <= gross` per line (reuse `planRefund`'s validation), and take a row lock on the seller order (or the refund facts) while computing the entry.

### F-6 · Medium · Two divergent refund allocation algorithms; the mutation-tested template is dead code

- Production path: `packages/domain/src/refunds/ledger-entry.ts:72` splits each refund's voucher by `platformFundedVoucherBps` with `allocate` (fresh rounding per refund), key `refund:<refundId>`.
- Spec'd path (ledger-posting spec, ADR-0021 mutation requirement): `packages/domain/src/ledger-posting/refund-allocation.ts` (`voucherRelease` telescoping per line, key `refund:<refundId>:<storeId>`), reachable only through `PostingService.postCommand({type: "refund"})`, which nothing in `apps/api/src` calls.

Effect: across partial refunds the platform/seller voucher split can differ by ±1 piastre per refund from the order's original split, so `promo_receivable_seller:{store}` may not return to zero after a full refund (attribution error between platform expense and seller receivable, not money creation). More importantly the spec's guarantee "the template derives the key so two callers cannot post the same business event under different keys" is false for refunds today. Pick one implementation (the ledger-posting one is the better-specified) and delete the other.

### F-7 · Medium · Payouts: a payout held for `exceeds_ledger_balance` or `risk_review` can be approved and sent with no re-check

- `apps/api/src/modules/payouts/application/commands.ts:271` allows `approve` from `ON_HOLD` for any hold reason; `:386-394` (`sendHoldReason`) re-checks bank details and name only; the ledger balance check lives only in `holdReasonFor` (`:217`) at schedule time.

Failing scenario: cycle runs, store X eligible 10,000 EGP, but a refund after a previous payout already took `seller_payable:X` down to 7,000 and the clawback is not yet in `PayoutSourcePort.clawbacks` (or a chargeback was posted directly). Payout is created and held `exceeds_ledger_balance`. A finance user clicks approve (nothing stops it; the UI shows the reason as text), `send` posts `Dr seller_payable:X 10,000` (balance goes to −3,000) and asks the rail to pay 10,000. The seller is overpaid 3,000; recovery depends on future netting of a seller that may never sell again. Also note `payableBalance` is the natural balance including not-yet-CLOSED orders, so the schedule-time check is weaker than R5 reads.

Fix: refuse `approve` while `holdReason ∈ {exceeds_ledger_balance, risk_review}` unless a fresh check passes; repeat the balance check in `send` (the amount is frozen, the balance is not); compare against the balance of CLOSED orders only, or document R5 honestly.

### F-8 · Medium · COD orders are never recognised in the ledger, yet COD refunds debit `seller_payable`

- No caller of `order_cod_confirmed`, `cod_collected`, `psp_settled` or `bnpl_settled` exists in `apps/api/src` (grep confirmed; the templates in `packages/domain/src/ledger-posting/templates.ts` are unused). Checkout deliberately posts nothing for COD (`packages/domain/src/checkout/saga.ts` `defersLedger`).
- `packages/domain/src/refunds/router.ts` and `ledger-entry.ts` route a COD refund to credit (`Cr store_credit`) or courier (`Cr cod_clearing`) and mirror the seller side (`Dr seller_payable`, `Dr platform_commission`, `Dr platform_vat_output`).

Failing scenario (once a real `RefundFactsPort` exists): a COD order is delivered, nothing posts the recognition, the shopper returns it, the refund entry debits `seller_payable:{store}` for value that was never credited. The seller's balance goes negative, the next payout nets it, the seller loses the merchandise value of every refunded COD order; `store_credit` is credited with value that never entered the ledger. Nothing today makes this reachable (facts port is fake-only), but nothing in refunds guards against it either.

Fix: refunds must require the recognition entry (`order_paid:` or `order_cod_confirmed:` for the group) to exist before building the entry, and the fulfillment/delivery flow must post `order_cod_confirmed` at `delivered_at` (plus `cod_collected` on remittance). Track as a blocking item for the COD launch path.

### F-9 · Medium · Payments: pending refund with no provider reference is matched by amount

- `apps/api/src/modules/payments/application/payments.ts:529` falls back to `findPendingRefund(intent.id, ev.amount)` (`kysely-store.ts:454`, "oldest pending with this amount and no ref").

Failing scenario: two refunds of 500 EGP are requested on the same intent (two seller orders of equal value in one group, or two partial returns), both provider calls time out after the PSP accepted them (status `pending`, no ref). The first `refund.succeeded` webhook settles the older refund record, which is right; the first `refund.failed` webhook (for the second refund) is attributed to the *older* record if its succeeded event has not yet arrived. The refunds module's leg then goes `FAILED` and retries with the same idempotency key, which the PSP has already executed. Worst case a shopper is refunded twice at the PSP while our records show one. Low probability, real consequence; the window exists only for timeout-then-webhook flows.

Fix: do not settle by amount when more than one pending refund matches; park as `unknown_refund` anomaly for finance, and resolve pending refunds by polling `retrieve`-style refund lookup by idempotency key (VR-PAY row).

### F-10 · Medium · ADR-0021 point 5 ("same transaction") is not realised anywhere; every money state change and its ledger entry are separate transactions

- `apps/api/src/composition/ledger-gateway.ts:42`: each post is its own `uow.run`. Checkout (`saga-runner.ts:233-246`), refunds (`process.ts`), store credit grants, payouts (`commands.ts:371-384`) all do "post, then write my state" in two commits.

This is survivable because every entry key is derived from the business id (replay returns the same entry) and every state write is CAS/keyed, and I found no sequence where a crash between the two creates or loses value. But: (a) it is not what the ADR and the ledger spec say ("commit or roll back together"); (b) the global chain advisory lock is taken inside the *gateway's* short transaction, not the caller's, so the spec's trade-off analysis ("lock taken after the caller's reads") describes a design that is not in use; (c) the "crash between post and state write" leaves ledger entries whose business row says "not posted" until the next sweep, which the reconciliation suites will report as drift in the meantime (false alarms). Record the deviation in ADR-0021 or restructure the gateway to accept the caller's `DbTx`.

### F-11 · Low · Checkout quote plans store credit from expired lots

- `apps/api/src/composition/credit-balances.ts:8` sums `remaining - held` with no expiry check; `planTender` then reserves that amount; `placeHold` (which does check expiry via `availableOf`) returns `insufficient` → `credit_unavailable` → the whole checkout `FAILED` for any shopper holding an expired, not-yet-swept lot. No money moves; it is a reliability bug on the main checkout path. Use `availableOf(lot, now)`.

### F-12 · Low · Integrity job reads the wallet projection outside the ledger snapshot

- `apps/api/src/modules/ledger/application/integrity-job.ts:38`: `projection.rows()` runs before `withSnapshot`, so a grant or capture between the two reads shows as drift. Report-only, but it will page finance at night under load. Read both inside one REPEATABLE READ transaction or tolerate the in-flight set the way `reconcileProjection` does with `capturedUnposted`.

### F-13 · Low · Checkout `reverse_ledger` can synthesise an original that was never posted

- `apps/api/src/modules/checkout/application/saga-runner.ts:297`: `(await ctx.ledger.find(key)) ?? this.recognitionEntry(rec, nowMs)` then posts its mirror. On Postgres the FK on `reverses_entry_id` rejects it; on the in-memory ledger it is accepted and would *create* value (Cr `psp_clearing`, Dr `seller_payable` with no original). Today the branch is unreachable (compensation cannot start after `post_ledger`: `claim` failure happens before it, `cancel` is refused once claimed, `place_orders` failure parks the saga as stuck), so this is a latent bug. Remove the fallback: a missing original is an error, never an entry to invent.

### F-14 · Low · Minor items, no action needed for merge

- `posting-service.ts`: `IdempotencyKeyTaken` from `append` is not caught (spec says "caught and re-read"). Unreachable under READ COMMITTED plus the advisory lock; it would matter if a caller ever posted under REPEATABLE READ (the re-check after the lock would not see the winner). Document the isolation requirement on `LedgerStore`.
- `hmac-webhook.ts:46`: the timestamp regex accepts 10-digit seconds, which then always fail the ±5 min window in ms. Fails closed; worth a VR-PAY note so a seconds-based PSP is not misdiagnosed as a signature problem.
- `refunds/adapters/kysely-store.ts:277`: `findByProviderRef` is not scoped by provider; refs from two PSPs could collide. Add provider to the lookup.
- `checkout/domain ledger.ts:67,78`: `refund_reserve` is used for late receipts although the chart marks it `reserved`; VERIFY VR-CHK-6 already covers it.
- `saga-runner.ts:286`: the validate step's "lock covers" uses `createdAt + 10 min` rather than the signed lock's own expiry; a retry of `VALIDATE_CART` after 10 minutes can fail an already-reconfirmed checkout with `price_changed`. Reliability only.
- Paymob port sends `Number(amount)` (guarded by `MAX_SAFE_INTEGER`); acceptable for EGP piastres. No other `Number()` on a money value in the money modules or domains.

## Integration gaps (not defects in the reviewed code, but they decide whether "go" means anything)

- I-1 `RefundFactsPort`, `PayoutSourcePort`, `StatementSourcePort`, `SellerBankPort`, `PayoutPort`, `LedgerClearingPort`: fakes only. The modules refuse to boot in production without them (good), but whoever writes the real `RefundFactsPort` inherits F-5 and F-8 and must maintain `refundedBefore` per tender atomically across all seller orders of a group.
- I-2 `PaymentEventsToCheckout` is "not wired: no relay" (`money-wiring.ts`), so in production a successful payment never reaches the saga. The checkout-owned webhook route is correctly dead (the registered provider refuses every body). Until the outbox relay delivers `payment.*` to the bridge, every prepaid checkout sits in `AWAIT_PAYMENT` and expires.
- I-3 Reconciliation's PSP/COD/BNPL suites have no real `LedgerClearingPort`; the trial-balance and store-credit suites do run against the real ledger.
- I-4 `CommerceTermsPort` (commission, tax category) has only the dev fixture (ties to F-4).

## What was hunted and found sound (so the next reviewer does not redo it)

- **Balance per currency**: `createJournalEntry` + deferred trigger `ledger_assert_entry_balanced` at COMMIT; builders reject zero and negative amounts; `allocate` is exact with largest remainder and mirrors negatives symmetrically; one rounding point (`divideRoundHalfEven`), commission and VAT on refunds telescope by cumulative differencing (property-tested).
- **Replay / double posting**: payload fingerprint excludes id and timestamp, includes kind, ref and posting multiset; same key + different payload is a typed conflict that parks the saga (never retried with a changed payload); reversal key is derived, one reversal per entry (DB unique), reversal of a reversal refused.
- **Hash chain**: one `pg_advisory_xact_lock`, re-check after lock, `prev_hash` unique (forks rejected by the DB), verifier checks seq monotonicity and both hashes from a signed start.
- **Seller funds**: no code path pays from a Z-OUTLET balance except the one the chart defines (F-3 is about the chart itself, not a bypass).
- **BNPL**: `routeRefund` ignores preference for BNPL, `refund_legs_bnpl_provider_only_chk` CHECK, domain property test; `planRefund` (ledger-posting) also hard-routes BNPL to the provider.
- **Closed loop**: no top-up, withdrawal or transfer route, table or column; route-absence test; grants only via refund legs, gift-card redemption and platform promos; wording lint.
- **Webhooks**: MAC over raw bytes with timestamp inside the signed material, constant-time compare over every secret, ±5 min window, `UNIQUE(provider, event_id)` with the `unverified:<sha>` namespace enforced by CHECK, store-then-outbox, inbox claim inside the same transaction as the intent mutation (`FOR UPDATE`), stale/duplicate/conflicting events decided by `decideWebhookEffect` with anomalies instead of state moves, DB trigger mirrors the machine and blocks terminal exits.
- **Saga idempotency**: every effect keyed by the OrderGroup (`hold:{g}[:n]`, intent key `{g}`, ledger `checkout:{g}:recognised`, orders `checkout:{g}:place`, refund `checkout:{g}:refund`), CAS on version, compensation steps gated by facts flags so none runs twice; late-payment revival re-holds under a fresh hold id; payment after cancel is refunded, never placed.
- **Holds TOCTOU**: `placeHold` locks the user's lots `FOR UPDATE` before planning, idempotent on `(user, ref)`; capture and release lock the hold row; CHECK `held <= remaining <= granted`.
- **Payouts**: eligibility requires `CLOSED` and `closed_at + 3 d <= cutoff` and no open dispute; one ACTIVE payout per seller order (partial unique index); amount and lines immutable (trigger); `approvalCovers` requires APPROVED, unexpired, exact kind/subject/id, amount as upper bound, and `approverId !== requesterId`, backed by `admin_approval_no_self_chk`; kill switch checked before anything is posted; `SENT/SETTLED` require `approved_by`; ledger entry per attempt with reversal on rejection.
- **Negative balances**: store credit cannot go negative through holds/captures (CHECKs); ledger-side negative `store_credit` is reported by both the integrity job and reconciliation.
- **Tenancy**: refunds, intents, saved cards, sagas and payouts are owner- or store-scoped with RLS plus explicit predicates; foreign ids are 404-indistinguishable; ledger reads need the `finance` role and a passkey session.
- **Card data / PII**: no PAN-shaped column anywhere (migration scan), raw webhook bodies sanitized with Luhn + key rules and flagged as an anomaly if anything was redacted, payloads of every money outbox event are ids, amounts as strings and codes; saga rows hold no address, phone or card data.
- **Float**: all amounts are `bigint` end to end; JSON persistence tags bigints; no `Number()` on a money value except the bounded Paymob adapter.

## Conditions

1. Merge: fix F-1, F-2, F-4; add the three named tests; re-review the diff (Fable tier, short).
2. Before any persisted beta on a PSP sandbox: F-5, F-7, F-8, F-9, and the relay for I-2.
3. Before real money: F-3 decided in ADR-0021 with counsel's answer to VERIFY rows 3 and 4; F-6 and F-10 resolved or formally accepted as deviations.
