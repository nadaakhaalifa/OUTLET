# ADR-0003: Wallet is closed-loop store credit; seller money flow supports two models

- Status: **Proposed — owner accepted recommendation 2026-11-07; needs counsel/contract confirmation before anything real** (depends on D5). Store credit and payouts stay behind kill switches until V3 and V4 have written answers.
- Date: 2026-11-07
- Deciders: Owner, counsel, Finance, CTO
- Sources: master prompt §B2, §B3, §15.1, §15.2, §15.6, §T4; `docs/BUILD-PROMPT.md` §2 (money rules); `reports/Outlet NK end to end build plan.md` ("Sign the payment contract first"); `docs/open-questions.md` Q2, Q11; plan-and-risks risk 18; ADR-0006 (money = minor units + currency)

## Context

**Store credit.** Issuing e-money or providing payment services in Egypt needs CBE authorisation under Law 194/2020. A full e-money institution needs EGP 30m paid-up capital (Andersen via Mondaq, master prompt §B2). No explicit closed-loop exemption was found. An older secondary source points to CBE Regulation Book 12.7 treating closed-loop prepaid cards such as gift cards as a regulated category; this was **not checked against the primary text** (reference repo ADR-0003 research update). We still need somewhere to put refunds a shopper chooses to take as credit, and later gift cards and rewards.

**Seller money (D5, undecided).** One bag across many stores is paid once. **No Egyptian PSP publicly documents a marketplace split-and-payout product.** Kashier's "connected accounts" is the only documented sub-merchant primitive, and it covers payment, not settlement (build-plan report). Paymob documents a payouts product but no split. The master prompt §B2 says seller money must **never sit in a pooled platform account**. The build-plan report's fallback (Paymob as merchant of record, pay sellers from settled funds) would pool seller money unless counsel finds a compliant structure.

## Options considered

### Store credit
| Option | Good | Bad |
|---|---|---|
| **1. Closed-loop store credit, no top-up, no cash-out (chosen)** | No licence capital at launch; balances provable from the ledger | Counsel may still call it e-money (V3); no "wallet" top-up convenience |
| 2. Our own e-money licence | Full wallet | EGP 30m capital and a long CBE process; not viable for launch |
| 3. Licensed EMI or bank partner wallet from day one | Real wallet | A partner contract we do not have; more integration |

### Seller money flow (D5)
| Model | How it works | Good | Bad |
|---|---|---|---|
| **A. PSP marketplace split** | Each seller has a sub-merchant/connected account at the PSP; the PSP settles each seller's share directly | Seller money never touches us; matches §B2 | Unconfirmed that one checkout can split across several connected accounts (Kashier); each brand needs its own MID; onboarding time per brand |
| **B. Merchant collects, then pays out** | We collect as merchant at the PSP; the ledger tracks each seller's payable; we pay out from settled funds via the PSP payouts product | One merchant account; simplest onboarding | May need a PSP or payment-facilitator licence; seller funds may be "pooled" (conflicts with §B2) unless counsel approves a structure (e.g. a segregated account) |

**Choice (2–3 lines):** closed-loop credit is the only option with no licence capital and a partner path kept open. For seller money we cannot choose yet: we build the ledger and a `SettlementPort` so both models work, and pick after written PSP answers (Paymob, Kashier) and counsel's opinion. Model A is preferred if it works, because it never pools seller money.

## Decision

### 1. Store credit rules
- **No top-up** with cash or card. Value enters only as: a refund the shopper **chose** to take as credit, goodwill, and later (each behind its own kill switch and counsel sign-off) gift-card redemption, cashback coins, referral credit, trade-in credit (feature 40, V3).
- **No withdrawal, no P2P transfer.** The only cash-out is a refund the law requires to go to the original method, and that goes through the PSP, never out of the credit balance.
- Usable **only on Outlex**, for goods sold there. Not usable to buy gift cards or Plus (anti-laundering loops).
- UI copy says "credit", never "cash", "money" or "wallet balance".
- **Per market and per currency** (ADR-0006). Credit in EGP is spent only in the EG market. No FX conversion of credit.
- **Sub-balances**, each with its expiry shown: `refund_credit` (no expiry), `goodwill` (90 days), and later `gift_card` (per card), `cashback_coins` (12 months), `referral_credit` (6 months). Spend soonest-expiring first, `refund_credit` last, so it can still go back to the original method if needed.
- **Phase 1 scope:** `refund_credit` and `goodwill` only. Gift cards are Phase 2 and stay **off** until written counsel/CBE confirmation (V3, V9).

### 2. Ledger rules (master prompt §T4, BUILD-PROMPT §2)
- Double-entry only. Tables `ledger_accounts`, `journal_entries` (`idempotency_key UNIQUE`), `postings` (amount `BIGINT` signed, minor units, with `currency`).
- A **deferred constraint trigger** keeps the sum of postings per entry per currency at zero. Postings are immutable (UPDATE/DELETE revoked). Corrections are reversing entries.
- Balances are derived from postings. A cached projection is reconciled nightly; any drift raises an alert.
- `StoreCreditAccount` and `PartnerWalletAccount` are separate aggregates. `WalletProviderPort` exists as an interface only (Phase 3 partner path).

### 3. Seller money: one ledger, two settlement models
- The **allocation** at payment time is the same in both models. Example (amounts in piastres; commission rate comes from seller-plan config, ADR-0008, not a fixed number):
  - Dr `psp_clearing:{psp}` = total charged
  - Cr `seller_payable:{store}` per store (its lines minus commission)
  - Cr `platform_commission`, Cr `platform_vat_output` (VAT on commission, V6), Cr `shipping_revenue` where we charge delivery
- Only the **settlement** step differs, behind `SettlementPort`:
  - **Model A adapter:** the PSP settles the seller share to the seller's own account. We post Dr `seller_payable:{store}` / Cr `psp_clearing:{psp}` when the PSP settlement file confirms it. We never hold the seller's share.
  - **Model B adapter:** the PSP settles everything to us. We post the settlement into `bank:{account}`, then pay out by the payouts state machine (`SCHEDULED → ON_HOLD → APPROVED → SENT → SETTLED | FAILED`), with dual approval above a threshold and IBAN name-match. **Enabled only after counsel confirms Model B is lawful and how the funds must be held.**
- Payout eligibility in both models: line `CLOSED` (return window + 3 days) and no open dispute. Refund after payout → negative seller balance → netted from the next payout (Model B) or recovered per the PSP's rules (Model A, ⚠ V4).
- Nightly reconciliation of PSP settlement files ↔ `psp_clearing` in both models. Unmatched lines older than 3 days = 0 (SLO).

### 4. Refund routing (`RefundRouter`)
- Card / Apple Pay / Meeza → PSP refund to the original method.
- Mobile wallet / InstaPay → PSP reverse where supported (⚠ V4).
- Fawry → per contract (store credit or a Fawry refund voucher, ⚠ V4).
- **BNPL → provider cancellation only**, never store credit or cash (master prompt §B3, V5).
- COD → store credit instantly **if the shopper chooses it**, otherwise a transfer within the legal deadline (V7).
- Credit portion → back to the same sub-balance.
- The shopper chooses between the original method and instant credit wherever both are legal. **The default is the original method.**
- All refunds are ledger-first (reversing entries).

### 5. Kill switches
Separate switches for: store-credit refunds, goodwill, gift-card sales, gift-card redemption, referral credit, and each settlement adapter. Defaults: store-credit refunds and goodwill **off** until V3 has a written answer; the rest off.

## Consequences

**Good**
- No e-money capital at launch; a clear upgrade path through a licensed partner.
- The checkout saga, ledger and reconciliation do not change when D5 is decided; only one adapter is switched on.
- Balances and payouts are provable from immutable records.

**Bad / risks**
- If counsel says store credit or gift cards **are** e-money, we stop issuing new credit and move to a partner (a business change, not only engineering).
- If neither model is confirmed by week 8 (open-questions Q2), checkout cannot take real money. This is on the critical path.
- Model A may make each brand open a PSP account, which slows brand onboarding (plan-and-risks risk 1).
- Model B may need a licence or a segregated account we do not yet have.

## Verify-register rows
- **V3** CBE: closed-loop store credit and gift cards outside e-money; aggregator collection/payout model
- **V4** Paymob split/sub-merchant, payout from settlement, tokenisation; Kashier connected-account settlement and multi-account checkout; fees, T+n
- **V5** BNPL refund → loan cancellation via the PSP
- **V6** VAT on commission, coins, vouchers, gift cards
- **V7** refund payment deadline and method under CPL 181/2018
- **V9** gift-card expiry limits
- **V22** escrow / hold-until-accepted and seller cash advances (features 30, 35)

## Related
ADR-0001, ADR-0002 (money data stays in Egypt), ADR-0006 (currency per market), ADR-0008 (commission config), `docs/open-questions.md` Q2 and Q11.
