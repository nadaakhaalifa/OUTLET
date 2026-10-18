# ADR-0038: Pre-loved resale (consumer-to-consumer)

- Status: **Proposed, blocked on VR-P3-05 (C2C regulatory and tax position)**
- Date: 2026-10-12
- Deciders: Legal, Tax, Product, Trust and Safety
- Spec refs: §28 row 8, §22 (returns-resale lane), §27, docs/specs/phase2/09-aramex-hub-resale.md

## Context and problem statement
Phase 2 shipped a returns-resale lane (professional seller relists a return). C2C resale lets shoppers sell used items. That changes the legal supplier (an individual), consumer-protection scope (arguably no CPL 181/2018 supplier duties but unverified), VAT, KYC for payouts, counterfeit exposure and platform joint-liability (§B5, flagged unverified).

## Considered options
1. **Do not build C2C; extend the existing lane** with "trade-in" where Z-OUTLET (a registered business) buys back items and resells them as supplier.
2. **Verified-purchase C2C with platform as intermediary:** seller is an individual with KYC, escrow-like holds through the ledger, authentication step through a hub.
3. **Open C2C listings** with no authentication.

## Decision (proposed default)
Option 1 for the first release (trade-in buyback, store credit offer, hub inspection, relist through the existing lane). The platform is then the supplier with known tax treatment, subject to VR-P3-05 confirming buyback is not itself a regulated activity. Option 2 is specified but not built until Legal and Tax verify; option 3 is rejected (counterfeit and liability). Hard rules for any option: only items from the user's own verified Z-OUTLET purchase history, hygiene categories excluded, no cash out outside the ledger and payout rail, 21+.

## Consequences
Good: no new legal supplier category; reuses inspection and lane. Bad: lower supply than open C2C; buyback ties up working capital.

## Owner decision required
Whether to pursue trade-in (needs pricing and working-capital budget) and whether Legal wants C2C at all.

## Safe default if no answer
No resale beyond the Phase 2 lane; `resale_c2c` and `trade_in` flags off.
