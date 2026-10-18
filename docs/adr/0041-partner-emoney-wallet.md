# ADR-0041: Partner e-money wallet

- Status: **Proposed, blocked on VR-03, VR-F1-04 and VR-P3-08 (licensed partner and CBE position)**
- Date: 2026-10-12
- Deciders: Founder, Finance, Legal
- Spec refs: §B2, §15.2, P3, ADR-0003, ADR-0021

## Context and problem statement
ADR-0003 fixed the wallet as closed-loop store credit: no top-up, no withdrawal, no P2P. P3 lists a "partner e-money wallet if licensed" (top-up, withdraw) behind `WalletProviderPort`. Z-OUTLET holds no licence; any real wallet must be issued and held by a licensed EMI or bank, with Z-OUTLET as an agent or program manager. Whether a given partner structure is permissible, who bears KYC, and where customer funds sit are unverified.

## Considered options
1. **Do not build; keep store credit** (default).
2. **Redirect model:** the shopper links a partner wallet (balance and payments live at the partner); Z-OUTLET only initiates payments and never holds value; refunds go back through the partner.
3. **Program-manager model:** branded wallet issued by the partner with Z-OUTLET UI, top-up and withdrawal via partner APIs.

## Decision (proposed default)
Option 1. Specify `WalletProviderPort` and keep `StoreCreditAccount` strictly separate from `PartnerWalletAccount` (as the master prompt requires). If the owner pursues a partner, start at option 2 (it is a payment method, not a ledger liability); option 3 requires a signed partner contract, counsel opinion and a Fable-tier money design review. No partner balance is ever mixed with store-credit sub-balances or counted in budget unless the partner provides it.

## Consequences
Good: no licensing exposure. Bad: no top-up and no cash-out for shoppers.

## Owner decision required
Whether to pursue a partner at all and which structure; this is a business and legal decision.

## Safe default if no answer
No partner wallet. Port defined, no adapter.
