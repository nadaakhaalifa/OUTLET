# Spec: Ledger chart of accounts and worked journal entries

Phase 0 · Spec refs: §T4, §15, §20, §B2, §B3, §B4 · Status: Draft for review · Code: `packages/domain/src/chart-of-accounts/`

All amounts are piastres (100 = 1 EGP). Every figure below is a **development fixture** used by the executable tests in `worked-examples.test.ts`. None is a price, a commission rate, a fee or a provider term. Anything tagged **VERIFY BEFORE LAUNCH** is an accounting or legal treatment nobody has confirmed.

## Flow
1. A business event (order recognised, refund issued, settlement, payout, gift card, grant, Plus charge) calls one typed builder in `builders.ts`.
2. The builder computes components, rounds at the single `divideRoundHalfEven` point, and returns a `JournalEntry` through `createJournalEntry`, so an unbalanced entry cannot exist.
3. The persistence adapter (later) supplies `id`, `idempotencyKey`, `occurredAt` and `ref` through `EntryMeta`. Builders read no clock and generate no ids.
4. Balances are derived with `derivedBalance(account, entries)`, which returns the balance in the account's natural sign (a liability that is owed is positive).

Sign convention is that of `ledger.ts`: a positive posting is a debit and a negative posting is a credit.

## Rules

### R1. Chart of accounts
| Account id | Category | Normal | Owner | Lifecycle (short) | Reconciled against |
|---|---|---|---|---|---|
| `psp_clearing:{psp}` | Asset | Debit | PSP | Per PSP, never closed. Debited at capture, credited at settlement. | PSP settlement files |
| `cod_clearing:{courier}` | Asset | Debit | Courier | Debited at delivery, credited at remittance. Aging above 3 days escalates. | Courier remittance reports |
| `bnpl_clearing:{provider}` | Asset | Debit | BNPL provider | Debited at approval, credited at settlement or loan cancellation. | Provider statements |
| `bank_settlement:{account}` * | Asset | Debit | Bank | Per bank account used. | Bank statements |
| `seller_payable:{store}` | Liability | Credit | Seller | Credited per order net of commission and VAT on commission. Debited by payouts, refunds, netting. May go negative (seller owes us). | Payout batches |
| `store_credit:{user}:{sub}` | Liability | Credit | Shopper | One per sub-balance. Never negative. | Cached wallet projection (nightly) |
| `gift_card_liability` | Liability | Credit | Platform | Credited at sale, debited at redemption. | Gift-card table |
| `refund_reserve` | Liability | Credit | Platform | **Reserved.** No builder posts to it. Stays zero until a spec defines its use. | n/a |
| `deferred_plus_revenue` | Liability | Credit | Platform | Credited at charge net of VAT, debited per period. Zero after the last period. | Subscription schedule |
| `platform_vat_output` | Liability | Credit | Platform | Credited on each taxable supply by Z-OUTLET. Cleared by the VAT return (outside this ledger for now). | ETA submissions |
| `platform_commission` | Revenue | Credit | Platform | Credited per order, debited on refunds. | Seller invoices |
| `shipping_revenue` | Revenue | Credit | Platform | Credited with the order, debited when a fee is refunded. | n/a |
| `plus_revenue` | Revenue | Credit | Platform | Credited from deferred revenue once per period. | n/a |
| `promo_expense_platform` | Expense | Debit | Platform | Debited for platform-funded vouchers and credit grants. Credited on expiry or refund of the discounted line. | Promotions engine |
| `promo_receivable_seller:{store}` | Asset | Debit | Seller | Debited when a seller-funded discount is applied, credited when netted from the payable. | Promotions engine |
| `provider_fee_expense` * | Expense | Debit | Platform | Debited at PSP and BNPL settlement. | Settlement files |
| `courier_fee_expense` * | Expense | Debit | Platform | Debited at COD remittance. | Courier contract |
| `creator_payable:{creator}` * | Liability | Credit | Shopper (creator user id) | Credited when a commission accrues after delivery and the return window, debited by a payout or a clawback. **May go negative** after a clawback of an already paid commission; reported as "owes platform" and netted from the next payout. | Commissions table and creator payouts |
| `creator_commission_expense` * | Expense | Debit | Platform | Debited at accrual, credited by a clawback. | Commissions table |

\* Not in §T4. Added so that settlement, remittance and payout have a counter-account. `promo_receivable_seller` is parameterised by store here, while §T4 lists it without a parameter, so that netting is per seller. Both are decisions for the owner (see Open items).

`ACCOUNT_TYPES` in `accounts.ts` holds this table as data (with purpose, lifecycle, status and VERIFY notes), and a test asserts it covers every §T4 account.

### R2. Store-credit sub-balances (§15.2)
`refund_credit` (no expiry), `gift_card:{cardId}`, `cashback_coins` (12 months), `referral_credit` (6 months), `goodwill` (90 days). Account id: `store_credit:{userId}:{sub}`.
- `refund_credit` is posted only by `refundIssued`. `gift_card:*` only by `giftCardRedeemed`. The other three only by `storeCreditGranted` (the type system enforces this).
- Spend order (`planStoreCreditSpend`): soonest-expiring first, then non-expiring, with `refund_credit` last. Ties break on the sub-balance key. A short balance throws `InsufficientCreditError`.
- Expiry (`storeCreditExpired`) is supported for the three promo sub-balances only. Gift-card breakage is deliberately not built (VERIFY).

### R3. Order recognition
Per seller order, with `commission = percentOfBps(merchandise, commissionBps)` and `commissionVat = percentOfBps(commission, vatBps)`:
- Cr `seller_payable` = merchandise − commission − commissionVat.
- Cr `platform_commission` = commission. Cr `platform_vat_output` = commissionVat.
- Shipping (a supply by Z-OUTLET, VAT-inclusive): VAT = gross × vatBps / (10,000 + vatBps), net = gross − VAT. Cr `shipping_revenue` net, Cr `platform_vat_output` VAT.
- Platform-funded discount: Dr `promo_expense_platform`. Seller-funded discount: Dr `promo_receivable_seller:{store}`. Neither changes what the seller is owed.
- Debit side is the tenders: `psp_clearing`, `cod_clearing`, `bnpl_clearing`, or `store_credit` sub-balances. Tenders must equal merchandise + shipping − discounts, otherwise `TenderMismatchError`.
- Commission base is merchandise after item-level discounts and before vouchers, VAT-inclusive (matches the free-delivery threshold base in §6). **VERIFY BEFORE LAUNCH.**
- Marketplace-agent model assumed: the seller is the supplier of goods and issues the shopper e-receipt, so Z-OUTLET books VAT only on its own supplies (open question 10).

### R4. Refunds
A refund is the mirror of the order components for the refunded portion, paid to one or more destinations (original PSP, `store_credit` sub-balance, BNPL provider).
- Commission and its VAT are computed on **cumulative** refunded value and differenced, so any sequence of partial refunds sums to exactly the original commission and VAT (property tested).
- The caller allocates the voucher share that goes with the refunded goods.
- BNPL refunds go to `bnpl_clearing` (provider cancellation, §B3). Routing is the RefundRouter's job and is not enforced here.
- Returning commission and VAT to the seller on refund, and reversing a platform-funded discount (the voucher is not re-issued), are assumptions. **VERIFY BEFORE LAUNCH.**

### R5. Settlement, payout, netting
- `clearingSettled`: Dr bank (gross − fee), Dr fee expense, Cr clearing. Fee account is `courier_fee_expense` for COD, `provider_fee_expense` otherwise.
- `sellerPayout`: Dr `seller_payable`, Cr `bank_settlement`. A failed payout is a `reverseEntry`.
- `sellerPromoNetted`: Dr `seller_payable`, Cr `promo_receivable_seller`.

### R7. Creator commission (spec P3-04, ADR-0037)
Added by migration 0074 (a forward INSERT into `ledger_account_types`; 0011 is generated and never rewritten). Both accounts are NOT in §T4.
- `creatorCommissionAccrued`: Dr `creator_commission_expense`, Cr `creator_payable:{creator}`. Only after the line is `CLOSED` (delivered, return window over) on the part not refunded by then.
- `creatorCommissionClawedBack`: Dr `creator_payable`, Cr `creator_commission_expense`. Pro rata and cumulative: the clawback is `held - commission(base - refundedBase)`, so a replayed or out-of-order refund message claws back nothing twice.
- `creatorPayout`: Dr `creator_payable`, Cr `bank_settlement`. A rejected payout is a `reverseEntry`. Payouts are engaged OFF (`kill.creator_payouts` blocked, provider Unconfigured).
- Commission base is the line gross minus the voucher-funded value, minus the VAT contained in it. Shipping, gift cards, Plus fees and store-credit top-ups are never in the base. VAT treatment of platform-funded commission is **VERIFY BEFORE LAUNCH (VR-P3-03)**.
- Idempotency keys: `creator_commission:{commissionId}:{seq}` (seq 0 accrual, 1.. clawbacks, fixed in `commission_postings` in the claim transaction) and `creator_payout:{payoutId}~{attempt}`.

### R6. Gift cards and Plus
- `giftCardSold`: Dr tender, Cr `gift_card_liability`. No VAT at sale (assumed due at redemption). Refuses store credit and COD as tender. **VERIFY BEFORE LAUNCH.**
- `giftCardRedeemed`: Dr `gift_card_liability`, Cr `store_credit:{user}:gift_card:{cardId}`.
- `plusCharged`: Dr tender, Cr `deferred_plus_revenue` net, Cr `platform_vat_output` VAT. VAT is booked at charge (assumption, **VERIFY BEFORE LAUNCH**). Refuses store credit and COD as tender (§15.1).
- `planPlusRecognition(net, periods)` splits the net exactly (largest remainder, earlier periods get the extra piastre). `plusRevenueRecognised` posts one period.

## Worked examples
Each is an executable test in `worked-examples.test.ts`. VAT is 14% (1,400 bps), commission 15% (1,500 bps) unless stated. All entries balance to zero and the global trial balance is zero.

### 1. Order paid, prepaid, two sellers
Seller A merchandise 159,950, seller B 60,025, shipping 5,000 gross. Shopper pays 224,975 by card.

| Account | Dr | Cr | Working |
|---|---:|---:|---|
| `psp_clearing:psp1` | 224,975 | | 159,950 + 60,025 + 5,000 |
| `seller_payable:A` | | 132,599 | 159,950 − 23,992 − 3,359 |
| `seller_payable:B` | | 49,760 | 60,025 − 9,004 − 1,261 |
| `platform_commission` | | 32,996 | 23,992 (159,950 × 15% = 23,992.5, half-even) + 9,004 (9,003.75) |
| `platform_vat_output` | | 5,234 | 3,359 + 1,261 + 614 (shipping 5,000 × 14/114 = 614.03) |
| `shipping_revenue` | | 4,386 | 5,000 − 614 |

### 2. COD order and courier remittance
Same order, tender `cod_clearing:courier1`, posted **at delivery**. Nothing is posted at placement (a COD order is not money). Remittance of 224,975 with a 2,500 courier fee: Dr `bank_settlement:main` 222,475, Dr `courier_fee_expense` 2,500, Cr `cod_clearing:courier1` 224,975. Result: `cod_clearing` 0, seller payables as in example 1.

### 3. Partial refund to card
Refund 50,000 of seller A's goods to the card: commission 7,500, VAT 1,050.

| Account | Dr | Cr |
|---|---:|---:|
| `seller_payable:A` | 41,450 | |
| `platform_commission` | 7,500 | |
| `platform_vat_output` | 1,050 | |
| `psp_clearing:psp1` | | 50,000 |

Refunding the remaining 109,950 afterwards takes `seller_payable:A` to 0 and leaves exactly B's 9,004 commission and 1,261 + 614 VAT.

### 4. Refund to store credit
COD order, seller B's goods 60,025 plus the 5,000 shipping returned to `store_credit:u1:refund_credit` 65,025. Seller B payable, shipping revenue and VAT on shipping return to zero. The COD receivable is untouched.

### 5. Gift card sale and redemption
Sale 100,000: Dr `psp_clearing` / Cr `gift_card_liability`. Redemption: Dr `gift_card_liability` / Cr `store_credit:u2:gift_card:gc1`. No VAT either side (VERIFY).

### 6. Order paid with store credit across sub-balances
User u1 holds goodwill 2,000 (expires 2026-12-01), referral 5,000 (2027-01-15), coins 3,000 (2027-03-01), gift card gc1 10,000 (2029), refund credit 30,000. A 12,000 order (10% commission) is planned as goodwill 2,000, referral 5,000, coins 3,000, gift card 2,000. `refund_credit` stays 30,000, gift card ends at 8,000, seller C is owed 12,000 − 1,200 − 168 = 10,632.

### 7. Seller payout
PSP settles 224,975 less 3,000 fee. Payout of 132,599 to A. Result: `psp_clearing` 0, `seller_payable:A` 0, `seller_payable:B` 49,760, bank 89,376.

### 8. BNPL order and settlement
Tender `bnpl_clearing:lender1` 224,975. A 50,000 partial refund goes back to `bnpl_clearing` (not store credit). Settlement of 174,975 with a 4,500 fee: bank 170,475, `provider_fee_expense` 4,500, `bnpl_clearing` 0.

### 9. Plus subscription
12-month term, 114,000 gross: Dr `psp_clearing` 114,000, Cr `deferred_plus_revenue` 100,000, Cr `platform_vat_output` 14,000. Recognition over 12 periods is 4 × 8,334 and 8 × 8,333. After 3 periods: `plus_revenue` 25,002, `deferred_plus_revenue` 74,998. After 12: 100,000 and 0.

### 10. Voucher funded by platform versus seller
Seller D merchandise 100,000, voucher 10,000, shopper pays 90,000.
- **Platform-funded:** Dr psp 90,000, Dr `promo_expense_platform` 10,000. Seller owed 82,900. Refund of the line reverses the expense.
- **Seller-funded:** Dr psp 90,000, Dr `promo_receivable_seller:D` 10,000. Seller owed 82,900, then netting leaves 72,900 and the receivable at 0.

A cart-level voucher is split across seller orders by `allocateVoucher` (largest remainder).

### 11. Reversal
`reverseEntry` on example 1 negates every posting and references the original. Every affected account nets to 0 and the trial balance stays 0.

### 12. Creator commission accrues
A 1,140.00 EGP line (114,000 gross, no voucher). VAT contained is 14,000, so the base is 100,000. At 300 bps the commission is 3,000: Dr `creator_commission_expense` 3,000, Cr `creator_payable:u1` 3,000.

### 13. Half the line is returned after accrual
Refund of 57,000 gross is 50,000 of base, so the commission target falls to 1,500 and 1,500 is clawed back: Dr `creator_payable:u1` 1,500, Cr `creator_commission_expense` 1,500. Payable 1,500. Replaying the same refund claws back 0.

### 14. Return after payout
Accrual 3,000, payout 3,000 (Dr `creator_payable` 3,000, Cr `bank_settlement` 3,000), then a full return claws back 3,000. `creator_payable` is minus 3,000, shown to the creator as "owes platform 3,000" and blocking a new payout. The next accrual of 5,000 leaves 2,000 payable. The trial balance is 0 throughout.

## Edge cases
- Zero components (no shipping, no discount, zero fee) emit no posting, since zero-amount postings are not allowed.
- Commission plus VAT above merchandise throws. Discounts above merchandise throw.
- Tender total mismatch throws `TenderMismatchError`.
- `seller_payable` may be negative after a refund past payout. It is netted from the next payout.
- Account id segments must match `[A-Za-z0-9_-]+`, so an id can never contain a separator.
- Shipping refunds are computed independently of the order, so refund the whole fee or none. A partial shipping refund could differ from the original VAT split by one piastre. Not supported until a stored per-line net/vat snapshot is passed in.

## Data
Maps to `ledger_accounts(id, type, owner_type, owner_id, currency)`, `journal_entries`, `postings` (§T4). PII class P1 (internal): ids contain user ids and store ids, no names. Account type definitions are static code, not database rows.

## API
No HTTP surface. Public exports: `ACCOUNT_TYPES`, `chart`, `describeAccount`, `derivedBalance`, `planStoreCreditSpend`, builders `orderRecognised`, `refundIssued`, `clearingSettled`, `sellerPayout`, `sellerPromoNetted`, `giftCardSold`, `giftCardRedeemed`, `storeCreditGranted`, `storeCreditExpired`, `plusCharged`, `plusRevenueRecognised`, `planPlusRecognition`, `allocateVoucher`.

## Events
Builders emit `JournalEntry.kind` values: `order_recognised`, `refund_issued`, `clearing_settled`, `seller_payout`, `seller_promo_netted`, `gift_card_sold`, `gift_card_redeemed`, `store_credit_granted`, `store_credit_expired`, `plus_charged`, `plus_revenue_recognised`, `reversal`. The outbox event names are defined with the persistence adapter.

## Failure handling
Typed errors extending `DomainError`: `InvalidAccountError`, `InvalidChartInputError`, `TenderMismatchError`, `InsufficientCreditError`, plus the ledger's `UnbalancedEntryError` and `InvalidEntryError`. Entries are built whole, so nothing is partially applied.

## Security and abuse
- Store credit cannot be bought with store credit, gift cards or Plus (loop and laundering prevention, §15.1).
- No builder moves store credit to cash or to another user. The only path out of `store_credit` is spending on an order, expiry, or a refund that mirrors a prior order.
- Idempotency keys are mandatory and enforced by `createJournalEntry`.

## Metrics
Trial balance equals zero (integrity job). Unmatched lines older than 3 days in each clearing account (§T8). Store-credit projection drift equals zero. `refund_reserve` equals zero. `deferred_plus_revenue` never negative.

## Acceptance
- Every worked example balances to zero and yields the documented balances (`worked-examples.test.ts`).
- Order entries balance for arbitrary sellers, rates and amounts (property test).
- Any split of a full refund reproduces the original commission and VAT exactly (property test).
- Spend plans always sum to the amount and never overspend a sub-balance (property test).
- Plus recognition always sums exactly to the net (property test).

## Open items (VERIFY BEFORE LAUNCH)
1. VAT point and base for gift cards (sale versus redemption) and gift-card breakage on expiry.
2. VAT and accounting of coins, referral credit and goodwill (expense or revenue reduction).
3. VAT base when the platform funds a discount, and whether commission is on pre-voucher merchandise.
4. Whether commission and VAT are returned to the seller, and platform-funded discounts reversed, on refund.
5. VAT timing on Plus charges (at receipt or at period).
6. Who bears PSP, BNPL and courier fees, and their VAT.
7. Creator commission: VAT base when the platform funds it, withholding and VAT-registration threshold for individuals, and whether a creator payable may sit on the ledger before payouts are licensed (VR-P3-03, ADR-0037).
7. Whether Z-OUTLET ever holds funds in its own bank account (open question 4). `bank_settlement` assumes a settlement account exists.
8. Marketplace-agent model and withholding or reporting duties (open question 10).
