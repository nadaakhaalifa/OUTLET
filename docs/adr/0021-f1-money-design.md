# ADR-0021: F-1 money design (ledger posting, funds flow, refunds, payouts)

- Status: **Accepted by owner on 2026-10-11** ("approve F-1 with defaults"); legal confirmation of the funds-flow model stays under VERIFY BEFORE LAUNCH rows 3, 4, 5
- Date: 2026-10-11
- Deciders: Owner, CTO. Review gate: independent Fable-tier money review before merge (global delegation rules)
- Spec refs: B2, B3, T4, 7, 15.2, 15.6, 22. Builds on ADR-0003 (wallet), ADR-0018 (vocabulary), ADR-0019 (mutation policy)

## Decisions (defaults approved)

1. **Seller funds never sit in a Z-OUTLET account.** Collections go through the PSP (Paymob first, behind `PaymentProviderPort`) using its marketplace or sub-merchant product. Z-OUTLET's ledger records allocations only. If the PSP cannot split, payouts are issued by the PSP or bank behind `PayoutPort`, never from a pooled Z-OUTLET balance. Row 4 stays open until the Paymob contract confirms it.
2. **Store credit is closed-loop.** No top-up, no withdrawal, no P2P. Sub-balances: refund_credit, gift_card, cashback_coins, referral_credit, goodwill, with expiries. Spend order: soonest-expiring first, refund credit last.
3. **BNPL refunds go back through the provider only** (cancel or partial cancel). Never to credit or cash. Enforced in `RefundRouter`.
4. **The ledger is the system of record.** Double-entry, bigint piastres, immutable postings, reversing entries for corrections, deferred balance trigger (migrations 0003 and 0011), idempotency key per journal entry.
5. **Ledger-first.** Every money movement posts before or in the same transaction as the state change that causes it. External calls (PSP, payout) are driven by outbox events and their results post as further entries.
6. **Checkout is an orchestrated saga** with the compensations in spec 7. One payment intent per OrderGroup, `Idempotency-Key = order_group_id` at the PSP.
7. **Payouts** follow `SCHEDULED -> ON_HOLD -> APPROVED -> SENT -> SETTLED | FAILED`, eligible only after the line is CLOSED, dual approval above threshold (admin module `approvalCovers`), IBAN name match, weekly cycle.
8. **Reconciliation** is nightly and intraday during events: PSP settlement files, COD remittances, BNPL settlements, ETA, store-credit projections, trial balance and hash chain.

## Options compared (2 lines each)

- **Allocation model.** (a) Z-OUTLET collects everything and pays out from a pooled account: simplest, but it holds seller money and likely needs a licence (B2). (b) PSP marketplace/sub-merchant split with Z-OUTLET as ledger of record: chosen, keeps funds out of Z-OUTLET's balance sheet.
- **Posting trigger.** (a) Post on webhook only. (b) Post a hold at intent creation, then settle on webhook: chosen, because holds make store-credit and COD visible in the trial balance and make compensation a reversal rather than a delete.

## Consequences

- No PSP, BNPL or payout code may be merged without ledger tests (balance property, idempotent replay, reversal symmetry) and a mutation score >= 80% on posting and refund allocation (ADR-0019).
- Paymob is not contracted yet: only fakes and recorded-fixture adapters ship; every endpoint assumption is a VERIFY row.
- Gift-card sales stay behind a kill switch, off by default (ADR-0003).

## Implementation status and known deviations (added 2026-10-11 after the independent money review)

The Fable-tier review (`docs/plan/phase-1-wave-4-money-review.md`) found that two decisions above are **not yet true of the code**. They are recorded here so the ADR does not claim more than exists.

1. **Decision 1 (seller funds never in a Z-OUTLET account) is NOT implemented by the chart (review F-3).** `clearingSettled` lands PSP/COD/BNPL settlements in `bank_settlement:<account>` (a Z-OUTLET asset) and `sellerPayout` leaves it. The ledger therefore models option (a), "Z-OUTLET collects and pays out", which this ADR rejected. There is no account type for a PSP-held sub-merchant balance, so the chosen marketplace-split path cannot be represented or reconciled.
   - **Status:** the aggregator model is the implemented default **pending** the Paymob contract (VERIFY rows 3 and 4, VR-F1-03). No real money, and no persisted beta mirroring a real PSP sandbox, may run on it.
   - **Required before real money:** counsel's answer to rows 3 and 4. If the PSP offers a sub-merchant/split product, add `psp_submerchant_balance:{store}` accounts, route settlement into them, and make payouts PSP transfers; otherwise this ADR must be re-opened with a licensing analysis.
2. **Decision 5 ("same transaction") is realised per module, not globally (review F-10).** Each ledger post currently runs in its own short transaction through `LedgerGateway`. Safety rests on idempotency: every entry key derives from the business id and every state write is keyed/CAS, so replay converges and no value is created or lost on a crash between the two commits. The cost is a window where reconciliation can report transient drift.
   - **Status:** accepted deviation for the synthetic phase.
   - **Target:** `LedgerGateway` accepts the caller's `DbTx` so posting and state change commit together (needs the unit-of-work to expose the transaction handle to the gateway); tracked as a pre-beta item.
3. **Mutation score >= 80% on posting and refund allocation is unproven** (Stryker aborts with `spawn pgrep EAGAIN` on this host). The gate is configured, not met. Run on Node 24 outside the sandbox before the F-1 Fable re-review closes.
