# Phase 3 money review: creators and affiliates, price-drop auto-buy (chief reviewer)

- Date: 2026-10-12 · Reviewer tier: Fable, high effort · Read-only review, no source edited.
- Scope A: `packages/domain/src/creators`, the chart-of-accounts extension (`creator_payable`, `creator_commission_expense`, builders `creatorCommissionAccrued` / `creatorCommissionClawedBack` / `creatorPayout`), `apps/api/src/modules/creators`, migrations 0074 to 0077, ADR-0037, `docs/specs/phase-3/creators-affiliates.md`.
- Scope B: `packages/domain/src/auto-buy`, the shared machine `packages/domain/src/state-machine/machines/price-drop-auto-buy.ts`, `apps/api/src/modules/auto-buy`, migration 0056, ADR-0036, `docs/specs/phase-3/price-drop-auto-buy.md`.
- Also checked: the pinned-test changes for the chart extension (`chart-of-accounts/mutation.test.ts`, `packages/db/src/ledger-account-types.test.ts`, `tooling/db/generate-account-types-migration.mjs`).
- Method: independent adversarial read of domain, application, adapters, migrations and tests; targeted greps for wiring (workers registry, production ports, event producers); test runs. Line numbers are from the working tree at review time.
- Test runs (all green): `apps/api` auto-buy + creators 207/207 (9 files, includes the pglite contract suites); `packages/domain` auto-buy, creators, chart-of-accounts, state-machine 424/424; `packages/db` ledger-account-types 7/7.

Severity scale as in the wave 4 reviews: **Blocker** = money created, lost or charged without authority on a reachable path with no alarm; **High** = money loss, double charge, or a bypassable money guard on a reachable path; **Medium** = wrong amounts or attribution, an abuse vector with real payoff, or a guard that fails open; **Low** = hygiene, latent, or product gap.

## Verdicts

| Feature | Verdict | Why |
|---|---|---|
| Creators and affiliates (Scope A) | **Safe to merge dark.** Not safe to enable `kill.creator_program` with real money until A-1, A-2, A-3 are fixed; not safe to enable `kill.creator_payouts` until A-2 and the owner items below are decided. | The money core is right: accrual only on a `CLOSED` line, claim-then-post with a fixed intent amount and a stable key, atomic monthly cap, monotonic pro-rata clawback that can never claw back twice, explicit negative payable, ledger-first payout with reversal on rejection, dual approval as a record. The weak points are at the edges: the public click endpoint is the attribution input and is unauthenticated and under-limited (A-1), the payout send has an orphan-entry window with no recovery job (A-2), the fraud gate fails open when identity is unavailable and a later void never reverses accrued money (A-3). Nothing in production can move money today: composition is `blocked` (`apps/api/src/production/bindings.ts:35-38`), no worker job exists for the module, and the orders/refunds producers do not exist. |
| Price-drop auto-buy (Scope B) | **Safe to merge dark.** Not safe to allow `kill.auto_buy.charge` until B-1 and B-2 are fixed; B-3 before mode B is offered to any real user. | Fail-closed decision in one pure function, unattended charge only for a verified, anomaly-free price with the switch on at trigger time and at claim time, UNIQUE (mandate, price_event) as the idempotency claim, cancel-versus-charge decided by one row lock, mandate immutable at the DB. The new `NOTIFIED --CHECKS_FAILED--> SKIPPED` edge is legal (see B-0). Two real defects remain on the money path: the reconcile step treats "no order yet" as "no order ever" and re-arms the rule (B-1), and the charge amount is bounded by `max_price` only, not by the price the shopper was notified about, so a seller price flap inside the window is a working extraction (B-2). The worker, the checkout hook and the deletion hooks are exported but registered nowhere (B-4), so the switches alone cannot bring the feature up. |
| Chart extension and pinned tests | **OK.** | The two new types are added to the domain table, the pinned descriptor snapshot and the forward migration 0074 consistently; the pinned tests still assert exact equality and byte-identical generation (details under C). |

## Part B first: the machine edge and the auto-buy findings

### B-0 · The new `NOTIFIED --CHECKS_FAILED--> SKIPPED` edge is legal and cannot open an illegal path

- `packages/domain/src/state-machine/machines/price-drop-auto-buy.ts:79-85`: `NOTIFIED` now has `CANCEL_WINDOW_ELAPSED -> CHARGING` (guard `cancelWindowElapsed`), `CHECKS_FAILED -> SKIPPED` (guard `checksFail`, some check false), `USER_CANCELLED`, `DISARM`. `SKIPPED` (`:78`) exits only by `REARM -> ARMED` or `DISARM -> DISARMED`.
- Static analysis is exercised for this machine by `packages/domain/src/state-machine/machine.test.ts:91-97` (no unreachable states, no dead ends, terminals final) and the registry contexts at `:39-45` include every guard flag; `packages/domain/src/auto-buy/auto-buy.test.ts:204` checks every persisted attempt state exists in the machine.
- The attempt layer never calls `REARM`: `packages/domain/src/auto-buy/attempt.ts:38-42` throws if a transition lands on a non-attempt state (`ARMED`, `EXPIRED`), so an attempt row ends in `SKIPPED` and stays there; the rule's own `ARMED` status is untouched. `SKIPPED` is not in `OPEN_ATTEMPT_STATES` (`attempt.ts:25`), so no hold or charge can be pending on it.
- The guard cannot be bypassed by a caller: both application callers pass `otherChecksPassed: false` (`apps/api/src/modules/auto-buy/application/sweep.ts:79` retire, `:160` claim-time skip), and `nextAttemptState` always evaluates the guard. `CHARGING` still has no `USER_CANCELLED` and no `CHECKS_FAILED`, so nothing after the claim can skip or cancel a charge in flight.
- Holds are released on the new edge by both callers (`sweep.ts:86`, `:178`).

Conclusion: no new reachable-but-illegal path; no state that can hold a reservation or a pending charge was added.

### B-1 · High · Reconcile turns "no order yet" into `FAILED` and re-arms the rule, so a late PSP success is an unrecorded charge and a second attempt is possible

- `apps/api/src/modules/auto-buy/domain/ports.ts:105`: `lookup` returns only `placed | not_found`. There is no "in progress" answer, although the port is documented as running the normal checkout saga (`ports.ts:98-103`), which has intermediate states (intent created, awaiting 3-DS or webhook).
- `application/sweep.ts:99-107`: after `chargeUnresolvedMs` (10 min, `packages/domain/src/auto-buy/types.ts:33`) a `CHARGING` attempt whose `lookup` is `not_found` is moved to `FAILED` with `unresolved_no_order`, the hold is released (`:110`), and the shopper is told `not_charged`. The mandate stays `ARMED` (nothing closes it on `FAILED`).
- `sweep.ts:195-199`: a thrown error from `placeOrder` is `psp_unavailable` and goes straight to `fail` (`:228-240`) with no lookup at all. The port comment says a timeout returns `pending` (`ports.ts:96`), but an adapter that throws on a socket timeout after the PSP accepted the authorisation takes this branch.
- `sweep.ts:114-125` (`abandonSca`): `REQUIRES_USER_ACTION` is moved to `FAILED` after 30 min without a `lookup` either. There is no `SCA_COMPLETED` caller anywhere in `apps/api` (grep), so every SCA-required charge ends here.

Failing scenario (mode B, switch on): the MIT saga creates the intent; the PSP takes longer than 10 min to confirm (3-DS challenge completed late, or a slow webhook); the sweep marks the attempt `FAILED`, releases the hold, notifies "not charged". The saga then completes: the shopper is charged and an order exists, while the attempt says `FAILED` and the rule is still `ARMED`. After the 24 h cooldown (`trigger.ts:51`) the next verified price event under target triggers a fresh attempt under a new `price_event_id`, hence a new idempotency key (`types.ts:43`), hence a second charge for a "max 1 unit" mandate. `CloseOnPurchase` would close the rule on the late order, but it is not wired (B-4). The acceptance line "same price event twice, at most one order" holds; "one unit per mandate" does not.

Fix: make `lookup` tri-state (`placed | in_progress | absent`) and only fail an attempt on `absent` or on a terminal saga failure; treat a thrown `placeOrder` as `pending`, never as `failed`; run `lookup` before `abandonSca`; and on any late `placed` outcome for a `FAILED` attempt, mark it `PURCHASED` and close the mandate (the mandate must be closed by the order, not by the attempt). Test that proves it: in `application.test.ts`, fake `placeOrder` returning `pending`, then `lookup` returning `in_progress` for 20 min and `placed` afterwards, assert the attempt ends `PURCHASED`, the mandate `PURCHASED`, and a further price event creates no attempt; a second test where `placeOrder` throws after the fake PSP recorded the key, asserting no `FAILED` and no second `placeCalls`.

### B-2 · Medium · The charge amount is bounded by `max_price` only, so a seller can flap the price inside the 15-minute window and be paid up to the max

- `packages/domain/src/auto-buy/charge.ts:59`: the only price bound at charge time is `price > maxPrice`. `trigger.ts:50` bounds the trigger by `targetPrice`, but `triggerPrice` is stored (`sweep.ts:170` stores `chargePrice`, `evaluate.ts:84` stores `triggerPrice`) and never compared.
- The spec says otherwise: `docs/specs/phase-3/price-drop-auto-buy.md:18` "If the price rose within the pre-charge window the rule stays armed and notifies", and `:46` names seller ping-pong pricing as the abuse to defend against. The pre-charge notice carries no amount (`ports.ts:119`, `kysely-store.ts:123`), so the shopper authorises "target or lower" and is charged whatever the live price is at the claim.

Failing scenario: target 649, max 700, list price 800. The seller (a verified-history seller, so the drop is "verified" under spec 9) drops to 640, the notice goes out, the seller raises to 699 ten minutes later; the claim re-reads 699 (`sweep.ts:255`, `:270`) and charges 699. `priceAnomaly` is the only defence and it depends on the price-integrity batch detecting a 15-minute flap; `evaluateTrigger`'s cooldown does not help because this is one attempt.

Fix: in `decideCharge`, skip with a new reason `price_above_notified` when `price > triggerPrice` (pass `triggerPrice` into `ChargeFacts`), which also implements spec line 18 literally; keep `maxPrice` as the hard ceiling. Test: domain property test that `charge.amount <= min(maxPrice, triggerPrice)`; application test "price 640 at notice, 699 at claim, max 700 -> skipped, rule stays armed, zero MIT calls".

### B-3 · Medium · Account deletion cascades the mandate and attempt rows, destroying the consent evidence for an MIT charge

- `packages/db/migrations/0056_price_drop_auto_buy.sql:44` (`auto_buy_mandates.user_id ... ON DELETE CASCADE`) and `:110-111` (attempts cascade from both mandate and user). The migration header (`:20`) calls this erasure.
- The spec relies on these rows as chargeback evidence (`price-drop-auto-buy.md:46`: "pre-charge notice logs are evidence") and the mandate text is stored immutably precisely so the accepted terms can be shown later (`:27`). Spec 2 keeps financial records pseudonymised under legal retention; a card-network dispute on an MIT charge can arrive months after deletion.

Fix: no cascade; the privacy erasure executor pseudonymises `accepted_device_id` and leaves mandates and attempts that produced an order (`order_group_id IS NOT NULL`) for the financial retention period, deleting only never-charged rules. Test: pglite migration test that deleting a user with a `PURCHASED` attempt is refused (or that the erasure job leaves the row), and that a never-charged `ARMED` rule is removed.

### B-4 · Medium · Nothing registers the evaluator, the sweep, the checkout hook or the deletion/card hooks, and there is no `price.changed` producer

- `apps/api/src/modules/auto-buy/auto-buy.module.ts:164` exports `HANDLE_PRICE_CHANGE`, `RUN_AUTO_BUY_SWEEP`, `CLOSE_ON_PURCHASE`, `CANCEL_ALL_AUTO_BUY`; grep of `apps/api/src` outside the module finds no consumer of any of them. `apps/api/src/workers/registry.ts:47-87` has no auto-buy job. No module emits a `price.changed` outbox event (grep: only checkout's `price_changed` conflict code).
- Consequence: the "dark" claim is true, but the feature cannot be brought up by the two switches alone, and the spec's deletion/card-removal rule (`price-drop-auto-buy.md:24`) is not enforced by anything (mitigated at charge time by `vault.inspect` and eligibility rechecks, `sweep.ts:254-258`, which is why this is Medium and not High).
- `production/bindings.ts:27` marks auto-buy `composed`; given the above it should say what is missing (worker jobs, producer, hooks) the way the creators entry does.

Fix: register `auto-buy.sweep` (every minute, critical) and the price-changed consumer in the registry, call `CLOSE_ON_PURCHASE` from the checkout saga's `place_orders` step, call `CANCEL_ALL_AUTO_BUY` from the privacy deletion executor and the card-token removal path; add a registry test that every exported job token of a `composed` module is registered.

### B-5 · Low · The stock hold expires before the latest moment a charge may still run

- Hold TTL is window + 10 min = 25 min from the reserve at trigger time (`types.ts:45`, `evaluate.ts:129`). The charge is still allowed up to deadline + 30 min grace (`sweep.ts:148`, `types.ts:29`), i.e. 45 min after the notice. Between minute 25 and 45 the `holdKey` passed to the MIT port (`sweep.ts:196`) refers to an expired hold; the saga must re-reserve, which is fine for money but breaks the spec's "reservation placed at the start of the window" promise. Align `noticeGraceMs` with the hold TTL or extend the hold at claim time.

### B-6 · Low · A skipped attempt (dependency outage, notice failure) starts the 24 h cooldown

- `evaluate.ts:72` uses `lastAttemptAt`, which is `max(created_at)` over all attempts including `SKIPPED` (`kysely-store.ts:206-210`). A transient `dependency_unavailable` at trigger time (`evaluate.ts:137-139`) silences the rule for a day. Count only attempts that reached `NOTIFIED`.

### B-7 · Low · The per-user active-rule cap is not serialised

- `create.ts:157-158`: `countArmed` then `insertMandate` inside one transaction without a per-user lock; two concurrent creates for different SKUs both see 4 and both insert. The (user, sku) partial unique index (`0056:72`) does not cover this. Take `pg_advisory_xact_lock(hash(user_id))` or re-count after insert and roll back.

### B-8 · Low · The 15-minute window starts before the notice is durably enqueued or delivered

- `evaluate.ts:148-149` computes `deadline` before `notices.send`; a slow notification queue eats into the shopper's window, and the DB check only enforces `cancel_deadline >= notice_sent_at + 15 min` (`0056:131`) against the same pre-send timestamp. Start the window from the acceptance time, and consider delivery receipts as the start for push.

### B-9 · Low · SCA is modelled but not completable

- `REQUIRES_USER_ACTION` exits only through `SCA_ABANDONED` (`sweep.ts:114-125`); no route or consumer raises `SCA_COMPLETED`. Until VR-P3-01 settles whether MIT after a mandate needs SCA at all, this is acceptable, but combine with B-1: a shopper who completes SCA at the PSP after 30 min is charged with the attempt marked `FAILED`.

What is right in auto-buy and does not need to change: `decideCharge` ordering and fail-closed defaults (`charge.ts:50-67`, `sweep.ts:283-285` on any dependency error); the switch is re-read after the claim (`sweep.ts:185`); mode downgrade to notify-and-confirm for unverified or anomalous prices and when the charge switch is off (`evaluate.ts:76`); mode A attempts can never reach the MIT port (`sweep.ts:143`, `dueAttempts` filters `mode = 'unattended'`); cancel-versus-charge is one `FOR UPDATE` on the attempt row with a state check (`sweep.ts:153-156`, `cancel.ts:43-47`, `kysely-store.ts:166`), and `disarmMandate` locks the open attempts (`kysely-store.ts:233-235`) so a disarm cannot overwrite `CHARGING`; the mandate is immutable at the DB and cannot be reopened (`0056:78-106`); the PSP token reference is never serialised (`auto-buy.controller.ts:56-75`); passkey step-up is enforced (`:104-106`); BOLA is by `(id, user_id)` lookups (`kysely-store.ts:200`, `:224`) with 404 on miss, tested over HTTP.

## Part A: creators and affiliates findings

### A-1 · Medium (High once real money flows) · Click ingest is the attribution input and is unauthenticated, device-spoofable and effectively limited per IP only

- `apps/api/src/modules/creators/adapters/creators.controller.ts:348-363`: `POST /v1/affiliate/clicks` is `@Public()`, takes `device_id` from the body and hashes it unsalted (`:358`). Attribution later matches that hash against the buyer's own device hashes (`application/links.ts:186-201`, `packages/domain/src/creators/attribution.ts:41-62`), last valid click wins.
- The declared `device` rate-limit dimension does not see the body field: `apps/api/src/platform/rate-limit.guard.ts:90-96` reads `x-device-id`, body `device` or `install_id`, or the attest header; the click body uses `device_id`. A caller that omits the header has no device subject, so the only effective limit is `ip` 120/min (`controller.ts:352`). The per-IP hourly "counted" cap (30, `config.ts:35`) is a read-then-insert (`links.ts:141-143`) and only affects `counted`, not storage.
- Nothing binds the click to the device that made it (no attestation, no session, no signed link parameter, although the spec lists "signed link params" and "app token" under Security, `creators-affiliates.md:38`, `:9`).

Abuse: (1) attribution hijack: any party that knows a buyer's device id (it travels in `x-device-id` on every request, through CDN and proxy logs, and is client-generated) can post a later click for creator B and take creator A's commission, or stuff clicks for a whole list of ids under one IP rotation; (2) click flooding: each request writes a click row and an outbox event (`kysely-store.ts:483-490`), 120/min per IP, unbatched, which is an outbox and partition-growth vector with no payoff needed. Exploitability of (1) depends on device-id secrecy, which the platform does not treat as a secret anywhere, hence Medium now and High the day commissions pay out.

Fix: require either an authenticated session (then use the principal's registered device) or an App Attest / Play Integrity token for app clicks, and for web clicks a server-issued, HMAC-signed install token rather than a raw id; fix the rate limiter to read `device_id` (or rename the field) and add a per-device-hash hourly cap at the store; batch the `affiliate.click_recorded` outbox event (one per creator per minute, as the spec says) instead of one per click. Tests: HTTP test that a click with a forged `device_id` for another user's device does not attribute that user's order; rate-limit test that 61 clicks with distinct `device_id` values from one IP without `x-device-id` are limited by the device dimension.

### A-2 · Medium · Payout send posts the ledger entry before the `APPROVED -> SENT` CAS and nothing recovers a lost CAS

- `application/payouts.ts:165` posts `creator_payout` (Dr `creator_payable`, Cr `bank_settlement`), then `:166-175` does the CAS to `SENT`; on `null` it returns `conflict` and leaves the entry. A concurrent `cancel` (`:248-255`, allowed from `APPROVED`) that wins the CAS therefore leaves a live payout entry with no reversal, and the creator's payable is reduced by money that was never sent. A crash between `:165` and `:166` has the same effect.
- Seller payouts have `payouts.recover-orphans` (`apps/api/src/workers/registry.ts:56`); creators have no equivalent and no job at all in the registry.

Fix: mirror the seller payout fix (wave 4 R-5): post the entry and move to `SENT` under one transaction (or CAS first, then post, with a recovery sweep that reverses any `creator_payout:{id}~{attempt}` entry whose payout is not in `SENT|SETTLED` for that attempt). Test: cancel racing send in the in-memory world, assert the ledger shows either no payout entry or a reversal, and `payableBalance` is unchanged.

### A-3 · Medium · The fraud gate fails open when the creator profile is unavailable, and a void after accrual never reverses money

- `application/links.ts:214`: if `identity.profile(creator.userId)` is `null`, the creator side of `decideCreatorFraud` is an empty identity, so same-device, shared-payment and shared-address checks cannot fire; only `self_purchase` by user id survives. An identity outage at order time is a window to attribute what would otherwise be voided. Fail closed: defer attribution (`none` with a retry) when the profile is missing.
- `voidAttribution` exists on the store (`domain/ports.ts:232`, implemented at `kysely-store.ts:557-563`) but has no application caller; `AccrueClosedLine` checks `att.status` only at accrual time (`commissions.ts:143-145`). A ring detected by trust and safety after accrual (or after payout) keeps its money because no path turns a void into a clawback. Add a `VoidAttribution` use case that voids and, for each `ACCRUED|PAID` commission of the order group, writes a full clawback intent through the same `commission_postings` mechanism.
- `MAX_SIBLINGS = 50` (`links.ts:169`, `:207`) limits cluster detection to the creator's 50 most recent buyers; a ring older than that is invisible. Low on its own.

Test: attribution with `identity.profile` returning `null` for the creator asserts `kind: "none"` (or a deferred retry), not `attributed`; void-after-accrual test asserts a clawback entry and `creator_payable` back to zero.

### A-4 · Medium (product and money) · Referral reward and creator commission stack on the same order

- `docs/specs/phase-3/creators-affiliates.md:23` says they are non-stacking ("creator wins"); the implementation note at `:57` says "the referral rules are untouched". Grep of `apps/api/src/modules/referrals/application/referrals.ts:116-182` shows the referral attribution has no knowledge of `attributions`; nothing in creators consults referrals. The platform therefore funds both the 100 EGP referral credit and the commission for one order. Decide and enforce in one place (the order's attribution step), with a test that an order carrying both a referral code and a creator click earns exactly one.

### A-5 · Low · Held-commission release is not atomic against the cap, and an over-cap commission is held forever

- `application/commissions.ts:234-237` checks room, then `kysely-store.ts:707-723` upserts the monthly counter unconditionally (unlike the accrual path `kysely-store.ts:596-603`, which is conditional and correct). A release racing an accrual, or two sweep replicas, can exceed the cap. Use the same conditional upsert in `releaseHeld` and treat zero rows as "still held".
- `claimAccrual` holds any single commission above the cap (`kysely-store.ts:593`) and `ReleaseHeldCommissions` can never release it (`commissions.ts:237` needs `accrued + amount <= cap`). Intentional per the all-or-nothing rule, but there is no alert and no admin path; it should at least emit a finding.

### A-6 · Low · Payout state hygiene

- `approve` from `ON_HOLD` (`payouts.ts:108`) does not re-check the hold reason; `send` re-validates everything (`:147-153`), so money is safe, but an `iban_name_mismatch` hold is one approve away from `APPROVED` again. `send` returning `unavailable` keeps `SENT` with no provider reference and no retry path other than Finance recording an outcome (`:192-193`, `:197-207`); a thrown provider error leaves the same state. Acceptable while payouts are off; add the `advance-sent` style job before they are on.
- Dual approval: threshold 50,000 EGP (`packages/domain/src/admin/approval.ts:93`); below it `not_required`, and the only separation is requester ≠ approver (`payouts.ts:109`). That matches ADR-0021 point 7 but counsel should confirm that creator payouts use the same threshold as seller payouts.

### A-7 · Low · The accepted creator terms are not provably stored

- `creator_terms` exists with an immutability trigger (`0075:21-39`), but `creator_accounts.terms_version` has no foreign key to it (`0075:49`) and `ApplyAsCreator` only compares a number from `TermsPort.currentVersion()` (`accounts.ts:62-68`). Contrast auto-buy, which stores the text row and FKs the mandate to it (`0056:67-68`, `create.ts:150-156`). Add the FK and insert-or-verify the text row at apply time.

### A-8 · Low · DB-level immutability is weaker than the comments claim

- `commission_postings.amount` is described as fixed (`0076:94-98`) but the system role has `UPDATE` on the table (`0076:126`) and there is no column guard trigger; `commissions` has no transition guard either. The application never updates them wrongly today; a trigger that allows only `posted_at` to change on `commission_postings` would make the claim true.

### A-9 · Low · Integration gaps that keep the feature dark (recorded so the verdict is honest)

- No job in `apps/api/src/workers/registry.ts` for `PostCommissionIntents.sweep` (the repair path the design depends on, `commissions.ts:103-115`) or `ReleaseHeldCommissions`; no producer of `LineClosedMessage` / `LineRefundedMessage`; `AttributeOrder` is not called by checkout. `production/bindings.ts:35-38` says so. The dark verdict rests on this.

### A-10 · Low · Admin surface

- `GET /v1/admin/creators` exposes `user_id` (`wire.ts:20-30`) to any console role (`access.ts:41-43`); approval sets `kyc_state = APPROVED` with no recorded automated check (`accounts.ts:151-163`), although spec 19 requires OCR and sanctions screening before approval. Restrict the list to trust and safety and record the check evidence on `creator_kyc.review_reason`.

What is right in creators and does not need to change: commission base excludes voucher and VAT with one half-even rounding (`packages/domain/src/creators/commission.ts:16-27`); accrual only after `CLOSED` and only on the un-refunded part (`commissions.ts:148-151`); the claim transaction holds inbox, unique `(order_line_id, creator_id)`, the conditional monthly counter and the posting intent together (`kysely-store.ts:581-624`); clawback is monotonic on cumulative refunded base, bounded by what is held, and the intent amount is fixed at claim time with a per-commission `seq` under the row lock (`commission.ts:94-108`, `kysely-store.ts:626-669`); the posted entry is idempotent on `creator_commission:{id}:{seq}` and a lost post is repaired by replay (`commissions.ts:67-79`, tested at `test/creators.test.ts:349`); negative payable is explicit and blocks `create` (`payouts.ts:76`) and `send` re-checks the ledger balance (`:150`); payout amount never exceeds the ledger payable or the reserved commissions (`packages/domain/src/creators/payout.ts:8-11`); rejection reverses exactly the attempt's entry (`payouts.ts:225-237`); the commission machine is table-driven with static analysis (`machine.ts`, tested); RLS is owner-read, system-write and verified on pglite; KYC is sealed before the store sees it and never echoed (tested over HTTP).

## Part C: the chart extension and the pinned tests

- `packages/domain/src/chart-of-accounts/accounts.ts:262-283` adds `creator_payable` (liability, credit-normal, owner `shopper`, parameter `creator`) and `creator_commission_expense` (expense, debit-normal, platform); `:330-331` adds the account id builders with `segment("creator", ...)` validation. Builders at `builders.ts:496-553` are balanced two-leg entries with `requirePositive`; the domain tests include a property test that any sequence of accruals, clawbacks, payouts and reversals balances and never claws back more than accrued (`creators.test.ts:247`) and the worked examples 12 to 14 of `docs/specs/ledger-chart-of-accounts.md:144-151`.
- Migration `0074` inserts the two rows with `ON CONFLICT DO NOTHING`, persisted owner `user`, which is the generator's `shopper -> user` mapping (`tooling/db/generate-account-types-migration.mjs:17-20`). `ledger_accounts.type` has an FK to `ledger_account_types` (`0011:52`), so 0074 must run before any creator account is created; it does (numbering).
- `mutation.test.ts:256-282` adds the two descriptors to `EXPECTED_ACCOUNT_TYPES` and `:293-294` still asserts deep equality of the whole table and the exact key order: not weakened.
- `packages/db/src/ledger-account-types.test.ts:14-17` and `:50` now compare the domain table against 0011 plus an explicit list of later seed files, still with exact equality; `:55-61` still asserts 0011 is byte-identical to the generator output, which `POST_0011_TYPES` (`generate-account-types-migration.mjs:22-25`, `:54`) makes possible without rewriting 0011. One asymmetry to note (Low): a type added to a future migration that is not listed in `LATER_SEEDS` is invisible to the test, so the list must be maintained by hand; a one-line test that every `packages/db/migrations/*_ledger_accounts*.sql` after 0011 is in `LATER_SEEDS` would close it.
- No ledger rule forbids a negative liability balance except store credit (`packages/domain/src/ledger-posting/integrity.ts:46-79`), so the "may go negative" design of `creator_payable` does not trip the integrity job. Whether a negative creator payable is acceptable to Finance and counsel is an owner item (below).

## What the owner and counsel must decide (blocking any enablement)

1. VR-P3-01 and VR-P3-02: whether an unattended MIT charge after a stored mandate is supported by the PSP on Egyptian cards and valid under CPL 181/2018; until then `kill.auto_buy.charge` stays blocked and the vault/MIT ports stay Unconfigured.
2. Auto-buy price bound: charge at the notified price (the strict reading of spec rule 18, recommended here) or anywhere up to `max_price`. This is a consumer-fairness and legal-text decision as much as a code fix (B-2).
3. Retention of mandate and attempt rows after account deletion (B-3): counsel to confirm the financial-record basis for keeping MIT consent evidence pseudonymised.
4. VR-P3-03 and VR-P3-04: creator withholding, VAT base for platform-funded commission, the EGP 500k registration threshold, disclosure wording; and whether a creator payable may sit on the ledger and go negative before payouts are licensed (ADR-0037).
5. Commission rates, monthly cap, minimum payout (placeholders in `config.ts:30-41`), cash versus store credit for creators, who signs creator terms.
6. Referral and creator stacking on one order (A-4): one reward or both.
7. Whether creator payouts share the seller dual-approval threshold (50,000 EGP) or need a lower one.
8. Click authentication model (A-1): session-bound clicks only, or attested anonymous clicks with a signed install token; this decides the web-fallback product.

## What I could not verify

- The real PSP MIT adapter, card vault and `lookup` semantics: production binds `Unconfigured` for both (`apps/api/src/production/ports.ts:234-246`); B-1 is argued from the port contract and the saga's known intermediate states, not from a provider.
- How `CreatorIdentityPort.profile` derives `deviceHashes` and `addressHashes` in production (unbound); A-1 assumes the same unsalted SHA-256 of the client device id, which the click route uses.
- The policy rules for the `payout` resource type that `CreatorAdminAccess.finance` relies on (`access.ts:46-53`); the HTTP tests show support cannot move money, which is what matters.
- KMS envelope behaviour and request-logging redaction for the plaintext KYC fields that arrive on `POST /v1/creator/apply` (the fake vault seals, the real one is unbound).
- Lock-order between `disarmMandate` (mandate then attempts) and `markPurchased` (attempt then mandate): a deadlock is possible and would be detected by Postgres, after which the loser's caller gets an error; reconcile repairs a lost `markPurchased`, a lost cancel returns an error to the shopper. Not tested on Postgres; Low.
- Whether the OpenFeature registry really defaults `kill.price_drop_auto_buy`, `kill.auto_buy.charge`, `kill.creator_program` and `kill.creator_payouts` to blocked in production (`production/flags.ts:78` maps the keys; the provider is Unconfigured here and the fakes default to off).


## Follow-up status (Odoo channel, auto-buy composition, SCA route, ops queue, click authentication)

- **A-1 (click authentication): addressed in code.** `POST /v1/affiliate/install-tokens` (authenticated) mints a 15 minute HMAC token bound to one keyed device hash; `POST /v1/affiliate/clicks` accepts it in `X-Install-Token`. A click without a valid token is stored and counted under a domain-separated hash that can never equal a buyer's device hash, so it is never eligible for attribution. Tests: forged, truncated, expired, replayed on another device, and the hijack scenario from this review. Residual risk: a live session that knows another device's id can still mint a token for it; App Attest / Play Integrity on the issuing route would close it (`attestation.app-attest` is Unconfigured in production). Not done from this finding: the per-device-hash hourly cap at the store and the rate-limiter dimension that still does not read `device_id` from the body (the header is preferred).
- **Auto-buy gaps closed:** SCA completion route (`POST /v1/me/auto-buy/attempts/:id/sca-complete`, owner scoped, idempotent, outcome established by PSP lookup) and the MANUAL_REVIEW ops queue (`GET /v1/admin/auto-buy/manual-review`, `POST .../:id/resolve`; ops, finance, super admin; audit before action; refused when the PSP lookup contradicts the operator). Cross-module ports now bound to real modules: Plus entitlement, live quote, deliverability, budget gate. Still Unconfigured: risk (no fraud module), inventory hold, merchant-initiated charge, card vault, the age policy port.
- **Odoo channel:** composed in production with real store, directory, SKU resolver, stock and price sinks and `ProxiedOdooEgress`; its own switch `kill.odoo_channel`. The egress proxy transport, DNS and vault read remain Unconfigured.
