# Spec: Ledger chart of accounts and worked journal entries

- **Status:** Draft v1 (2026-11-07). **TWO-KEY: needs explicit human owner approval AND a chief-reviewer (fresh-context) sign-off before any ledger code is merged** (BUILD-PROMPT §2.3). Label every PR that implements it `needs-human`.
- **Precedence:** BUILD-PROMPT §2 (money rules) → vision addendum → master prompt §T4, §15, §20, Part B. ADR-0006 (#2: money = minor units + currency, ledger per currency).
- **Reference adapted from:** `/Users/nadakhalifa/OUTLET/docs/specs/ledger-chart-of-accounts.md` (older iOS-first build). Changes: market and currency in every account id, pending/available seller balances, both payment split models, COD and RTO, seller plans, chargebacks, payout netting.
- **Figures:** every amount below is a **development fixture** in piastres (100 piastres = 1 EGP). Commission 15% (1,500 bps) is a fixture only, because commission is owner decision **D1**. VAT 14% (1,400 bps) is the configured default for EG. PSP, BNPL and courier fees are fixtures, not contract terms (⚠ V4, V5, V33, V41, V43).

---

## 1. Principles (binding)

| # | Rule |
|---|---|
| P1 | Money is `{ amount: bigint (minor units), currency }`. Postgres `BIGINT`. No float anywhere (custom ESLint rule). |
| P2 | Double entry. Each journal entry has ≥ 2 postings, no zero postings, and postings sum to **0 per currency**. A **deferred constraint trigger** checks this at commit. |
| P3 | Sign convention: **positive = debit, negative = credit**. Balances are shown in the account's normal sign. |
| P4 | Postings are immutable (`UPDATE`/`DELETE` revoked from the app role). A correction is a **reversing entry** that references the original. |
| P5 | Every entry carries a unique `idempotency_key` (derived from the business event, e.g. `order_recognised:{seller_order_id}`). A replay returns the stored entry. |
| P6 | Every account belongs to **exactly one market and one currency**. An entry may not mix markets. Phase 1 has no FX entries (ADR-0006 #2). |
| P7 | **One rounding point**: `roundHalfEven(numerator, denominator)` in `packages/money/src/rounding.ts`. Percentages are basis points. Every other module calls it; none rounds on its own. |
| P8 | **No rounding or suspense account.** The seller amount is always the residual (`merchandise − commission − VAT on commission`), so every entry balances exactly. |
| P9 | Balances are derived from postings. Cached projections (wallet, seller balance) are reconciled nightly and any drift alerts. |
| P10 | Journal entries are hash-chained per market (`prev_hash`), with a daily signed snapshot (§T4 integrity job). |

### Options compared: how to know what a seller can be paid
1. **One `seller_payable` account; payout eligibility computed from order-line states at payout time.** Fewer entries, but the payout amount is a join across orders, returns and disputes, and is hard to reconcile.
2. **Two accounts, `seller_pending` → `seller_available`, moved by a ledger entry when the line is `CLOSED`.** (chosen)

Choice: option 2. The payout amount becomes one ledger balance that finance can reconcile and audit, refunds after close naturally create a negative balance that nets from the next payout, and the cost is one extra small entry per seller order.

---

## 2. Account naming scheme

```
{type}:{market}:{currency}[:{owner}][:{sub}]
```
- `type`: from the table in §3 (snake_case, fixed list in code).
- `market`: ISO 3166-1 alpha-2 market id (`EG` at launch, ADR-0006 #1).
- `currency`: ISO 4217 (`EGP`).
- `owner`: a store id, user id, PSP code, courier code or bank account code. UUIDv7 or a short registered code.
- `sub`: a sub-balance (store credit only).
- Every segment matches `[A-Za-z0-9_-]+`, so a segment can never contain `:`.

Examples: `psp_clearing:EG:EGP:paymob` · `seller_pending:EG:EGP:st_0193a…` · `store_credit:EG:EGP:usr_0193b…:refund_credit` · `platform_vat_output:EG:EGP`.

Table `ledger_accounts(id TEXT PK, type, market_id, currency CHAR(3), owner_type, owner_id, sub, normal_side, created_at)`; `CHECK` that `id` is built from the other columns. Postings: `postings(entry_id, account_id, amount BIGINT, currency CHAR(3))`, `CHECK (amount <> 0)`, and a trigger that `postings.currency = ledger_accounts.currency`.

> Physical key note (data model DM-18): in `docs/data-model.md` the text identifier above is stored as a UNIQUE `code` column and `id` is a UUID, so `postings` keys stay 16 bytes. The text code remains the business identifier used in this chart.

---

## 3. Chart of accounts (Phase 1)

Model column: **both** = used in split models (a) and (b); **(b)** = only when the platform collects and pays sellers; **(a)** = only with PSP marketplace split. ⚠ The split model is undecided (open question Q2, V3, V4).

### 3.1 Assets (normal side: debit)
| Type | Owner | Model | Debited when | Credited when | Reconciled against |
|---|---|---|---|---|---|
| `psp_clearing` | PSP code | both | Payment captured | PSP settles, refunds, withholds for a chargeback, charges fees | PSP settlement file |
| `bnpl_clearing` | BNPL provider | both | BNPL order approved | Provider settles or cancels the loan | Provider statement |
| `cod_clearing` | Courier code | both | Courier confirms delivery and cash collected | Courier remits (net of its fees) | Courier remittance report |
| `bank_operating` | Bank account code | both | Platform's own revenue is settled to it | Platform expenses paid | Bank statement |
| `bank_collections` | Bank account code | (b) | Settlements that include seller money | Seller payouts, shopper refunds, sweep of earned revenue to `bank_operating` | Bank statement. ⚠ V3: may need a segregated or safeguarded account |
| `payouts_in_transit` | — | (b) | — (normal debit; holds credit while a payout is in flight; see §4.11) | — | Bank payout file |
| `disputes_in_progress` | PSP code | both | PSP withholds funds for a chargeback | Dispute won (back to clearing) or lost (to seller or loss) | PSP dispute report |
| `vat_input` | — | both | Input VAT on supplier invoices (courier, PSP) where recoverable | VAT return | Supplier e-invoices. ⚠ V59 |

### 3.2 Liabilities (normal side: credit)
| Type | Owner | Model | Credited when | Debited when | Can go negative? |
|---|---|---|---|---|---|
| `seller_pending` | Store | both | Order recognised (prepaid at payment, COD at delivery) | Refund before close; line `CLOSED` (moved to available); in (a) also PSP split settled to the seller | **No** (invariant I11) |
| `seller_available` | Store | both | Line `CLOSED` | Payout sent; refund, chargeback or recharge after close; plan fee deducted | **Yes**: the seller owes us; netted from the next payout |
| `store_credit` | User + sub | both | Refund to credit (`refund_credit`), goodwill grant (`goodwill`), referral reward (`referral_credit`) | Spent on an order; expiry of promo subs | **No** |
| `shopper_refunds_payable` | — | both | A refund owed by bank or wallet transfer (e.g. COD order the shopper wants refunded in money) | Transfer sent | No |
| `courier_payable` | Courier code | both | Courier delivery, COD and RTO charges accrued | Netted from a COD remittance or paid | No |
| `platform_vat_output` | — | both | VAT on the platform's own supplies (commission, fees, seller plans, delivery the platform sells, recharges) | Refund of the supply; VAT return | No |
| `deferred_revenue` | Revenue stream (`seller_plans`) | both | Seller plan charged in advance (net of VAT) | Recognised per period | No |

### 3.3 Revenue (normal side: credit)
| Type | Credited when | Debited when |
|---|---|---|
| `commission_revenue` | Order recognised | Refund, rejection, chargeback mirrors |
| `shipping_revenue` | Delivery fee charged to the shopper (net of VAT); return-pickup fee kept from a refund | Fee refunded |
| `seller_plan_revenue` | Recognised from `deferred_revenue` | — |
| `recharge_revenue` | Costs re-charged to a seller (e.g. RTO when the policy says seller pays) | Recharge reversed |

### 3.4 Expenses (normal side: debit)
| Type | Debited when |
|---|---|
| `promo_expense_platform` | Platform-funded discount applied (credited back if the discounted line is refunded) |
| `psp_fee_expense` | PSP settlement fee, refund fee, dispute fee |
| `bnpl_fee_expense` | BNPL merchant discount fee at settlement |
| `courier_cost_expense` | Courier delivery, COD collection and RTO charges |
| `chargeback_loss_expense` | Chargeback lost where the platform, not the seller, bears it |
| `goodwill_expense` | Goodwill store credit granted by support |
| `referral_expense` | Referral credit granted |
| `payout_fee_expense` | Bank fee per payout (if any) |

### 3.5 Not in Phase 1 (reserved names, no postings allowed)
`gift_card_liability`, `deferred_plus_revenue`, `plus_revenue`, `cashback_coins` sub-balance, `duties_payable` (DDP, Phase 3), `fx_conversion`. International **DAP** (Phase 2) needs no new account: duties are paid by the shopper to the courier on arrival and never pass through our ledger (shipping spec §4). A posting to a reserved account fails.

---

## 4. Worked examples

Common fixtures: market `EG`, currency `EGP`, PSP `paymob`, courier `bosta`, BNPL provider `valu`, stores `A`, `B`, `C`, `D`. Account ids below drop the `:EG:EGP` segment for width; the real id always has it. **Model (a) vs (b)** notes appear only where the entries differ.

Formulas (all through the single rounding point, §4.13):
- `commission = roundHalfEven(base × commission_bps, 10,000)` per seller order.
- `commission_vat = roundHalfEven(commission × 1,400, 10,000)`.
- `seller = base − commission − commission_vat` (residual).
- Delivery fee is VAT-inclusive (B2C): `vat = roundHalfEven(gross × 1,400, 11,400)`, `net = gross − vat`.
- Commission base default = merchandise after **seller-funded** discounts, before **platform-funded** discounts, VAT-inclusive goods price. ⚠ V60 (config `commission_base`, part of D1).
- Assumed tax model: **marketplace agent**. The seller supplies the goods and issues the shopper e-receipt; the platform books VAT only on its own supplies. ⚠ V6, V61.

### 4.1 Multi-store prepaid order (3 stores, card)
Cart: A 249,900 (free delivery, ≥ 200,000 per store), B 89,950 (lines 59,950 + 30,000) + delivery 6,000, C 45,000 + delivery 6,000. Shopper pays **396,850** by card. Posted when the PSP webhook `payment.succeeded` is verified (one entry per order group, key `order_paid:{order_group_id}`).

| Account | Dr | Cr | Working |
|---|---:|---:|---|
| `psp_clearing:paymob` | 396,850 | | 249,900 + 89,950 + 45,000 + 12,000 |
| `seller_pending:A` | | 207,167 | 249,900 − 37,485 − 5,248 |
| `seller_pending:B` | | 74,569 | 89,950 − 13,492 − 1,889 |
| `seller_pending:C` | | 37,305 | 45,000 − 6,750 − 945 |
| `commission_revenue` | | 57,727 | 37,485 + 13,492 (13,492.5 → even) + 6,750 |
| `platform_vat_output` | | 9,556 | commission VAT 5,248 + 1,889 + 945, delivery VAT 737 + 737 |
| `shipping_revenue` | | 10,526 | 5,263 + 5,263 |
| **Total** | **396,850** | **396,850** | |

PSP settles T+n with a fixture fee of 11,906:

| Account | Model (b) Dr | Model (b) Cr | Model (a) Dr | Model (a) Cr |
|---|---:|---:|---:|---:|
| `bank_collections` | 384,944 | | — | |
| `bank_operating` | — | | 65,903 | |
| `psp_fee_expense` | 11,906 | | 11,906 | |
| `seller_pending:A` / `B` / `C` | — | | 207,167 / 74,569 / 37,305 | |
| `psp_clearing:paymob` | | 396,850 | | 396,850 |

Model (a) working: the PSP pays each seller's share straight to the seller (319,041 in total) and the platform gets 396,850 − 319,041 − 11,906 = 65,903. In (a), `seller_pending` is emptied at split settlement, so a later refund or chargeback for that line debits `seller_available` instead (which may go negative). The rule "debit `seller_pending` only up to the line's unsettled pending part, the rest from `seller_available`" keeps invariant I11 true in both models. ⚠ In (a) the seller gets money **before** the return window closes unless the PSP supports a delayed or held split (V4). Who bears the PSP fee in (a) is a contract question (V4).

### 4.2 Voucher: platform-funded vs seller-funded
Store D, merchandise 100,000, voucher 10,000, delivery 0 (store threshold met). Shopper pays 90,000.

| Account | Platform-funded Dr | Cr | Seller-funded Dr | Cr |
|---|---:|---:|---:|---:|
| `psp_clearing:paymob` | 90,000 | | 90,000 | |
| `promo_expense_platform` | 10,000 | | — | |
| `seller_pending:D` | | 82,900 | | 74,610 |
| `commission_revenue` | | 15,000 | | 13,500 |
| `platform_vat_output` | | 2,100 | | 1,890 |
| **Total** | **100,000** | **100,000** | **90,000** | **90,000** |

- Platform-funded: the commission base stays 100,000, so the seller is paid as if the shopper paid full price.
- Seller-funded: the base is 90,000. No receivable is needed, because the seller's share is simply smaller.
- A cart-level voucher is split across seller orders by **largest remainder** (§4.13).
- If the discounted line is refunded, the platform-funded part is credited back to `promo_expense_platform`, and the voucher is not re-issued unless the whole order is cancelled before shipping (§17).
- ⚠ V62: the VAT base of the seller's goods and of our commission when the platform funds a discount (master V6).

### 4.3 COD order delivered, then courier remittance
Store A, merchandise 120,000 + delivery 6,000 = **126,000 COD**. **Nothing is posted at placement**: a COD order is not money yet. Courier fixtures: delivery 4,500, COD collection fee 1,000.

At courier-confirmed delivery (key `order_delivered_cod:{seller_order_id}`):

| Account | Dr | Cr |
|---|---:|---:|
| `cod_clearing:bosta` | 126,000 | |
| `seller_pending:A` | | 99,480 |
| `commission_revenue` | | 18,000 |
| `platform_vat_output` | | 3,257 (2,520 + 737) |
| `shipping_revenue` | | 5,263 |
| `courier_cost_expense` | 5,500 | |
| `courier_payable:bosta` | | 5,500 |
| **Total** | **131,500** | **131,500** |

Remittance: Bosta remits 126,000 − 5,500 = 120,500.

| Account | Dr | Cr |
|---|---:|---:|
| `bank_collections` (see model (a) note) | 120,500 | |
| `courier_payable:bosta` | 5,500 | |
| `cod_clearing:bosta` | | 126,000 |

**Model (a) note:** COD cash never passes through the PSP, so a PSP split cannot pay the seller. Either the courier remits to the platform (the platform then holds seller money, which is model (b) for COD), or the courier remits each seller's share directly (needs a courier feature and loses netting). ⚠ V63. Aging of `cod_clearing` above 3 days escalates to Finance.

### 4.4 COD refused (RTO)
Same order, shopper refuses at the door. Goods return to the seller. No sale posting ever happened. Courier fixtures: outbound 4,500, RTO 3,000.

Case 1, platform-funded first refusal (§20.7 default):

| Account | Dr | Cr |
|---|---:|---:|
| `courier_cost_expense` | 7,500 | |
| `courier_payable:bosta` | | 7,500 |

Case 2, policy says the seller pays (e.g. seller-fault, wrong address on the label). Add a recharge entry. Treated as a platform supply with VAT:

| Account | Dr | Cr |
|---|---:|---:|
| `seller_available:A` | 8,550 | |
| `recharge_revenue` | | 7,500 |
| `platform_vat_output` | | 1,050 |

⚠ V64: whether a cost recharge is a VAT-able supply or a disbursement without VAT. The shopper's refusal history is risk data, not ledger data.

### 4.5 Partial seller rejection → partial refund
From §4.1, store B rejects line 2 (30,000) before shipping (`REJECTED_BY_SELLER` for that line). Refund 30,000 to the card. B's delivery fee stays because the parcel still ships.

Commission and VAT are computed on the **remaining** amount and differenced, so any sequence of partial refunds sums exactly to the original:
- commission: C(89,950) − C(59,950) = 13,492 − 8,992 = **4,500**
- VAT: V(13,492) − V(8,992) = 1,889 − 1,259 = **630**
- seller: 30,000 − 4,500 − 630 = **24,870** (check: 74,569 − 24,870 = 49,699 = 59,950 − 8,992 − 1,259)

| Account | Dr | Cr |
|---|---:|---:|
| `seller_pending:B` | 24,870 | |
| `commission_revenue` | 4,500 | |
| `platform_vat_output` | 630 | |
| `psp_clearing:paymob` | | 30,000 |

If the PSP keeps its fee on a refund, a separate `psp_fee_expense` posting is made from the settlement file. Charging that fee to the rejecting seller is a policy choice (⚠ D1 / Seller Agreement).
**Model (a):** if B's split already settled to B, the PSP must reverse the split or `seller_pending:B` cannot be debited from money we hold. ⚠ V4. The entry is the same; the cash recovery differs.

### 4.6 Return refunded to the card
From §4.1, the shopper returns A's 49,900 line within 14 days (change of mind, before close). A's remaining 200,000 still meets the free-delivery threshold. The shopper pays a 4,000 return-pickup fee (VAT-inclusive), deducted from the refund (⚠ V7: deduction allowed under CPL?).
- commission: C(249,900) − C(200,000) = 37,485 − 30,000 = 7,485
- VAT: 5,248 − 4,200 = 1,048
- seller: 49,900 − 7,485 − 1,048 = 41,367
- return fee: VAT 491, net 3,509

| Account | Dr | Cr | Ref |
|---|---:|---:|---|
| `seller_pending:A` | 41,367 | | line |
| `commission_revenue` | 7,485 | | line |
| `platform_vat_output` | 1,048 | | line (commission VAT reversed) |
| `psp_clearing:paymob` | | 45,900 | refund to card |
| `shipping_revenue` | | 3,509 | return fee |
| `platform_vat_output` | | 491 | return fee VAT |
| **Total** | **49,900** | **49,900** | |

Two postings to the same account in one entry are allowed when each has its own `ref` (line vs fee), so e-invoices and credit notes can trace them.

### 4.7 Refund to store credit
Same return, but the shopper chooses **instant store credit** (allowed only for card, wallet and COD tenders; never BNPL). Identical to §4.6 except:

| Account | Dr | Cr |
|---|---:|---:|
| `store_credit:usr_1:refund_credit` | | 45,900 (instead of `psp_clearing`) |

Later the shopper spends it on store D (merchandise 45,900): commission 6,885 (exact), VAT 963.9 → 964, seller 45,900 − 6,885 − 964 = 38,051.

| Account | Dr | Cr |
|---|---:|---:|
| `store_credit:usr_1:refund_credit` | 45,900 | |
| `seller_pending:D` | | 38,051 |
| `commission_revenue` | | 6,885 |
| `platform_vat_output` | | 964 |

Cash note: in (b) the 45,900 stays in `bank_collections` until spent. In (a) the card money may already be with seller A, so the platform carries the store-credit liability with its own funds until A's balance is recovered. ⚠ V3 (closed-loop credit outside e-money) and V4.

### 4.8 BNPL order, settlement and cancellation
Store C, merchandise 150,000 + delivery 6,000 = 156,000, tender BNPL (through the PSP or provider). Provider fee fixture 7,800.

Order approved:

| Account | Dr | Cr |
|---|---:|---:|
| `bnpl_clearing:valu` | 156,000 | |
| `seller_pending:C` | | 124,350 |
| `commission_revenue` | | 22,500 |
| `platform_vat_output` | | 3,887 (3,150 + 737) |
| `shipping_revenue` | | 5,263 |

Provider settles: Dr `bank_collections` 148,200, Dr `bnpl_fee_expense` 7,800 / Cr `bnpl_clearing:valu` 156,000.

Whole order returned on day 5 (whole-order return within 7 days → delivery fee refunded too). **Refund only by loan cancellation through the provider** (§B3):

| Account | Dr | Cr |
|---|---:|---:|
| `seller_pending:C` | 124,350 | |
| `commission_revenue` | 22,500 | |
| `platform_vat_output` | 3,887 | |
| `shipping_revenue` | 5,263 | |
| `bnpl_clearing:valu` | | 156,000 |

`bnpl_clearing` is now −156,000 (we owe the provider). The provider nets it from the next settlement: Dr `bnpl_clearing` / Cr bank. Whether the merchant fee is refunded is a contract term (⚠ V5). **Never** `store_credit` or `psp_clearing` for a BNPL refund (invariant I8).

### 4.9 Seller plan subscription fee with VAT
Fixture plan: 100,000 net per month (price is D1), VAT 14% = 14,000, gross 114,000. B2B prices are VAT-exclusive. Billed in advance.

| Account | Pay by card Dr | Deduct from balance Dr | Cr |
|---|---:|---:|---:|
| `psp_clearing:paymob` | 114,000 | — | |
| `seller_available:A` | — | 114,000 | |
| `deferred_revenue:seller_plans` | | | 100,000 |
| `platform_vat_output` | | | 14,000 |

Deduction from balance needs a Seller Agreement clause (⚠ V24). At month end: Dr `deferred_revenue:seller_plans` 100,000 / Cr `seller_plan_revenue` 100,000.
Annual plan of 1,000,000 net: 12 periods by largest remainder = 4 × 83,334 + 8 × 83,333 (earlier periods get the extra piastre); the sum is exactly 1,000,000.
VAT point (at charge or per period) ⚠ V24.

### 4.10 Commission + VAT e-invoice to the seller (no new journal entry)
The monthly ETA e-invoice is a **document derived from the ledger**, not a posting. Store A, November, from §4.1, §4.4 case 2, §4.6 and §4.9:

| Invoice line (one per ledger event) | Net | VAT 14% |
|---|---:|---:|
| Commission, seller order A-1 (§4.1) | 37,485 | 5,248 |
| Credit: commission reversed on return (§4.6) | −7,485 | −1,048 |
| RTO recharge (§4.4 case 2) | 7,500 | 1,050 |
| Seller plan, November (§4.9) | 100,000 | 14,000 |
| **Total** | **137,500** | **19,250** |

Rules:
- **One invoice line per ledger event**, carrying the VAT that was posted. Recomputing VAT on a summed line can differ by a piastre (§4.13), and then the invoice would not match the ledger.
- A refund after the invoice was issued produces an **ETA credit note**, not an edit.
- Invariant I14: Σ VAT on issued e-invoices and credit notes for a period = Σ credits − debits on `platform_vat_output` for that period, for supplies to sellers.
- ⚠ V6: whether ETA accepts negative lines on an invoice or needs a separate credit note; the tax point for commission (at payment, at delivery or at close).

### 4.11 Weekly payout with negative-balance netting (model (b))
Store B, week 46:
1. Opening `seller_available:B` = 0.
2. A post-close defect return on an older order (20,000, seller-fault, 30-day window) refunded to card: Dr `seller_available:B` 16,580, Dr `commission_revenue` 3,000, Dr `platform_vat_output` 420 / Cr `psp_clearing:paymob` 20,000. Balance **−16,580** (B owes us).
3. B's order from §4.1/§4.5 reaches `CLOSED` (return window + 3 days, no open dispute): Dr `seller_pending:B` 49,699 / Cr `seller_available:B` 49,699. Balance **33,119**.
4. Payout run (Monday, `SCHEDULED → APPROVED → SENT`):

| Step | Account | Dr | Cr |
|---|---|---:|---:|
| SENT | `seller_available:B` | 33,119 | |
| SENT | `payouts_in_transit` | | 33,119 |
| SETTLED (bank confirms) | `payouts_in_transit` | 33,119 | |
| SETTLED | `bank_collections` | | 33,119 |

- FAILED: a reversing entry of SENT puts 33,119 back in `seller_available:B`.
- Netting is automatic: the payout is the balance, so the −16,580 was recovered from the 49,699.
- If the balance were still negative, no payout is made; the debt carries forward. After N weeks (config) Finance invoices the seller. ⚠ D1 / Seller Agreement.
- Payout rules: amount > 0, ≤ balance, IBAN name match, dual approval above a threshold, idempotent key `payout:{payout_id}`.

**Model (a):** there is no platform payout. The PSP split pays the seller at settlement (§4.1). A negative balance can be recovered only if the PSP supports deducting it from future splits, or by invoicing the seller or charging a card on file. ⚠ V4. This is the strongest operational argument for (b) or a PSP with delayed split.

### 4.12 Chargeback
Card chargeback ("not received") on store C's part of §4.1: 45,000 + 6,000 = 51,000, after C was paid out. PSP dispute fee fixture 1,500.

Opened (PSP withholds):

| Account | Dr | Cr |
|---|---:|---:|
| `disputes_in_progress:paymob` | 51,000 | |
| `psp_fee_expense` | 1,500 | |
| `psp_clearing:paymob` | | 52,500 |

Resolution, one of:

| Outcome | Dr | Cr |
|---|---|---|
| **Won** | `psp_clearing:paymob` 51,000 | `disputes_in_progress:paymob` 51,000 |
| **Lost, seller liable** (no proof of delivery) | `seller_available:C` 37,305; `commission_revenue` 6,750; `platform_vat_output` 1,682 (945 + 737); `shipping_revenue` 5,263 | `disputes_in_progress:paymob` 51,000 |
| **Lost, platform liable** (fraud screen passed, delivery proven) | `chargeback_loss_expense` 51,000 | `disputes_in_progress:paymob` 51,000 |

- "Seller liable" makes `seller_available:C` −37,305; it nets as in §4.11.
- Whether commission is returned on a lost chargeback, and who pays the dispute fee, are Seller Agreement choices (D1). The default mirrors a refund.
- **Model (a):** the PSP may debit the seller's sub-merchant account directly; then the "seller liable" row is replaced by the PSP's adjustment report. ⚠ V4.

### 4.13 Rounding: banker's rounding at the single documented point
`roundHalfEven(n, d)`: exact integer division; if the remainder is exactly half, round to the even neighbour; otherwise to the nearest. Inputs are `bigint`.

| Case | Exact | Result | Why |
|---|---|---:|---|
| Commission 89,950 × 15% | 13,492.5 | 13,492 | tie → even |
| Commission 59,950 × 15% | 8,992.5 | 8,992 | tie → even |
| VAT on commission 2,625 | 367.5 | 368 | tie → even |
| VAT on commission 13,492 | 1,888.88 | 1,889 | nearest |
| Delivery VAT 6,000 × 14/114 | 736.84 | 737 | nearest |
| Commission 10,003 × 15% | 1,500.45 | 1,500 | nearest |

**Aggregation trap:** VAT per event on commissions 13,492 and 2,625 = 1,889 + 368 = 2,257. VAT on the sum 16,117 = 2,256.38 → 2,256. A one-piastre difference. Therefore VAT is computed **once per event** and every document reuses the posted number (§4.10).

**Allocation (no rounding loss):** a 10,000 cart-level platform voucher over A 249,900, B 89,950, C 45,000 (total 384,850):

| Store | Exact share | Floor | + remainder | Final |
|---|---:|---:|---:|---:|
| A | 6,493.44 | 6,493 | +1 (largest fraction .44) | 6,494 |
| B | 2,337.27 | 2,337 | | 2,337 |
| C | 1,169.29 | 1,169 | | 1,169 |
| **Sum** | 10,000 | 9,999 | | **10,000** |

Ties on the fraction break by the lower seller-order index (deterministic).

---

## 5. Invariants and the property tests they imply

All property tests use fast-check (≥ 1,000 runs in CI, seed logged). Ledger, refunds and payouts need Stryker mutation ≥ 80%.

| # | Invariant | Enforced by | Property / test |
|---|---|---|---|
| I1 | Each entry sums to 0 per currency | Domain constructor + deferred DB trigger | Random postings: constructor accepts iff balanced; DB rejects unbalanced commit (PG16 integration test) |
| I2 | Posting currency = account currency; no FX entries in Phase 1 | DB trigger; domain type | Random accounts/currencies: mismatch always rejected |
| I3 | All postings in an entry share one market | Domain + DB check | Mixed-market entry always rejected |
| I4 | Postings are immutable; corrections only by reversal | Revoked grants; `reverse(e)` | `apply(e) + apply(reverse(e))` = zero change on every account; UPDATE/DELETE as app role fails |
| I5 | Idempotency key unique; replay is a no-op | `UNIQUE` index; service | Replaying any event sequence N times yields the same ledger as once |
| I6 | Trial balance per market and currency = 0 | Nightly integrity job | After any random sequence of business events, Σ all balances = 0 |
| I7 | `store_credit` never negative; enters only via refund, goodwill, referral; leaves only by spend or expiry (no cash-out, no P2P) | Builder types; DB check on projection | Random event sequences: balance ≥ 0; no builder has a store-credit debit with an external-money credit |
| I8 | A BNPL-tendered line is refunded only to `bnpl_clearing` | RefundRouter + builder guard | Random refunds on BNPL orders never touch `store_credit` or `psp_clearing` |
| I9 | Cumulative refunds per line ≤ captured; refund destinations sum to the refund | Refund builder | Random partial refund sequences never exceed captured; sum check |
| I10 | Full refund through any split reproduces the original commission and VAT exactly | Remaining-amount differencing | Random partitions of a line: Σ refunded commission = original commission; Σ VAT likewise |
| I11 | `seller_pending` ≥ 0 per store | Refund before close limited to the line's own pending part | Random order/refund/close sequences keep pending ≥ 0 |
| I12 | Payout > 0 and ≤ `seller_available`; only from `seller_available` | Payout service + check | Random balances: payout never exceeds; negative balance → no payout |
| I13 | Seller amount is the residual and ≥ 0 per seller order | Order builder | Random rates (0–10,000 bps) and amounts: residual ≥ 0 or a typed error; entry balances |
| I14 | E-invoice/credit-note VAT for a period = net `platform_vat_output` for seller supplies | Invoice generator reads posted VAT | Generate invoices for random ledgers: totals match to the piastre |
| I15 | No `cod_clearing` posting without a delivery-proof ref; nothing posted at COD placement or refusal (except courier costs) | Builder requires `delivery_event_id` | Random COD lifecycles: refused orders leave `seller_*`, `commission_revenue` untouched |
| I16 | Platform-funded discount never reduces the seller residual; seller-funded never touches `promo_expense_platform` | Builder | Same order with each funding type: seller residual per §4.2 formula |
| I17 | Allocation parts sum exactly to the total; zero-weight parts get nothing | `allocateLargestRemainder` | Random weights/totals |
| I18 | Deferred revenue recognition sums exactly to the net; never negative | Schedule builder | Random nets and period counts |
| I19 | Reserved accounts (§3.5) have zero postings | DB check | Attempted posting fails |
| I20 | Journal hash chain verifies end to end | Integrity job | Tamper one stored entry in a test DB: verification fails at that entry |
| I21 | Cached projections (wallet, seller balance) = Σ postings | Nightly reconciliation | Random sequences: projection equals derived balance |
| I22 | Clearing accounts reconcile to external files; unmatched lines older than 3 days = 0 (SLO) | Reconciliation jobs | Fixture settlement files with missing/extra/duplicate lines produce exactly the expected exceptions |
| I23 | (b) `bank_collections` is debited only for seller payouts, shopper refunds and the sweep of earned platform revenue | Builder allow-list | Any other counter-account rejected. ⚠ V3 safeguarding |
| I24 | No float, no `Number` on money paths | ESLint rule + type | Lint test fixture with a float fails CI |

Plus the acceptance tests: every worked example in §4 is an executable test (`worked-examples.test.ts`) asserting the exact postings and resulting balances, and the §7 master-prompt chaos test (kill the API mid-saga → no double charge, no unbalanced entry).

---

## 6. Events and API
- Entry `kind` values: `order_recognised`, `order_delivered_cod`, `refund_issued`, `line_closed`, `clearing_settled`, `courier_cost_accrued`, `courier_remitted`, `recharge_issued`, `plan_charged`, `revenue_recognised`, `payout_sent`, `payout_settled`, `dispute_opened`, `dispute_resolved`, `store_credit_granted`, `store_credit_spent`, `store_credit_expired`, `reversal`.
- Outbox event `journal_entry.posted(entry_id, kind, market_id)` in the same transaction.
- No public HTTP write surface. Read APIs: `GET /v1/seller/balance`, `GET /v1/seller/statements?cursor=` (seller scope, own store only, RLS), `GET /v1/me/wallet`, admin finance views (L3, passkey, reason code).

## 7. Open questions for the owner and counsel
1. **Split model (Q2):** (a) PSP marketplace split or (b) we collect and pay sellers. (b) gives netting and return-window holds; (a) may avoid holding seller money. Needs Paymob/Kashier written answers and counsel (V3, V4, V41).
2. **COD under (a):** courier remits to us (we hold seller money anyway) or per seller? (V63)
3. **Commission base and rate (D1):** before or after seller-funded discounts; VAT-inclusive goods price or net (V60).
4. **Tax model:** marketplace agent (seller supplies goods) vs platform as supplier for VAT (V61). If counsel says supplier, this whole chart changes (output VAT on goods).
5. **Tax point for commission VAT** and e-invoice credit notes (V6).
6. Who bears PSP fees on refunds, dispute fees and lost chargebacks; whether commission is returned on refunds and chargebacks (Seller Agreement, D1).
7. Deducting seller plan fees and recharges from seller balances (V24).
8. Deducting a return-pickup fee from a shopper refund (V7).
9. Negative seller balance: how many weeks before invoicing, and whether a card on file may be charged.
10. Whether `bank_collections` must be a segregated or safeguarded account (V3).

## 8. New verify rows proposed (provisional numbers V59–V64; the register owner confirms, because other agents add rows in parallel)
| # | Item | Owner |
|---|---|---|
| V59 | Recoverability of input VAT on PSP, BNPL and courier fees (financial services exemption?) | Tax |
| V60 | Commission base: before or after seller-funded discounts; VAT-inclusive or net goods price | Owner/Tax |
| V61 | Marketplace-agent VAT model vs platform as deemed supplier under model (b) | Tax/Legal |
| V62 | VAT base of goods and commission when the platform funds a discount | Tax |
| V63 | COD remittance under a PSP split model: can couriers remit per seller; does holding COD cash need a licence | Legal/Finance/Ops |
| V64 | VAT on cost recharges to sellers (supply vs disbursement) | Tax |
