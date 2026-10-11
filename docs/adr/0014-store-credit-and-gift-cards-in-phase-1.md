# ADR-0014: Store credit and gift cards in Phase 1 versus legal status

- Status: **Proposed, blocked on VR-03 and VR-06**
- Date: 2026-10-10
- Deciders: Legal, Finance, Product
- Spec refs: Phase 1 list (checkout includes "store credit"), Phase 2 list ("gift cards & store credit"), wallet section 15.2, gift cards 15.1, B2, VR-03, VR-06, VR-09, ADR-0003, open question 3

## Context and problem statement

The Phase 1 checkout lists store credit as a payment method, while Phase 2 lists "gift cards and store credit" as a feature. The legal opinion that closed-loop store credit and gift cards are outside e-money is not on file (VR-03), and gift-card VAT point and expiry limits are unverified (VR-06, VR-09). Store credit is also the natural destination of refunds-as-credit, which the exchange-first returns design depends on.

## Decision drivers

- Avoid operating an unlicensed e-money product.
- Exchange-first returns and goodwill credit need a balance somewhere.
- Gift-card sales create liabilities and a VAT question; selling is a separate act from honouring a balance.
- Ledger already supports the accounts (packages/domain).

## Considered options

1. **Phase 1: credit balance exists only as non-purchasable, non-top-up credit (refund-as-credit, goodwill, referral); gift-card sales and redemption stay off behind kill switches until VR-03 is verified** (default).
2. Ship neither store credit nor gift cards until the opinion arrives; refunds go to the original method only.
3. Ship both fully in Phase 1.

## Decision (proposed default)

Option 1. Rules from ADR-0003 apply: no top-up, no withdrawal, no P2P, closed loop, UI says "store credit" not "cash". Customers are never forced to take credit; refund to original method is always offered where the law requires it. Credit is a ledger liability with an expiry value held as configuration (spec default 3 years for gift cards, unverified). Gift-card purchase and redemption are code-complete in Phase 2 behind a flag that stays off until VR-03 and VR-06 are verified or accepted in writing.

## Consequences

- Phase 1 checkout can show store credit as a tender for existing balances, which will be small.
- Gift-card revenue and the gifting use case wait.
- If the opinion is negative, the credit feature is reduced to refund-to-original only by turning a flag off, and balances must be handled per Legal.

## Owner decision required

Choose option 1, 2 or 3. If 3, accept the licensing risk in writing as an `Accepted risk` row in VR-03.

## Safe default if no answer

Option 1.
