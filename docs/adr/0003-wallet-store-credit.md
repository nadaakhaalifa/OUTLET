# ADR-0003: Wallet is closed-loop store credit, not e-money

- Status: **Proposed, blocked on open questions 3 and 4** (licensing opinion and flow of funds)
- Date: 2026-10-10
- Deciders: Legal, Finance, CTO
- Spec refs: §B2, §B3, §15.1, §15.2, §15.6, §T4, register rows 3, 4

## Context and problem statement

Issuing e-money or providing payment services in Egypt needs CBE authorization under Law 194/2020. A full e-money institution needs EGP 30m paid-up capital and a 90 (+90) day licensing decision. We found no explicit closed-loop exemption. We want a wallet-like experience (refund credit, gift cards, cashback, referral credit) without becoming a regulated e-money issuer, and we must also decide how seller money is held.

## Decision drivers

- Do not take on e-money licensing risk or capital requirements for launch.
- Money integrity: balances must be provable from immutable records.
- A licensed-partner path must stay open for later.
- Refunds must follow the law and the payment method (BNPL, card, COD).

## Considered options

1. **Closed-loop store credit** (default).
2. Full e-money institution licence.
3. Licensed EMI or bank partner provides a real wallet from day one.

## Decision

Option 1 for Phases 1–2, with Option 3 kept open as a Phase 3 add-on behind a port.

**Store credit rules**
- **No top-up** by cash or card. Value enters only as: refund the customer chose to take as credit, gift-card redemption, cashback coins, referral credit, goodwill.
- **No withdrawal** and **no P2P transfer.** The only cash-out is a legally required refund to the original payment method, and that goes through the PSP, never out of the wallet.
- **Spendable only on Outlet NK**, on goods sold there. Not usable for gift cards or Plus (anti-laundering).
- UI copy says "credit", never "cash" or "money".
- **Sub-balances** with their own expiry: `refund_credit` (none), `gift_card` (per card, default 3 y), `cashback_coins` (12 months), `referral_credit` (6 months), `goodwill` (90 days). Spend soonest-expiring first, refund credit last.

**Ledger rules (spec §T4)**
- Double-entry only. Balance is derived from postings, and a cached projection is reconciled nightly against them. Any drift raises an alert.
- Tables `ledger_accounts`, `journal_entries` (with `idempotency_key UNIQUE`) and `postings`. A deferred constraint trigger enforces that postings sum to zero per entry and currency. Postings are immutable, and corrections are reversing entries.
- Money is integer piastres (`BIGINT`), always with a currency.

**Domain separation**
- `StoreCreditAccount` and `PartnerWalletAccount` are separate aggregates. `WalletProviderPort` exists as an interface only.
- A `store_credit` ledger account is held per user and sub-balance.

**Seller money**
- Merchant-of-record funds are **never pooled in an Outlet NK account.** Collections go through a licensed PSP/aggregator, and the ledger records allocations (`seller_payable:{store}`).
- Whether Outlet NK may collect as an aggregator and pay sellers out, or must use the PSP's sub-merchant/split product, is **undecided** (question 4). The ledger is built so either works. The payout adapter stays unimplemented until it is answered.

**Refund routing (`RefundRouter`)**
- Card / Apple Pay / Meeza → PSP refund to original.
- BNPL → provider cancellation only, never store credit or cash.
- COD → store credit instantly (customer's choice) or transfer within the legal deadline.
- Store-credit or gift-card portion → back to the same sub-balance.
- All refunds are ledger-first.

**Gating**
- Gift-card sales and store-credit refunds sit behind kill switches. Gift-card sales stay **off** until written counsel/CBE confirmation is on file (register row 3).

## Consequences

**Good**
- No licence capital at launch, with a clear upgrade path.
- Provable balances, and a single audit trail for credit, gift cards and refunds.

**Bad / risks**
- Counsel may conclude that gift cards or store credit *are* e-money. The fallback is to stop issuing new credit and move to Option 3, which is a business-model change, not just an engineering task.
- Customers lose the "wallet" convenience (no top-up), which may reduce stored-value engagement.
- Breakage and expiry rules for gift cards are unverified (register row 9).

## Needed to finalize

Written opinion on closed-loop status (question 3), the aggregator versus sub-merchant flow-of-funds decision (question 4), and gift-card expiry limits (row 9).
